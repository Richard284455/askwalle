import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { ENDPOINTS, fetchAihot, loadEtag, saveEtag, type AihotClientOptions } from "./client";
import {
  AIHOT_ATTRIBUTION_NAME, AIHOT_PROVIDER,
  dailyReportHash, hotTopicHash, httpUrlOrNull, isReportDate, itemIdFromAihotUrl,
  mapCategory, parseDate, selectedItemHash, storyPublicIdFromUrl, textSimilarity,
  type AihotDailyReportDto, type AihotHotTopicDto, type AihotItemDto, type AihotStoryDto,
} from "./types";

/**
 * AI HOT 三类内容的入库。
 *
 * 三条路径**各自独立**，刻意不共用一张表：
 *   - 精选是独立内容单元，身份 = provider_item_id
 *   - 热点会持续变化，身份 = topic_id + 内容指纹（内容变了就是新版本）
 *   - 日报每天一期，身份 = report_date
 *
 * 不写 SourceItem / ContentSource，不建 fact pack，不做聚类、不做去重判定。
 */

export type IngestOptions = AihotClientOptions & {
  /** 跳过 ETag 条件请求（首轮 canary 需要拿到实际内容） */
  ignoreEtag?: boolean;
  /** 只取不写 */
  dryRun?: boolean;
};

export type IngestResult = {
  endpoint: string;
  status: "OK" | "NOT_MODIFIED" | "FAILED";
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: { reason: string; ref: string }[];
  message: string | null;
};

const empty = (endpoint: string): IngestResult => ({
  endpoint, status: "FAILED", fetched: 0, created: 0, updated: 0, unchanged: 0, skipped: [], message: null,
});

/** 取端点 + 处理 ETag。304 直接返回，**调用方不得写库** */
async function fetchWithEtag(
  ep: { key: string; path: string }, opts: IngestOptions
): Promise<{ kind: "data"; data: unknown } | { kind: "not_modified" } | { kind: "failed"; reason: string }> {
  const etag = opts.ignoreEtag ? null : await loadEtag(ep.key).catch(() => null);
  const res = await fetchAihot(ep.path, { ...opts, etag });
  if (!res.ok) return { kind: "failed", reason: res.reason };
  if (res.status === 304) return { kind: "not_modified" };
  if (!opts.dryRun) await saveEtag(ep.key, res.etag).catch(() => undefined);
  return { kind: "data", data: res.data };
}

// ── A. 精选资讯 ───────────────────────────────────────────────────────────

export type UpsertOutcome = "created" | "updated" | "unchanged" | "skipped";

/**
 * 写入一条精选条目。
 *
 * 抽出来是因为它有**三个**调用方：24 小时窗口的常规抓取、全量快照回填、
 * 增量 changes。三处各写一遍映射，迟早会有一处漏字段 ——
 * 而漏掉的那个字段只会在页面上以「少了一段」的形式暴露出来。
 */
export async function upsertSelectedItem(
  dto: AihotItemDto, opts: { dryRun?: boolean } = {}
): Promise<{ outcome: UpsertOutcome; reason?: string }> {
  if (!dto?.id || !dto.title?.trim()) return { outcome: "skipped", reason: "缺少 id 或 title" };

  // 归因链接是硬要求：AI HOT 页面地址点不开的条目不入库
  const aihotUrl = httpUrlOrNull(dto.links?.aihot) ?? httpUrlOrNull(dto.attribution?.url);
  if (!aihotUrl) return { outcome: "skipped", reason: "缺少合法的 AI HOT 归因链接" };

  const hash = selectedItemHash(dto);
  const data = {
    title: dto.title.trim(),
    original_title: dto.originalTitle?.trim() || null,
    summary: dto.summary?.trim() || null,
    category: dto.category?.trim() || null,
    mapped_category: mapCategory(dto.category),
    score: typeof dto.score === "number" ? Math.round(dto.score) : null,
    source_name: dto.source?.name?.trim() || null,
    aihot_url: aihotUrl,
    // 原始来源链接可以缺失（AI HOT 未提供），但**不能是非法地址**
    original_url: httpUrlOrNull(dto.links?.original),
    published_at: parseDate(dto.publishedAt),
    discovered_at: parseDate(dto.discoveredAt),
    selected: dto.selected !== false,
    source_snapshot_hash: hash,
    last_seen_at: new Date(),
  };

  if (opts.dryRun) return { outcome: "created" };

  const existing = await prisma.aihotSelectedItem.findUnique({
    where: { provider_provider_item_id: { provider: AIHOT_PROVIDER, provider_item_id: dto.id } },
    select: { id: true, source_snapshot_hash: true },
  });
  if (!existing) {
    await prisma.aihotSelectedItem.create({
      data: { provider: AIHOT_PROVIDER, provider_item_id: dto.id, ...data },
    });
    return { outcome: "created" };
  }
  if (existing.source_snapshot_hash !== hash) {
    await prisma.aihotSelectedItem.update({ where: { id: existing.id }, data });
    return { outcome: "updated" };
  }
  // 内容没变只更新「最近见到」，不动内容字段
  await prisma.aihotSelectedItem.update({
    where: { id: existing.id }, data: { last_seen_at: new Date() },
  });
  return { outcome: "unchanged" };
}

/**
 * 批量写入一页快照。
 *
 * 逐条 upsert 在全量回填时是不可接受的：每条要两趟远程往返
 * （查一次、写一次），三千条就是六千趟 —— 实测要一个多小时，
 * 而整页数据其实一次就能查完、一次就能插完。
 *
 * 这里把「查」压成一次 findMany、把「插」压成一次 createMany，
 * 只有**内容真的变了**的行才逐条 update（那是少数）。
 * 语义与逐条版本逐字一致，区别只在往返次数。
 */
export async function upsertSelectedBatch(
  dtos: AihotItemDto[], opts: { dryRun?: boolean } = {}
): Promise<{ created: number; updated: number; unchanged: number; skipped: number }> {
  const out = { created: 0, updated: 0, unchanged: 0, skipped: 0 };

  type Prepared = { id: string; hash: string; data: Record<string, unknown> };
  const prepared: Prepared[] = [];
  for (const dto of dtos) {
    if (!dto?.id || !dto.title?.trim()) { out.skipped++; continue; }
    const aihotUrl = httpUrlOrNull(dto.links?.aihot) ?? httpUrlOrNull(dto.attribution?.url);
    if (!aihotUrl) { out.skipped++; continue; }
    const hash = selectedItemHash(dto);
    prepared.push({
      id: dto.id,
      hash,
      data: {
        title: dto.title.trim(),
        original_title: dto.originalTitle?.trim() || null,
        summary: dto.summary?.trim() || null,
        category: dto.category?.trim() || null,
        mapped_category: mapCategory(dto.category),
        score: typeof dto.score === "number" ? Math.round(dto.score) : null,
        source_name: dto.source?.name?.trim() || null,
        aihot_url: aihotUrl,
        original_url: httpUrlOrNull(dto.links?.original),
        published_at: parseDate(dto.publishedAt),
        discovered_at: parseDate(dto.discoveredAt),
        selected: dto.selected !== false,
        source_snapshot_hash: hash,
        last_seen_at: new Date(),
      },
    });
  }
  if (!prepared.length) return out;
  if (opts.dryRun) { out.created = prepared.length; return out; }

  const existing = await prisma.aihotSelectedItem.findMany({
    where: { provider: AIHOT_PROVIDER, provider_item_id: { in: prepared.map((p) => p.id) } },
    select: { id: true, provider_item_id: true, source_snapshot_hash: true },
  });
  const byItemId = new Map(existing.map((e) => [e.provider_item_id, e]));

  const toCreate = prepared.filter((p) => !byItemId.has(p.id));
  const toUpdate = prepared.filter((p) => {
    const e = byItemId.get(p.id);
    return e && e.source_snapshot_hash !== p.hash;
  });
  out.unchanged = prepared.length - toCreate.length - toUpdate.length;

  if (toCreate.length) {
    /*
     * skipDuplicates：同一页里可能出现重复 id，并发回填也可能撞上。
     * 唯一约束已经挡住重复，这里让它安静跳过而不是把整页写入炸掉。
     */
    const r = await prisma.aihotSelectedItem.createMany({
      data: toCreate.map((p) => ({
        provider: AIHOT_PROVIDER, provider_item_id: p.id, ...p.data,
      })) as never,
      skipDuplicates: true,
    });
    out.created = r.count;
    out.unchanged += toCreate.length - r.count;
  }
  for (const p of toUpdate) {
    await prisma.aihotSelectedItem.update({
      where: { id: byItemId.get(p.id)!.id }, data: p.data as never,
    });
    out.updated++;
  }
  return out;
}

/**
 * 条目被取消精选。
 *
 * **不删行。** 它可能已经被生成过、审核过、发布过 ——
 * 删掉会让已发布页面的来源凭空消失，追溯链断在这里。
 * 只标记 selected=false，之后不再作为新内容候选。
 */
export async function deselectItem(providerItemId: string): Promise<boolean> {
  const r = await prisma.aihotSelectedItem.updateMany({
    where: { provider: AIHOT_PROVIDER, provider_item_id: providerItemId, selected: true },
    data: { selected: false, deselected_at: new Date(), last_seen_at: new Date() },
  });
  return r.count > 0;
}

export async function ingestSelected(
  args: { window?: string; limit?: number } & IngestOptions = {}
): Promise<IngestResult> {
  const windowSpec = args.window ?? "24h";
  const limit = args.limit ?? 100;
  const ep = ENDPOINTS.selectedRecent(windowSpec, limit);
  const out = empty(ep.path);

  const got = await fetchWithEtag(ep, args);
  if (got.kind === "failed") return { ...out, message: got.reason };
  if (got.kind === "not_modified") return { ...out, status: "NOT_MODIFIED", message: "内容未变化，未写库" };

  const payload = got.data as { items?: AihotItemDto[] } | null;
  const items = Array.isArray(payload?.items) ? payload.items : [];
  out.fetched = items.length;

  for (const dto of items) {
    const r = await upsertSelectedItem(dto, { dryRun: args.dryRun });
    if (r.outcome === "skipped") out.skipped.push({ reason: r.reason ?? "跳过", ref: String(dto?.id ?? "?") });
    else if (r.outcome === "created") out.created++;
    else if (r.outcome === "updated") out.updated++;
    else out.unchanged++;
  }

  return { ...out, status: "OK" };
}

// ── B. 当前热点 ───────────────────────────────────────────────────────────

/**
 * story 摘要的重写节流。
 *
 * digest 是 AI HOT 侧随事件推进**持续重写**的文本：一个活跃事件一天能改好几次，
 * 而改动往往只是换几个词。若逐字比对就当成内容变化，每次都会造出新快照 →
 * 新 revision → 重新生成四语言 —— 一天为同一条热点烧掉几轮 provider 调用，
 * 换来的是读者几乎看不出差别的措辞调整。
 *
 * 两道闸门，都要过才算「值得重写」：
 *   1. **改得够多**：相似度低于阈值才算实质变化；
 *   2. **隔得够久**：距上次采纳该热点的 digest 至少一天。
 *
 * 没过闸门时**沿用已存的 digest** 参与指纹计算 —— 不是丢弃新文本，
 * 而是这一轮不采纳它；下一轮到点了自然会取到当时的最新版本。
 * 存一个不参与指纹的 digest 会让「库里的摘要」和「简报依据的摘要」对不上。
 */
const DIGEST_SIMILARITY_THRESHOLD = 0.9;
const DIGEST_MIN_INTERVAL_MS = 24 * 60 * 60_000;

export type DigestDecision = {
  /** 本轮实际采纳、参与指纹计算的 digest */
  digest: string | null;
  adopted: boolean;
  reason: "NEW" | "MATERIAL_CHANGE" | "TOO_SIMILAR" | "TOO_SOON" | "NO_DIGEST" | "UNCHANGED";
  similarity: number | null;
};

/**
 * 决定是否采纳新的 story 摘要。
 *
 * 纯函数，便于直接测试各条分支 —— 节流规则要是只能靠跑真实调度来验证，
 * 那它实际上就没有被验证过。
 */
export function decideDigest(args: {
  incoming: string | null;
  stored: string | null;
  storedAt: Date | null;
  now?: Date;
  similarityThreshold?: number;
  minIntervalMs?: number;
}): DigestDecision {
  const threshold = args.similarityThreshold ?? DIGEST_SIMILARITY_THRESHOLD;
  const minInterval = args.minIntervalMs ?? DIGEST_MIN_INTERVAL_MS;
  const now = args.now ?? new Date();

  // 这一轮没取到 digest：沿用已存的，绝不把已有素材清空
  if (!args.incoming) {
    return { digest: args.stored, adopted: false, reason: "NO_DIGEST", similarity: null };
  }
  if (!args.stored) {
    return { digest: args.incoming, adopted: true, reason: "NEW", similarity: null };
  }

  const similarity = textSimilarity(args.incoming, args.stored);
  if (similarity === 1) {
    return { digest: args.stored, adopted: false, reason: "UNCHANGED", similarity };
  }
  if (similarity >= threshold) {
    return { digest: args.stored, adopted: false, reason: "TOO_SIMILAR", similarity };
  }
  const elapsed = args.storedAt ? now.getTime() - args.storedAt.getTime() : Number.POSITIVE_INFINITY;
  if (elapsed < minInterval) {
    return { digest: args.stored, adopted: false, reason: "TOO_SOON", similarity };
  }
  return { digest: args.incoming, adopted: true, reason: "MATERIAL_CHANGE", similarity };
}

export async function ingestHotTopics(
  args: { limit?: number } & IngestOptions = {}
): Promise<IngestResult> {
  const ep = ENDPOINTS.hotTopics();
  const out = empty(ep.path);

  const got = await fetchWithEtag(ep, args);
  if (got.kind === "failed") return { ...out, message: got.reason };
  if (got.kind === "not_modified") return { ...out, status: "NOT_MODIFIED", message: "内容未变化，未写库" };

  const payload = got.data as { items?: AihotHotTopicDto[] } | null;
  const all = Array.isArray(payload?.items) ? payload.items : [];
  const items = args.limit ? all.slice(0, args.limit) : all;
  out.fetched = items.length;

  const capturedAt = new Date();

  /*
   * 本轮榜单里出现过的 topic。用**完整**载荷而不是截断后的 items ——
   * 我们只取前 N 条来生成，不代表第 N+1 条就掉出了榜单。
   */
  const presentTopicIds = all.map((d) => d?.id).filter((x): x is string => Boolean(x));

  for (let i = 0; i < items.length; i++) {
    const dto = items[i];
    if (!dto?.id || !dto.title?.trim()) {
      out.skipped.push({ reason: "缺少 id 或 title", ref: String(dto?.id ?? "?") });
      continue;
    }
    const aihotUrl = httpUrlOrNull(dto.links?.aihot);
    if (!aihotUrl) {
      out.skipped.push({ reason: "缺少合法的 AI HOT 归因链接", ref: dto.id });
      continue;
    }

    /*
     * story 素材。
     *
     * publicId **只能**从 links.story 末段提取 —— 那是 AI HOT 明写的契约：
     * 「Do not construct story ids when absent」。早先误用 topic.id 去请求
     * /stories/{id}，拿回的是 404：两者根本不是同一个标识。
     * links.story 缺失就是没有 story，不去猜。
     */
    const storyPublicId = storyPublicIdFromUrl(dto.links?.story);
    let story: AihotStoryDto | null = null;
    if (storyPublicId) {
      const sres = await fetchAihot(ENDPOINTS.story(storyPublicId).path, { ...args, etag: null });
      if (sres.ok && sres.status === 200) {
        story = (sres.data as { story?: AihotStoryDto } | null)?.story ?? null;
      }
      // story 拿不到不影响热点本身入库：它是加分素材，不是必要条件
    }
    /*
     * 节流：只有「改得够多**且**隔得够久」才采纳新 digest。
     * 比对基准是该 topic **最近一次快照**采纳过的那份摘要。
     */
    const prev = await prisma.aihotHotTopicSnapshot.findFirst({
      where: { provider: AIHOT_PROVIDER, topic_id: dto.id },
      orderBy: [{ captured_at: "desc" }, { id: "desc" }],
      select: { story_digest: true, captured_at: true, story_reports_json: true, story_report_count: true },
    });
    const decision = decideDigest({
      incoming: story?.digest?.trim() || null,
      stored: prev?.story_digest ?? null,
      storedAt: prev?.captured_at ?? null,
      now: capturedAt,
    });
    const storyDigest = decision.digest;
    if (!decision.adopted && decision.reason !== "NEW") {
      out.skipped.push({
        reason: `story 摘要本轮未采纳（${decision.reason}${
          decision.similarity !== null ? ` 相似度 ${decision.similarity.toFixed(2)}` : ""}）`,
        ref: dto.id,
      });
    }

    // 采纳的那份 digest 进内容指纹：变了就该出新版本
    const hash = hotTopicHash(dto, storyDigest);
    // AI HOT 只给出代表条目的地址，关联条目 ID 由该地址解析而来 ——
    // **不做名称模糊匹配**：那是推断，不是信源给的事实
    const representativeItemId = itemIdFromAihotUrl(aihotUrl);

    if (args.dryRun) { out.created++; continue; }

    const existing = await prisma.aihotHotTopicSnapshot.findUnique({
      where: {
        provider_topic_id_source_snapshot_hash: {
          provider: AIHOT_PROVIDER, topic_id: dto.id, source_snapshot_hash: hash,
        },
      },
      select: { id: true, rank: true },
    });
    if (existing) {
      /*
       * 内容没变、只是名次动了。
       *
       * 名次**不在**内容指纹里，所以这里不会造出新快照 —— 那正是我们要的：
       * 榜单抖一下不该触发一次重写。但名次是榜单卡片要展示的实时数据，
       * 必须就地更新，否则卡片会一直挂着第一次抓到时的名次。
       *
       * captured_at 刻意**不动**：它表示「这一版内容是什么时候抓到的」，
       * 简报正文里写的也是这个日期。名次变动不是内容变动。
       */
      const newRank = i + 1;
      if (existing.rank !== newRank) {
        await prisma.aihotHotTopicSnapshot.update({
          where: { id: existing.id }, data: { rank: newRank },
        });
        out.updated++;
      } else {
        out.unchanged++;
      }
      continue;
    }

    await prisma.aihotHotTopicSnapshot.create({
      data: {
        provider: AIHOT_PROVIDER,
        topic_id: dto.id,
        title: dto.title.trim(),
        summary: dto.summary?.trim() || null,
        rank: i + 1,
        source_count: typeof dto.sourceCount === "number" ? dto.sourceCount : null,
        signal_count: typeof dto.signalCount === "number" ? dto.signalCount : null,
        source_names_json: (dto.sourceNames ?? []) as unknown as Prisma.InputJsonValue,
        related_item_ids_json: (representativeItemId ? [representativeItemId] : []) as unknown as Prisma.InputJsonValue,
        source_name: dto.source?.name?.trim() || null,
        aihot_url: aihotUrl,
        original_url: httpUrlOrNull(dto.links?.original),
        latest_at: parseDate(dto.latestAt),
        captured_at: capturedAt,
        story_public_id: storyPublicId,
        story_digest: storyDigest,
        // 未采纳新摘要时，时间戳也不能跳到新的那一版，否则「这段摘要是什么时候的」就错了
        story_digest_updated_at: decision.adopted ? parseDate(story?.digestUpdatedAt) : prev?.captured_at ?? null,
        // 只保留 AI HOT 自己给出的标题/摘要字段，**不保存第三方完整正文**
        story_reports_json: ((story?.reports ?? []).map((r) => ({
          title: r.title?.trim() ?? "",
          summary: r.summary?.trim() || null,
          sourceName: r.source?.name?.trim() || null,
          publishedAt: r.publishedAt ?? null,
          aihotUrl: httpUrlOrNull(r.links?.aihot),
        })).filter((r) => r.title)) as unknown as Prisma.InputJsonValue,
        story_report_count: typeof story?.reportCount === "number" ? story.reportCount : null,
        source_snapshot_hash: hash,
      },
    });
    out.created++;
  }

  /*
   * 已经掉出榜单的 topic 必须清掉名次。
   *
   * 不清的话，它会永远挂着最后一次上榜时的名次，和当前榜单的名次并列出现 ——
   * 页面上就会同时看到两个「Rank 1」，而读者没有任何办法分辨哪个是现在的。
   * 快照本身保留（可追溯、已发布的简报继续有效），只是不再有「当前名次」。
   *
   * 只在**确实取到了非空榜单**时执行：304、失败或空载荷时清空，
   * 等于让一次上游抖动把整个榜单抹平。
   */
  if (!args.dryRun && presentTopicIds.length) {
    const cleared = await prisma.aihotHotTopicSnapshot.updateMany({
      where: { provider: AIHOT_PROVIDER, rank: { not: null }, topic_id: { notIn: presentTopicIds } },
      data: { rank: null },
    });
    if (cleared.count) out.updated += cleared.count;
  }

  return { ...out, status: "OK" };
}

// ── C. AI 日报 ────────────────────────────────────────────────────────────

export async function ingestDaily(
  args: { date?: string } & IngestOptions = {}
): Promise<IngestResult> {
  const ep = args.date ? ENDPOINTS.dailyByDate(args.date) : ENDPOINTS.dailyLatest();
  const out = empty(ep.path);

  const got = await fetchWithEtag(ep, args);
  if (got.kind === "failed") return { ...out, message: got.reason };
  if (got.kind === "not_modified") return { ...out, status: "NOT_MODIFIED", message: "内容未变化，未写库" };

  const payload = got.data as { report?: AihotDailyReportDto } | null;
  const report = payload?.report;
  if (!report || !isReportDate(report.date)) {
    return { ...out, message: "日报缺少合法的 date（YYYY-MM-DD）" };
  }
  out.fetched = 1;

  const aihotUrl = httpUrlOrNull(report.links?.aihot) ?? httpUrlOrNull(report.attribution?.url);
  if (!aihotUrl) return { ...out, message: "日报缺少合法的 AI HOT 归因链接" };

  // 只保留 AI HOT 自己给出的标题与摘要字段，**不保存第三方完整正文**
  const sections = (report.sections ?? []).map((s, si) => ({
    order: si + 1,
    label: s.label?.trim() || null,
    items: (s.items ?? []).map((it) => ({
      title: it.title?.trim() ?? "",
      summary: it.summary?.trim() || null,
      sourceName: it.source?.name?.trim() || null,
      aihotUrl: httpUrlOrNull(it.links?.aihot),
      originalUrl: httpUrlOrNull(it.links?.original),
      itemId: itemIdFromAihotUrl(it.links?.aihot),
    })).filter((it) => it.title),
  }));

  const includedItemIds = [...new Set(sections.flatMap((s) => s.items.map((i) => i.itemId).filter(Boolean)))];
  const hash = dailyReportHash(report);

  if (args.dryRun) return { ...out, status: "OK", created: 1 };

  const data = {
    title: report.lead?.title?.trim() || null,
    summary: report.lead?.paragraph?.trim() || null,
    generated_at: parseDate(report.generatedAt),
    window_start: parseDate(report.windowStart),
    window_end: parseDate(report.windowEnd),
    sections_json: sections as unknown as Prisma.InputJsonValue,
    included_item_ids_json: includedItemIds as unknown as Prisma.InputJsonValue,
    aihot_url: aihotUrl,
    attribution_name: report.attribution?.name?.trim() || AIHOT_ATTRIBUTION_NAME,
    attribution_url: httpUrlOrNull(report.attribution?.url) ?? aihotUrl,
    source_snapshot_hash: hash,
    captured_at: new Date(),
  };

  const existing = await prisma.aihotDailyReport.findUnique({
    where: { provider_report_date: { provider: AIHOT_PROVIDER, report_date: report.date } },
    select: { id: true, source_snapshot_hash: true },
  });
  if (!existing) {
    await prisma.aihotDailyReport.create({
      data: { provider: AIHOT_PROVIDER, report_date: report.date, ...data },
    });
    return { ...out, status: "OK", created: 1 };
  }
  if (existing.source_snapshot_hash === hash) {
    return { ...out, status: "OK", unchanged: 1 };
  }
  await prisma.aihotDailyReport.update({ where: { id: existing.id }, data });
  return { ...out, status: "OK", updated: 1 };
}
