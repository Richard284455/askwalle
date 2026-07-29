import { Prisma, ContentSourceKind, SourceItemStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { safeFetch, Transport } from "@/lib/website/probe/http-client";
import { ResolveFn } from "@/lib/website/probe/ssrf";
import { parseFeed, htmlToText, FeedParseError, FeedItem } from "./feed-parser";
import { normalizeUrl, contentHash } from "./url-normalize";

/**
 * 采集层服务：把一个信息源抓成若干不可变的 SourceItem。
 *
 * 三条硬约束：
 *   1. 只写 content_sources / source_items —— **不写 ResourceContent**，
 *      不碰 Website、不碰 lifecycle。
 *   2. 取回一律走探针那套 SSRF 加固：解析一次 → 校验全部地址 → 连接固定到
 *      已校验 IP → 每跳重定向重新校验。抓外网文章和探测工具站是同一个威胁模型。
 *   3. 原始层不做判断：抓到什么存什么，解析失败也留证据，取舍交给上层。
 *
 * ── 职责边界（已冻结，改动前需重新决策）─────────────────────────────────
 *
 * content_ingest **只**负责：获取 RSS/Atom、解析条目、URL 规范化、
 * SourceItem 幂等落库、来源抓取状态与退避。
 *
 * **不负责文章原文抓取。** 原文抓取是独立阶段，job type 预定为
 * `content_article_enrich`，本阶段不实现。届时文章抓取失败**不得**影响
 * feed ingestion 的成功状态 —— 订阅抓到了就是成功，正文是另一件事。
 *
 * 全局默认 fetchArticles = false：不自动抓取每个 SourceItem 的文章页。
 * 下面的 fetchArticles 开关只供未来的 enrich 阶段与测试显式传入。
 *
 * 未来的正文策略（预定，本阶段不实现）：
 *   FEED_ONLY / ON_DEMAND / NEVER_FETCH；ALWAYS_FETCH 暂不启用，仅保留可能性。
 * 按源类型的默认策略：
 *   OFFICIAL_PRIMARY       → ON_DEMAND
 *   STRUCTURED_TECHNICAL   → FEED_ONLY
 *   AUTHORITATIVE_MEDIA    → ON_DEMAND 或 NEVER_FETCH
 *   COMMUNITY_SIGNAL       → FEED_ONLY 或 NEVER_FETCH
 * ON_DEMAND 仅在这些情况触发：feed 内容不足、条目通过重要性筛选、进入事件调查
 * 或编辑队列、编辑人工要求、需核实价格/日期/能力/技术参数、多来源事实冲突。
 *
 * 留存：**不长期保存第三方完整 HTML。** 未来 enrich 只保留 canonical URL、
 * fetched_at、content_hash、页面标题、解析状态、必要事实、短证据摘录、
 * 内容长度与元数据；完整正文只在处理过程中短暂使用，retention 另行设计。
 */

/** 订阅文件可以几百 KB，探针默认的 64KB 会把 XML 截断到解析不了 */
export const FEED_MAX_BYTES = 1_048_576;
/** 单篇正文快照上限：够做事实抽取，又不至于把库撑爆 */
export const ARTICLE_MAX_BYTES = 524_288;
export const RAW_CONTENT_MAX_CHARS = 60_000;
export const EXCERPT_MAX_CHARS = 2_000;

/** 失败退避：连续失败越多，下次越晚，上限 24 小时 */
export function backoffMinutes(baseMinutes: number, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return baseMinutes;
  const grown = baseMinutes * Math.pow(2, Math.min(consecutiveFailures, 6));
  return Math.min(grown, 24 * 60);
}

export type IngestOptions = {
  /** 测试注入：内存 fixture，不建真实连接 */
  transport?: Transport;
  resolve?: ResolveFn;
  /** 每个源单轮最多落库的条目数，防止首次订阅一次灌进几千条 */
  maxItems?: number;
  /** 是否抓取每条条目的正文（第一阶段默认只用订阅自带内容） */
  fetchArticles?: boolean;
  now?: Date;
};

export type IngestResult = {
  sourceId: number;
  ok: boolean;
  /** ok / http_error / parse_error / unsafe_target / dns / timeout / empty_feed ... */
  status: string;
  error: string | null;
  itemsSeen: number;
  itemsCreated: number;
  itemsDuplicate: number;
  itemsSkipped: number;
  httpStatus: number | null;
  finalUrl: string | null;
};

type FetchEvidence = {
  httpStatus: number | null;
  finalUrl: string | null;
  evidence: Prisma.InputJsonValue | null;
  body: string | null;
  /** 失败时的分类，成功为 null */
  failure: { status: string; message: string } | null;
};

/** 统一的安全取回：把 safeFetch 的四种结果翻译成采集层的证据结构 */
async function fetchSafely(
  url: string,
  maxBytes: number,
  options: IngestOptions
): Promise<FetchEvidence> {
  const res = await safeFetch(url, {
    method: "GET",
    maxBytes,
    ...(options.resolve ? { resolve: options.resolve } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
  });

  if (res.kind === "unsafe") {
    return {
      httpStatus: null, finalUrl: null, body: null,
      evidence: { unsafeReason: res.verdict.reason, atHop: res.atHop } as Prisma.InputJsonValue,
      failure: { status: "unsafe_target", message: `${res.verdict.reason}: ${res.verdict.detail}` },
    };
  }
  if (res.kind === "redirect_loop") {
    return {
      httpStatus: null, finalUrl: null, body: null,
      evidence: { redirectChain: res.redirectChain } as unknown as Prisma.InputJsonValue,
      failure: { status: "redirect_loop", message: "重定向成环或超过跳数上限" },
    };
  }
  if (res.kind === "network_error") {
    return {
      httpStatus: null, finalUrl: null, body: null,
      evidence: { networkError: `${res.code}: ${res.message}` } as Prisma.InputJsonValue,
      failure: { status: res.errorKind, message: `${res.code}: ${res.message}` },
    };
  }

  const evidence = {
    pinnedIp: res.pinnedIp,
    resolvedIps: res.resolvedIps,
    redirectChain: res.redirectChain,
    bytesRead: res.bytesRead,
    truncated: res.truncated,
    latencyMs: res.latencyMs,
    contentType: res.headers["content-type"] ?? null,
  } as unknown as Prisma.InputJsonValue;

  if (res.status >= 400) {
    return {
      httpStatus: res.status, finalUrl: res.finalUrl, body: null, evidence,
      failure: { status: "http_error", message: `HTTP ${res.status}` },
    };
  }
  if (res.body === null) {
    return {
      httpStatus: res.status, finalUrl: res.finalUrl, body: null, evidence,
      failure: { status: "undecodable", message: "正文无法解码" },
    };
  }
  return { httpStatus: res.status, finalUrl: res.finalUrl, body: res.body, evidence, failure: null };
}

/**
 * 抓一个 RSS 源并落库。
 *
 * 幂等：同源同 URL 只落一次（唯一约束 (source_id, url_hash) 兜底），
 * 重复抓取只会把条目记成 duplicate 而不会写第二条。
 */
export async function ingestSource(
  sourceId: number,
  options: IngestOptions = {}
): Promise<IngestResult> {
  const now = options.now ?? new Date();
  const source = await prisma.contentSource.findUniqueOrThrow({ where: { id: sourceId } });

  const base: IngestResult = {
    sourceId, ok: false, status: "ok", error: null,
    itemsSeen: 0, itemsCreated: 0, itemsDuplicate: 0, itemsSkipped: 0,
    httpStatus: null, finalUrl: null,
  };

  if (source.kind !== ContentSourceKind.rss || !source.feed_url) {
    // manual 源没有订阅地址，条目由编辑单条提交，不在这里抓
    return finish({ ...base, ok: true, status: "not_a_feed" }, source, now);
  }

  const fetched = await fetchSafely(source.feed_url, FEED_MAX_BYTES, options);
  base.httpStatus = fetched.httpStatus;
  base.finalUrl = fetched.finalUrl;

  if (fetched.failure) {
    return finish(
      { ...base, ok: false, status: fetched.failure.status, error: fetched.failure.message },
      source, now);
  }

  let items: FeedItem[];
  try {
    items = parseFeed(fetched.body!).items;
  } catch (e) {
    return finish(
      {
        ...base, ok: false, status: "parse_error",
        error: e instanceof FeedParseError ? e.message : `解析失败: ${String(e).slice(0, 200)}`,
      },
      source, now);
  }

  base.itemsSeen = items.length;
  if (!items.length) {
    return finish({ ...base, ok: true, status: "empty_feed" }, source, now);
  }

  const limit = options.maxItems ?? 50;
  for (const item of items.slice(0, limit)) {
    const outcome = await persistItem(source.id, source.feed_url, source.lang, item, options);
    if (outcome === "created") base.itemsCreated++;
    else if (outcome === "duplicate") base.itemsDuplicate++;
    else base.itemsSkipped++;
  }

  return finish({ ...base, ok: true, status: "ok" }, source, now);
}

/** 落一条 SourceItem。返回值只描述发生了什么，不抛异常打断整轮。 */
async function persistItem(
  sourceId: number,
  feedUrl: string,
  sourceLang: string,
  item: FeedItem,
  options: IngestOptions
): Promise<"created" | "duplicate" | "skipped"> {
  // link 缺失时退回 guid —— 有些源只在 guid 里放地址
  const rawLink = item.link ?? item.guid;
  if (!rawLink) return "skipped";
  const normalized = normalizeUrl(rawLink, feedUrl);
  if (!normalized) return "skipped";

  const existing = await prisma.sourceItem.findUnique({
    where: { source_id_url_hash: { source_id: sourceId, url_hash: normalized.hash } },
    select: { id: true },
  });
  if (existing) return "duplicate";

  // 订阅自带的正文/摘要
  const excerptText = item.excerpt ? htmlToText(item.excerpt) : null;
  let contentText = item.content ? htmlToText(item.content) : null;
  let httpStatus: number | null = null;
  let finalUrl: string | null = null;
  let evidence: Prisma.InputJsonValue | null = null;
  let status: SourceItemStatus = contentText ? SourceItemStatus.fetched : SourceItemStatus.link_only;

  // 需要正文时才去抓原文（第一阶段默认关闭：订阅里通常已够用，且能少打扰源站）
  if (options.fetchArticles) {
    const art = await fetchSafely(normalized.url, ARTICLE_MAX_BYTES, options);
    httpStatus = art.httpStatus;
    finalUrl = art.finalUrl;
    evidence = art.evidence;
    if (art.failure) {
      status = contentText ? SourceItemStatus.fetched : SourceItemStatus.parse_failed;
    } else if (art.body) {
      contentText = htmlToText(art.body);
      status = SourceItemStatus.fetched;
    }
  }

  const trimmedContent = contentText ? contentText.slice(0, RAW_CONTENT_MAX_CHARS) : null;

  try {
    await prisma.sourceItem.create({
      data: {
        source_id: sourceId,
        url: normalized.url,
        canonical_url: item.guid ?? null,
        url_hash: normalized.hash,
        content_hash: trimmedContent ? contentHash(trimmedContent) : null,
        title: item.title.slice(0, 500),
        author: item.author?.slice(0, 200) ?? null,
        published_at: item.publishedAt,
        raw_excerpt: excerptText ? excerptText.slice(0, EXCERPT_MAX_CHARS) : null,
        raw_content: trimmedContent,
        lang: sourceLang,
        http_status: httpStatus,
        final_url: finalUrl,
        evidence: evidence ?? Prisma.DbNull,
        status,
      },
    });
    return "created";
  } catch (e) {
    // 并发抓同一个源时唯一约束会拦下第二次写入 —— 那正是它该做的
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return "duplicate";
    throw e;
  }
}

/** 写回源的抓取状态与下次排期 */
async function finish(
  result: IngestResult,
  source: { id: number; fetch_interval_minutes: number; consecutive_failures: number; item_count: number },
  now: Date
): Promise<IngestResult> {
  const failures = result.ok ? 0 : source.consecutive_failures + 1;
  const delayMin = backoffMinutes(source.fetch_interval_minutes, failures);

  await prisma.contentSource.update({
    where: { id: source.id },
    data: {
      last_fetched_at: now,
      next_fetch_at: new Date(now.getTime() + delayMin * 60_000),
      last_status: result.status,
      last_error: result.error,
      consecutive_failures: failures,
      item_count: source.item_count + result.itemsCreated,
    },
  });
  return result;
}

/** 到期待抓的源；无 next_fetch_at 的（新建）视为立即到期 */
export async function selectDueSources(limit: number): Promise<number[]> {
  const due = await prisma.contentSource.findMany({
    where: {
      enabled: true,
      kind: ContentSourceKind.rss,
      OR: [{ next_fetch_at: null }, { next_fetch_at: { lte: new Date() } }],
    },
    orderBy: [{ next_fetch_at: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true },
  });
  return due.map((d) => d.id);
}

/**
 * 编辑人工提交单条 URL。
 * 走同一套 SSRF 校验与规范化，落进指定的 manual 源。
 */
export async function submitManualUrl(
  sourceId: number,
  rawUrl: string,
  options: IngestOptions = {}
): Promise<{ ok: true; itemId: number; duplicate: boolean } | { ok: false; message: string }> {
  const source = await prisma.contentSource.findUnique({ where: { id: sourceId } });
  if (!source) return { ok: false, message: `信息源 #${sourceId} 不存在` };
  if (source.kind !== ContentSourceKind.manual) {
    return { ok: false, message: "只能提交到 manual 类型的信息源" };
  }

  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return { ok: false, message: "URL 无法解析，或协议不是 http/https" };

  const existing = await prisma.sourceItem.findUnique({
    where: { source_id_url_hash: { source_id: sourceId, url_hash: normalized.hash } },
    select: { id: true },
  });
  if (existing) return { ok: true, itemId: existing.id, duplicate: true };

  const art = await fetchSafely(normalized.url, ARTICLE_MAX_BYTES, options);
  if (art.failure && !art.body) {
    // 抓不到也留档：编辑提交的意图本身就是溯源信息
    const item = await prisma.sourceItem.create({
      data: {
        source_id: sourceId,
        url: normalized.url,
        url_hash: normalized.hash,
        title: normalized.url.slice(0, 500),
        http_status: art.httpStatus,
        final_url: art.finalUrl,
        evidence: art.evidence ?? Prisma.DbNull,
        status: SourceItemStatus.parse_failed,
        lang: source.lang,
      },
      select: { id: true },
    });
    return { ok: true, itemId: item.id, duplicate: false };
  }

  const text = art.body ? htmlToText(art.body) : null;
  const title =
    (art.body ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(art.body)?.[1]?.trim() : null) ??
    normalized.url;
  const trimmed = text ? text.slice(0, RAW_CONTENT_MAX_CHARS) : null;

  const item = await prisma.sourceItem.create({
    data: {
      source_id: sourceId,
      url: normalized.url,
      url_hash: normalized.hash,
      title: title.slice(0, 500),
      raw_content: trimmed,
      content_hash: trimmed ? contentHash(trimmed) : null,
      http_status: art.httpStatus,
      final_url: art.finalUrl,
      evidence: art.evidence ?? Prisma.DbNull,
      status: trimmed ? SourceItemStatus.fetched : SourceItemStatus.link_only,
      lang: source.lang,
    },
    select: { id: true },
  });

  await prisma.contentSource.update({
    where: { id: sourceId },
    data: { item_count: source.item_count + 1, last_fetched_at: new Date(), last_status: "ok" },
  });
  return { ok: true, itemId: item.id, duplicate: false };
}
