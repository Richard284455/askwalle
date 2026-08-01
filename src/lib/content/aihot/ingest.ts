import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { ENDPOINTS, fetchAihot, loadEtag, saveEtag, type AihotClientOptions } from "./client";
import {
  AIHOT_ATTRIBUTION_NAME, AIHOT_PROVIDER,
  dailyReportHash, hotTopicHash, httpUrlOrNull, isReportDate, itemIdFromAihotUrl,
  mapCategory, parseDate, selectedItemHash,
  type AihotDailyReportDto, type AihotHotTopicDto, type AihotItemDto,
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
    if (!dto?.id || !dto.title?.trim()) {
      out.skipped.push({ reason: "缺少 id 或 title", ref: String(dto?.id ?? "?") });
      continue;
    }
    // 归因链接是硬要求：AI HOT 页面地址点不开的条目不入库
    const aihotUrl = httpUrlOrNull(dto.links?.aihot) ?? httpUrlOrNull(dto.attribution?.url);
    if (!aihotUrl) {
      out.skipped.push({ reason: "缺少合法的 AI HOT 归因链接", ref: dto.id });
      continue;
    }

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

    if (args.dryRun) { out.created++; continue; }

    const existing = await prisma.aihotSelectedItem.findUnique({
      where: { provider_provider_item_id: { provider: AIHOT_PROVIDER, provider_item_id: dto.id } },
      select: { id: true, source_snapshot_hash: true },
    });
    if (!existing) {
      await prisma.aihotSelectedItem.create({
        data: { provider: AIHOT_PROVIDER, provider_item_id: dto.id, ...data },
      });
      out.created++;
    } else if (existing.source_snapshot_hash !== hash) {
      await prisma.aihotSelectedItem.update({ where: { id: existing.id }, data });
      out.updated++;
    } else {
      // 内容没变只更新「最近见到」，不动内容字段
      await prisma.aihotSelectedItem.update({
        where: { id: existing.id }, data: { last_seen_at: new Date() },
      });
      out.unchanged++;
    }
  }

  return { ...out, status: "OK" };
}

// ── B. 当前热点 ───────────────────────────────────────────────────────────

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

    const hash = hotTopicHash(dto);
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
      select: { id: true },
    });
    if (existing) { out.unchanged++; continue; }

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
        source_snapshot_hash: hash,
      },
    });
    out.created++;
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
