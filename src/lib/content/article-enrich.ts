import crypto from "crypto";

import {
  ArticleFetchPolicy,
  ContentSourceTier,
  EnrichmentOutcome,
  Prisma,
  SourceRunErrorDomain,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  extractArticle,
  gradeContent,
  EXCERPT_MAX_CHARS,
  MAX_HEADINGS,
  MIN_VISIBLE_TEXT_CHARS,
  type ContentQuality,
  type ExtractionMethod,
  type FieldSource,
} from "@/lib/content/html-extract";
import { redirectCountOf } from "@/lib/content/ingest";
import { safeFetch, type Transport } from "@/lib/website/probe/http-client";
import { checkRobots } from "@/lib/website/probe/robots";
import type { ResolveFn } from "@/lib/website/probe/ssrf";

/**
 * 按需文章增强（content_article_enrich）。
 *
 * 职责边界，写死在这里省得后来的人猜：
 *   - 只对 article_fetch_policy ∈ {ON_DEMAND, ALWAYS_FETCH} 的源抓文章页；
 *   - 只抓 SourceItem 已经记下来的那个地址，不发现新链接、不翻页、不抓站内其它页；
 *   - 只提取有限元数据 + 摘要，**不保存完整 HTML / 完整正文**；
 *   - 不调用 AI、不抽事实、不聚类、不写 ResourceContent；
 *   - 不修改 SourceItem 的原始订阅快照 —— 那是不可变的溯源记录。
 *
 * 抓第三方页面是权限问题而不只是技术问题：robots 说不就不抓，403/451/429 记
 * BLOCKED 而不是「失败重试」，取不到正文就如实记 CONTENT_INSUFFICIENT。
 * 不做浏览器渲染、不执行 JS、不登录、不绕付费墙、不绕 CAPTCHA、不绕反爬。
 */

/** 下载硬上限。注意解压后还受 transport 的 1MB 压缩炸弹上限约束（更严） */
export const ARTICLE_MAX_BYTES = 524_288;
/** 同域最小请求间隔 */
export const SAME_HOST_DELAY_MS = 2_000;
/** 基础设施故障的短重试间隔 —— 不是源的错，不该走指数退避 */
export const INFRA_RETRY_MINUTES = 10;

const ALLOWED_POLICIES: ArticleFetchPolicy[] = [ArticleFetchPolicy.ON_DEMAND, ArticleFetchPolicy.ALWAYS_FETCH];
const HTML_TYPES = ["text/html", "application/xhtml+xml", "application/xhtml"];

export type EnrichOptions = {
  jobId?: number;
  jobItemId?: number;
  now?: Date;
  resolve?: ResolveFn;
  transport?: Transport;
  /** 测试用：跳过同域节流的真实等待 */
  skipPoliteDelay?: boolean;
};

export type EnrichResult = {
  ok: boolean;
  sourceItemId: number;
  runId: number | null;
  outcome: EnrichmentOutcome | null;
  errorDomain: SourceRunErrorDomain;
  /** true = 源侧问题（含被拒/正文不足）；false = 我们这边的故障 */
  sourceAtFault: boolean;
  visibleTextLength: number | null;
  error: string | null;
};

// ---------------------------------------------------------------------------
// 同域节流：全局并发 1，同域至少间隔 2 秒
// ---------------------------------------------------------------------------

const HOST_CLOCK = Symbol.for("askwalle.articleEnrichHostClock");
type ClockGlobal = typeof globalThis & { [HOST_CLOCK]?: Map<string, number> };

function hostClock(): Map<string, number> {
  const scope = globalThis as ClockGlobal;
  if (!scope[HOST_CLOCK]) scope[HOST_CLOCK] = new Map();
  return scope[HOST_CLOCK]!;
}

/** 对同一主机连续请求时补足间隔。礼貌不是可选项，是继续被允许抓的前提。 */
export async function politeDelay(host: string, skip = false): Promise<number> {
  const clock = hostClock();
  const last = clock.get(host) ?? 0;
  const wait = Math.max(0, last + SAME_HOST_DELAY_MS - Date.now());
  if (wait > 0 && !skip) await new Promise((r) => setTimeout(r, wait));
  clock.set(host, Date.now());
  return wait;
}

// ---------------------------------------------------------------------------
// 归因
// ---------------------------------------------------------------------------

/** 源侧域：计入源站责任。DATABASE / LEASE / INTERNAL 属基础设施，绝不归因于源。 */
export const SOURCE_SIDE_DOMAINS: SourceRunErrorDomain[] = [
  SourceRunErrorDomain.DNS,
  SourceRunErrorDomain.NETWORK,
  SourceRunErrorDomain.TLS,
  SourceRunErrorDomain.HTTP,
  SourceRunErrorDomain.ROBOTS,
  SourceRunErrorDomain.PARSE,
];

/** 把异常识别成基础设施域；识别不出返回 null（那就不是我们这边的已知故障） */
export function infraDomainOf(error: unknown): SourceRunErrorDomain | null {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (/lease_lost|lease_renew_failed/i.test(message)) return SourceRunErrorDomain.LEASE;
  if (
    /Can't reach database server|connection pool|PrismaClientInitializationError|PrismaClientKnownRequestError|ECONNREFUSED.*5432|Timed out fetching a new connection/i.test(
      message
    )
  ) {
    return SourceRunErrorDomain.DATABASE;
  }
  return null;
}

export function isSourceSide(domain: SourceRunErrorDomain): boolean {
  return SOURCE_SIDE_DOMAINS.includes(domain);
}

function networkDomain(kind: string): SourceRunErrorDomain {
  if (kind === "dns") return SourceRunErrorDomain.DNS;
  if (kind === "tls") return SourceRunErrorDomain.TLS;
  return SourceRunErrorDomain.NETWORK;
}

/** 取主机名；不可解析返回 null。只用于记录身份信号，不参与任何安全判断 */
export function safeHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function contentHashOf(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function isHtmlType(contentType: string | null): boolean {
  if (!contentType) return true; // 没声明就按 HTML 试，解析不出来再判 CONTENT_INSUFFICIENT
  const base = contentType.split(";")[0].trim().toLowerCase();
  return HTML_TYPES.includes(base);
}

/** Retry-After：秒数或 HTTP 日期 */
export function parseRetryAfter(value: string | null | undefined, now: Date): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed), 86_400) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.min(at - now.getTime(), 86_400_000));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

type RunDraft = {
  outcome: EnrichmentOutcome;
  errorDomain: SourceRunErrorDomain;
  errorCode: string | null;
  errorMessage: string | null;
  httpStatus: number | null;
  finalUrl: string | null;
  canonicalUrl: string | null;
  contentType: string | null;
  bytesRead: number | null;
  truncated: boolean;
  latencyFetchMs: number | null;
  pinnedIp: string | null;
  redirectCount: number | null;
  robotsDecision: string | null;
  etagReceived: string | null;
  lastModifiedReceived: string | null;
  pageTitle: string | null;
  author: string | null;
  pagePublishedAt: Date | null;
  language: string | null;
  visibleTextLength: number | null;
  contentHash: string | null;
  excerpt: string | null;
  headings: Prisma.InputJsonValue | null;
  metadata: Prisma.InputJsonValue | null;
  evidence: Prisma.InputJsonValue | null;
  dnsLatencyMs: number | null;
  contentQuality: ContentQuality | null;
  extractionMethod: ExtractionMethod | null;
  titleSource: FieldSource | null;
  authorSource: FieldSource | null;
  publishedAtSource: FieldSource | null;
};

function emptyDraft(): RunDraft {
  return {
    outcome: EnrichmentOutcome.INFRA_ERROR,
    errorDomain: SourceRunErrorDomain.INTERNAL,
    errorCode: null, errorMessage: null, httpStatus: null, finalUrl: null,
    canonicalUrl: null, contentType: null, bytesRead: null, truncated: false,
    latencyFetchMs: null, pinnedIp: null, redirectCount: null, robotsDecision: null,
    etagReceived: null, lastModifiedReceived: null, pageTitle: null, author: null,
    pagePublishedAt: null, language: null, visibleTextLength: null, contentHash: null,
    excerpt: null, headings: null, metadata: null, evidence: null,
    dnsLatencyMs: null, contentQuality: null, extractionMethod: null,
    titleSource: null, authorSource: null, publishedAtSource: null,
  };
}

export async function enrichSourceItem(
  sourceItemId: number,
  options: EnrichOptions = {}
): Promise<EnrichResult> {
  const now = options.now ?? new Date();
  const startedAt = new Date();
  const t0 = Date.now();

  // 读条目本身就可能因数据库中断失败 —— 那是基础设施问题，绝不能记成源的错，
  // 也不该留下一条谎称「抓过」的 run（页面根本没被请求）。
  let item: {
    id: number; url: string; source_id: number;
    author: string | null; published_at: Date | null; title: string;
    source: {
      id: number; article_fetch_policy: ArticleFetchPolicy; external_key: string | null;
      publisher: string; source_tier: ContentSourceTier | null;
    };
  };
  try {
    item = await prisma.sourceItem.findUniqueOrThrow({
      where: { id: sourceItemId },
      select: {
        id: true, url: true, source_id: true, author: true, published_at: true, title: true,
        source: {
          select: {
            id: true, article_fetch_policy: true, external_key: true,
            publisher: true, source_tier: true,
          },
        },
      },
    });
  } catch (e) {
    return {
      ok: false, sourceItemId, runId: null, outcome: null,
      errorDomain: infraDomainOf(e) ?? SourceRunErrorDomain.DATABASE,
      sourceAtFault: false, visibleTextLength: null,
      error: `读取条目失败: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }

  // 策略闸门：默认 FEED_ONLY 不抓。这是纵深防御 —— 建任务时已经筛过一遍。
  if (!ALLOWED_POLICIES.includes(item.source.article_fetch_policy)) {
    return {
      ok: false, sourceItemId, runId: null, outcome: null,
      errorDomain: SourceRunErrorDomain.NONE, sourceAtFault: true, visibleTextLength: null,
      error: `源 #${item.source_id} 的策略为 ${item.source.article_fetch_policy}，不抓文章页`,
    };
  }

  const draft = emptyDraft();
  const requestedUrl = item.url;

  try {
    let host = "";
    try {
      host = new URL(requestedUrl).host;
    } catch {
      draft.outcome = EnrichmentOutcome.SOURCE_ERROR;
      draft.errorDomain = SourceRunErrorDomain.PARSE;
      draft.errorCode = "invalid_url";
      draft.errorMessage = "条目地址不是合法 URL";
      return await finish(item, draft, requestedUrl, startedAt, t0, options);
    }

    // ── robots 预检 ──────────────────────────────────────────────────────
    const robots = await checkRobots(requestedUrl, options.resolve, options.transport);
    draft.robotsDecision = robots.decision;
    if (robots.decision === "disallow") {
      draft.outcome = EnrichmentOutcome.BLOCKED;
      draft.errorDomain = SourceRunErrorDomain.ROBOTS;
      draft.errorCode = "robots_disallow";
      draft.errorMessage = `robots.txt 拒绝：${robots.rule}`;
      return await finish(item, draft, requestedUrl, startedAt, t0, options);
    }
    if (robots.decision === "deferred") {
      // 取不回 robots 不当作允许，也不当作源故障
      draft.outcome = EnrichmentOutcome.BLOCKED;
      draft.errorDomain = SourceRunErrorDomain.ROBOTS;
      draft.errorCode = "robots_deferred";
      draft.errorMessage = `robots 未取到，本轮不抓：${robots.reason}`;
      return await finish(item, draft, requestedUrl, startedAt, t0, options);
    }

    await politeDelay(host, options.skipPoliteDelay);

    // ── 条件请求：带上这条目最近一次成功 run 的验证器 ─────────────────────
    const previous = await prisma.sourceItemEnrichmentRun.findFirst({
      where: { source_item_id: sourceItemId, outcome: { in: [EnrichmentOutcome.OK, EnrichmentOutcome.NOT_MODIFIED] } },
      orderBy: { started_at: "desc" },
      select: { etag_received: true, last_modified_received: true },
    });
    const etagSent = previous?.etag_received ?? null;
    const lastModifiedSent = previous?.last_modified_received ?? null;

    const res = await safeFetch(requestedUrl, {
      method: "GET",
      maxBytes: ARTICLE_MAX_BYTES,
      ...(etagSent || lastModifiedSent
        ? {
            conditional: {
              ...(etagSent ? { etag: etagSent } : {}),
              ...(lastModifiedSent ? { lastModified: lastModifiedSent } : {}),
            },
          }
        : {}),
      ...(options.resolve ? { resolve: options.resolve } : {}),
      ...(options.transport ? { transport: options.transport } : {}),
    });

    if (res.kind === "unsafe") {
      draft.outcome = EnrichmentOutcome.BLOCKED;
      draft.errorDomain = SourceRunErrorDomain.NETWORK;
      draft.errorCode = "unsafe_target";
      draft.errorMessage = `${res.verdict.reason}（第 ${res.atHop} 跳）`;
      draft.redirectCount = redirectCountOf(res.redirectChain);
      draft.dnsLatencyMs = res.dnsLatencyMs;
      draft.evidence = { unsafeReason: res.verdict.reason, atHop: res.atHop } as Prisma.InputJsonValue;
      return await finish(item, draft, requestedUrl, startedAt, t0, options, etagSent, lastModifiedSent);
    }
    if (res.kind === "redirect_loop") {
      draft.outcome = EnrichmentOutcome.SOURCE_ERROR;
      draft.errorDomain = SourceRunErrorDomain.HTTP;
      draft.errorCode = "redirect_loop";
      draft.errorMessage = "重定向成环或超过跳数上限";
      draft.redirectCount = redirectCountOf(res.redirectChain);
      draft.dnsLatencyMs = res.dnsLatencyMs;
      return await finish(item, draft, requestedUrl, startedAt, t0, options, etagSent, lastModifiedSent);
    }
    if (res.kind === "network_error") {
      draft.outcome = EnrichmentOutcome.SOURCE_ERROR;
      draft.errorDomain = networkDomain(res.errorKind);
      draft.errorCode = res.code;
      draft.errorMessage = `${res.code}: ${res.message}`.slice(0, 300);
      draft.latencyFetchMs = res.latencyMs;
      draft.redirectCount = redirectCountOf(res.redirectChain);
      draft.dnsLatencyMs = res.dnsLatencyMs;
      return await finish(item, draft, requestedUrl, startedAt, t0, options, etagSent, lastModifiedSent);
    }

    // ── 有响应 ───────────────────────────────────────────────────────────
    draft.httpStatus = res.status;
    draft.finalUrl = res.finalUrl;
    draft.bytesRead = res.bytesRead;
    draft.latencyFetchMs = res.latencyMs;
    draft.pinnedIp = res.pinnedIp;
    // ★ 真实跳转次数：请求链含首次请求，减一才是 Location 跳转数
    draft.redirectCount = redirectCountOf(res.redirectChain);
    draft.dnsLatencyMs = res.dnsLatencyMs;
    draft.contentType = res.headers["content-type"] ?? null;
    draft.etagReceived = res.headers["etag"] ?? null;
    draft.lastModifiedReceived = res.headers["last-modified"] ?? null;
    // transport 只在超过 4×maxBytes 时置 truncated；服务端认 Range 时会**恰好**
    // 返回上限字节而不报截断 —— 那同样是不完整的正文，必须如实记。
    draft.truncated = res.truncated || !res.integrity.responseComplete;
    draft.evidence = {
      pinnedIp: res.pinnedIp,
      resolvedIps: res.resolvedIps,
      // 完整请求链原样保留（含首次请求），派生的 redirect_count 另算
      redirectChain: res.redirectChain,
      bytesRead: res.bytesRead,
      truncated: draft.truncated,
      latencyMs: res.latencyMs,
      dnsLatencyMs: res.dnsLatencyMs,
      contentType: draft.contentType,
      robotsDecision: draft.robotsDecision,
      integrity: res.integrity,
    } as unknown as Prisma.InputJsonValue;

    if (res.status === 304) {
      draft.outcome = EnrichmentOutcome.NOT_MODIFIED;
      draft.errorDomain = SourceRunErrorDomain.NONE;
      return await finish(item, draft, requestedUrl, startedAt, t0, options, etagSent, lastModifiedSent);
    }

    if (res.status === 429 || res.status === 403 || res.status === 451) {
      const retryAfterMs = parseRetryAfter(res.headers["retry-after"], now);
      draft.outcome = EnrichmentOutcome.BLOCKED;
      draft.errorDomain = SourceRunErrorDomain.HTTP;
      draft.errorCode = `http_${res.status}`;
      draft.errorMessage =
        res.status === 429
          ? `源站限流 429${retryAfterMs !== null ? `，Retry-After ${Math.round(retryAfterMs / 1000)}s` : ""}`
          : `源站拒绝访问 HTTP ${res.status}`;
      return await finish(item, draft, requestedUrl, startedAt, t0, options, etagSent, lastModifiedSent);
    }
    if (res.status === 503 && parseRetryAfter(res.headers["retry-after"], now) !== null) {
      // 带 Retry-After 的 503 是「稍后再来」，不是源坏了
      draft.outcome = EnrichmentOutcome.BLOCKED;
      draft.errorDomain = SourceRunErrorDomain.HTTP;
      draft.errorCode = "http_503_retry_after";
      draft.errorMessage = "源站暂时不可用并给出 Retry-After";
      return await finish(item, draft, requestedUrl, startedAt, t0, options, etagSent, lastModifiedSent);
    }
    if (res.status >= 400) {
      draft.outcome = EnrichmentOutcome.SOURCE_ERROR;
      draft.errorDomain = SourceRunErrorDomain.HTTP;
      draft.errorCode = `http_${res.status}`;
      draft.errorMessage = `HTTP ${res.status}`;
      return await finish(item, draft, requestedUrl, startedAt, t0, options, etagSent, lastModifiedSent);
    }

    if (!isHtmlType(draft.contentType)) {
      draft.outcome = EnrichmentOutcome.UNSUPPORTED;
      draft.errorDomain = SourceRunErrorDomain.NONE;
      draft.errorCode = "unsupported_content_type";
      draft.errorMessage = `暂不支持的类型：${draft.contentType}`;
      draft.contentQuality = "UNSUPPORTED";
      draft.extractionMethod = "NONE";
      return await finish(item, draft, requestedUrl, startedAt, t0, options, etagSent, lastModifiedSent);
    }
    if (res.body === null) {
      draft.outcome = EnrichmentOutcome.SOURCE_ERROR;
      draft.errorDomain = SourceRunErrorDomain.PARSE;
      draft.errorCode = "undecodable";
      draft.errorMessage = "正文无法解码";
      return await finish(item, draft, requestedUrl, startedAt, t0, options, etagSent, lastModifiedSent);
    }

    // ── 提取（完整正文只在内存里存在到这个块结束）─────────────────────────
    let extracted: ReturnType<typeof extractArticle>;
    try {
      extracted = extractArticle(res.body, res.finalUrl);
    } catch (e) {
      draft.outcome = EnrichmentOutcome.SOURCE_ERROR;
      draft.errorDomain = SourceRunErrorDomain.PARSE;
      draft.errorCode = "extract_failed";
      draft.errorMessage = `HTML 解析失败: ${e instanceof Error ? e.message : "unknown"}`.slice(0, 300);
      return await finish(item, draft, requestedUrl, startedAt, t0, options, etagSent, lastModifiedSent);
    }

    draft.canonicalUrl = extracted.canonicalUrl;
    draft.pageTitle = extracted.title;
    draft.language = extracted.language;
    draft.visibleTextLength = extracted.visibleTextLength;
    draft.contentHash = extracted.visibleTextLength > 0 ? contentHashOf(extracted.visibleText) : null;
    draft.excerpt = extracted.excerpt.slice(0, EXCERPT_MAX_CHARS) || null;
    draft.headings = extracted.headings.slice(0, MAX_HEADINGS) as unknown as Prisma.InputJsonValue;

    // ── 字段回落：页面没有就用订阅的，但**必须标明来源** ──────────────────
    // 把订阅日期伪装成页面声明日期，等于凭空制造一条页面从未做出的断言。
    draft.author = extracted.author ?? item.author ?? null;
    draft.authorSource =
      extracted.author ? extracted.authorSource : item.author ? "FEED" : "NONE";
    draft.pagePublishedAt = extracted.publishedAt ?? item.published_at ?? null;
    draft.publishedAtSource =
      extracted.publishedAt ? extracted.publishedAtSource : item.published_at ? "FEED" : "NONE";
    draft.titleSource = extracted.title ? extracted.titleSource : item.title ? "FEED" : "NONE";
    if (!extracted.title && item.title) draft.pageTitle = item.title;
    draft.extractionMethod = extracted.extractionMethod;
    // 截断优先于长度分级：半篇文章的字数再多也不是完整正文
    draft.contentQuality = draft.truncated ? "TRUNCATED" : gradeContent(extracted.visibleTextLength);

    // ── 发布者身份：来源身份只认 ContentSource，final host 只是取回证据 ──
    const requestedHost = safeHost(requestedUrl);
    const finalHost = safeHost(res.finalUrl);
    const canonicalHost = safeHost(extracted.canonicalUrl);
    draft.metadata = {
      ...extracted.metadata,
      contentQuality: draft.contentQuality,
      extractionMethod: draft.extractionMethod,
      titleSource: draft.titleSource,
      authorSource: draft.authorSource,
      publishedAtSource: draft.publishedAtSource,
      visibleTextLength: String(extracted.visibleTextLength),
      // 身份信号只记录，不据此改写来源
      requestedHost: requestedHost ?? "",
      finalHost: finalHost ?? "",
      canonicalHost: canonicalHost ?? "",
      crossDomainRedirect: String(Boolean(requestedHost && finalHost && requestedHost !== finalHost)),
      canonicalHostDiffers: String(Boolean(canonicalHost && finalHost && canonicalHost !== finalHost)),
      sourcePublisher: item.source.publisher,
      sourceTier: item.source.source_tier ?? "",
    } as unknown as Prisma.InputJsonValue;

    if (extracted.visibleTextLength < MIN_VISIBLE_TEXT_CHARS) {
      draft.outcome = EnrichmentOutcome.CONTENT_INSUFFICIENT;
      draft.errorDomain = SourceRunErrorDomain.NONE;
      draft.errorCode = "content_insufficient";
      draft.errorMessage = `可见正文仅 ${extracted.visibleTextLength} 字符，低于 ${MIN_VISIBLE_TEXT_CHARS} 下限`;
    } else {
      draft.outcome = EnrichmentOutcome.OK;
      draft.errorDomain = SourceRunErrorDomain.NONE;
    }
    return await finish(item, draft, requestedUrl, startedAt, t0, options, etagSent, lastModifiedSent);
  } catch (e) {
    const infra = infraDomainOf(e);
    draft.outcome = EnrichmentOutcome.INFRA_ERROR;
    draft.errorDomain = infra ?? SourceRunErrorDomain.INTERNAL;
    draft.errorCode = infra ? infra.toLowerCase() : "internal_error";
    draft.errorMessage = `${e instanceof Error ? e.message : "unknown"}`.slice(0, 300);
    try {
      return await finish(item, draft, requestedUrl, startedAt, t0, options);
    } catch {
      // 连 run 都写不进去（库还在故障）：如实上报，不假装抓过
      return {
        ok: false, sourceItemId, runId: null, outcome: draft.outcome,
        errorDomain: draft.errorDomain, sourceAtFault: false,
        visibleTextLength: null, error: draft.errorMessage,
      };
    }
  }
}

/**
 * 落库收尾。
 *
 * 只写 SourceItemEnrichmentRun —— **不动 SourceItem 的任何字段**。
 * 原始订阅快照是不可变的溯源记录；增强结果是对它的旁注，不是对它的改写。
 */
async function finish(
  item: { id: number; source_id: number },
  draft: RunDraft,
  requestedUrl: string,
  startedAt: Date,
  t0: number,
  options: EnrichOptions,
  etagSent: string | null = null,
  lastModifiedSent: string | null = null
): Promise<EnrichResult> {
  const finishedAt = new Date();
  const data = {
    source_item_id: item.id,
    job_id: options.jobId ?? null,
    job_item_id: options.jobItemId ?? null,
    started_at: startedAt,
    finished_at: finishedAt,
    outcome: draft.outcome,
    error_domain: draft.errorDomain,
    requested_url: requestedUrl,
    final_url: draft.finalUrl,
    canonical_url: draft.canonicalUrl,
    http_status: draft.httpStatus,
    content_type: draft.contentType,
    bytes_read: draft.bytesRead,
    truncated: draft.truncated,
    latency_dns_ms: draft.dnsLatencyMs,
    latency_fetch_ms: draft.latencyFetchMs,
    latency_total_ms: Date.now() - t0,
    pinned_ip: draft.pinnedIp,
    redirect_count: draft.redirectCount,
    robots_decision: draft.robotsDecision,
    etag_sent: etagSent,
    etag_received: draft.etagReceived,
    last_modified_sent: lastModifiedSent,
    last_modified_received: draft.lastModifiedReceived,
    page_title: draft.pageTitle,
    author: draft.author,
    page_published_at: draft.pagePublishedAt,
    language: draft.language,
    visible_text_length: draft.visibleTextLength,
    content_hash: draft.contentHash,
    excerpt: draft.excerpt,
    headings_json: draft.headings ?? Prisma.DbNull,
    metadata_json: draft.metadata ?? Prisma.DbNull,
    error_code: draft.errorCode,
    error_message: draft.errorMessage,
    evidence_json: draft.evidence ?? Prisma.DbNull,
  };

  // 同 job 同条目只留一条：worker 回收或重复驱动时覆盖而不是堆第二条
  const run =
    options.jobId != null
      ? await prisma.sourceItemEnrichmentRun.upsert({
          where: { job_id_source_item_id: { job_id: options.jobId, source_item_id: item.id } },
          create: data,
          update: data,
        })
      : await prisma.sourceItemEnrichmentRun.create({ data });

  const ok = draft.outcome === EnrichmentOutcome.OK || draft.outcome === EnrichmentOutcome.NOT_MODIFIED;
  return {
    ok,
    sourceItemId: item.id,
    runId: run.id,
    outcome: draft.outcome,
    errorDomain: draft.errorDomain,
    // INFRA_ERROR 永远不是源的错
    sourceAtFault: draft.outcome !== EnrichmentOutcome.INFRA_ERROR,
    visibleTextLength: draft.visibleTextLength,
    error: draft.errorMessage,
  };
}

/**
 * 选出可增强的条目：只取 ON_DEMAND / ALWAYS_FETCH 源下、还没有成功 run 的 link_only 条目。
 * 排序按 published_at DESC, id DESC —— 与 Canary 的选择规则一致，可复现。
 */
export async function selectEnrichableItems(
  limit: number,
  sourceIds?: number[],
  /** 只保留这些 id（Canary 的显式选择）。资格仍然逐条重判，显式列表不绕策略闸门 */
  onlyItemIds?: number[],
  /**
   * 允许重跑已成功的条目。
   *
   * 只在**给了显式条目列表**时生效：一份点名的清单本身就是操作者的判断，
   * 「已经成功过」不该挡住一次刻意的复核。策略闸门（FEED_ONLY / NEVER_FETCH）
   * 与来源启用状态照旧生效，这里放宽的只是「别重复劳动」这一条效率规则。
   */
  allowReenrich = false
): Promise<number[]> {
  const reenrich = allowReenrich && Boolean(onlyItemIds?.length);
  const items = await prisma.sourceItem.findMany({
    where: {
      status: "link_only",
      ...(sourceIds?.length ? { source_id: { in: sourceIds } } : {}),
      ...(onlyItemIds?.length ? { id: { in: onlyItemIds } } : {}),
      source: { article_fetch_policy: { in: ALLOWED_POLICIES }, enabled: true },
      ...(reenrich
        ? {}
        : {
            enrichment_runs: {
              none: { outcome: { in: [EnrichmentOutcome.OK, EnrichmentOutcome.NOT_MODIFIED] } },
            },
          }),
    },
    orderBy: [{ published_at: "desc" }, { id: "desc" }],
    take: limit,
    select: { id: true },
  });
  return items.map((i) => i.id);
}

/**
 * 每个源各取 N 条最新的可增强条目。
 * 排序 published_at DESC, id DESC —— 与 Canary 的选择规则一致，可复现。
 */
export async function selectPerSource(sourceIds: number[], perSource: number): Promise<number[]> {
  const out: number[] = [];
  for (const sourceId of sourceIds) {
    out.push(...(await selectEnrichableItems(perSource, [sourceId])));
  }
  return out;
}
