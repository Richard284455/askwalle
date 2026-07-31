import crypto from "crypto";

import type { ContentSource, SourceItem, SourceItemEnrichmentRun } from "@prisma/client";

import { EXTRACTOR_VERSION, type PackInput } from "./types";

/**
 * 输入快照与指纹。
 *
 * pack 的全部字段必须来自**同一次** enrichment run —— 从新记录取标题、
 * 从旧记录取正文，会造出一份现实中从未存在过的文档。
 */

function metaOf(run: SourceItemEnrichmentRun): Record<string, unknown> {
  const m = run.metadata_json;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildPackInput(args: {
  item: SourceItem;
  source: ContentSource;
  run: SourceItemEnrichmentRun;
  extractorVersion?: string;
}): PackInput {
  const meta = metaOf(args.run);
  return {
    sourceItemId: args.item.id,
    enrichmentRunId: args.run.id,
    extractorVersion: args.extractorVersion ?? EXTRACTOR_VERSION,
    publisher: args.source.publisher,
    sourceTier: args.source.source_tier,
    sourceExternalKey: args.source.external_key,
    feedTitle: args.item.title,
    feedUrl: args.item.url,
    feedAuthor: args.item.author,
    feedPublishedAt: args.item.published_at,
    requestedUrl: args.run.requested_url,
    finalUrl: args.run.final_url,
    canonicalUrl: args.run.canonical_url,
    documentTitle: args.run.page_title,
    documentAuthor: args.run.author,
    documentPublishedAt: args.run.page_published_at,
    language: args.run.language,
    contentQuality: str(meta.contentQuality) ?? "UNKNOWN",
    contentHash: args.run.content_hash,
    visibleTextLength: args.run.visible_text_length,
    capturedAt: args.run.started_at,
    titleSource: str(meta.titleSource) ?? "NONE",
    authorSource: str(meta.authorSource) ?? "NONE",
    publishedAtSource: str(meta.publishedAtSource) ?? "NONE",
    requestedHost: str(meta.requestedHost),
    finalHost: str(meta.finalHost),
    canonicalHost: str(meta.canonicalHost),
    crossDomainRedirect: meta.crossDomainRedirect === "true" || meta.crossDomainRedirect === true,
  };
}

/**
 * 规范化序列化。
 *
 * 数据库 JSON 的键顺序不稳定，直接参与 hash 会让同一份输入算出不同指纹 ——
 * 那样幂等就成了摆设。这里对键做全序排序，日期统一成 ISO，undefined 与 null 同义。
 */
export function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key]);
    return out;
  }
  return value;
}

/** 相同输入 → 相同指纹 → 返回已有 pack，不重复插 claim/evidence */
export function computeInputHash(input: PackInput): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(input)))
    .digest("hex");
}
