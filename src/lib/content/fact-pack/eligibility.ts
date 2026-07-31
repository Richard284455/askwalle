import type { EnrichmentOutcome, SourceItemEnrichmentRun } from "@prisma/client";

import { MIN_AUTO_TEXT_LENGTH, type EligibilityResult } from "./types";

/**
 * 自动生成资格。**纯函数** —— 不查库、不发请求。
 *
 * 自动路径刻意收得很紧：只有「完整取回 + 分量足够 + 指纹在手」的提取结果
 * 才配当作下游事实的输入。THIN 不是失败，是**需要人来看一眼**；把它自动放行
 * 等于让一段 894 字的壳页面和一篇 11000 字的正文享有同等分量。
 */

type RunLike = Pick<
  SourceItemEnrichmentRun,
  "id" | "source_item_id" | "outcome" | "truncated" | "content_hash" | "visible_text_length" | "error_domain"
> & { metadata_json?: unknown; evidence_json?: unknown };

function metaOf(run: RunLike): Record<string, unknown> {
  const m = run.metadata_json;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

/** 质量分级：优先读 metadata，缺失时按长度回落（backfill 之前的历史 run） */
export function qualityOf(run: RunLike): string {
  const meta = metaOf(run);
  if (typeof meta.contentQuality === "string") return meta.contentQuality;
  if (run.truncated) return "TRUNCATED";
  const len = run.visible_text_length ?? 0;
  if (len < 300) return "INSUFFICIENT";
  if (len < MIN_AUTO_TEXT_LENGTH) return "THIN";
  return "SUBSTANTIAL";
}

export function evaluateSourceFactPackEligibility(input: {
  sourceItemId: number;
  sourceEnabled: boolean;
  run: RunLike | null;
}): EligibilityResult {
  const { run } = input;
  if (!input.sourceEnabled) {
    return { eligible: false, reason: "SOURCE_DISABLED", detail: "来源已停用" };
  }
  if (!run) {
    return { eligible: false, reason: "NO_ENRICHMENT_RUN", detail: "该条目没有可用的正文提取记录" };
  }
  // 条目与 run 必须对得上 —— 拿错 run 生成的 pack 是彻底错误的证据链
  if (run.source_item_id !== input.sourceItemId) {
    return {
      eligible: false,
      reason: "RUN_ITEM_MISMATCH",
      detail: `run #${run.id} 属于条目 #${run.source_item_id}，不是 #${input.sourceItemId}`,
    };
  }
  const outcome: EnrichmentOutcome = run.outcome;
  if (outcome !== "OK") {
    return { eligible: false, reason: "ENRICHMENT_NOT_OK", detail: `提取结果为 ${outcome}` };
  }
  // 客户端自身缺陷绝不能当作可信输入
  if (run.error_domain === "INTERNAL" || run.error_domain === "LEASE" || run.error_domain === "DATABASE") {
    return { eligible: false, reason: "CLIENT_INTERNAL_ERROR", detail: `error_domain=${run.error_domain}` };
  }
  const meta = metaOf(run);
  if (meta.invalidated === true || meta.excluded === true) {
    return { eligible: false, reason: "RUN_EXCLUDED", detail: "该提取记录已被标记排除" };
  }
  if (run.truncated) {
    return { eligible: false, reason: "CONTENT_TRUNCATED", detail: "响应不完整，正文可能缺失" };
  }

  const quality = qualityOf(run);
  if (quality === "THIN") {
    return { eligible: false, reason: "THIN_REQUIRES_REVIEW", detail: `正文仅 ${run.visible_text_length} 字符，需人工确认` };
  }
  if (quality === "INSUFFICIENT") {
    return { eligible: false, reason: "CONTENT_INSUFFICIENT", detail: `正文仅 ${run.visible_text_length} 字符` };
  }
  if (quality === "TRUNCATED") {
    return { eligible: false, reason: "CONTENT_TRUNCATED", detail: "正文被截断" };
  }
  if (quality === "UNSUPPORTED") {
    return { eligible: false, reason: "CONTENT_UNSUPPORTED", detail: "非支持的内容类型" };
  }
  if (quality !== "SUBSTANTIAL") {
    return { eligible: false, reason: "CONTENT_INSUFFICIENT", detail: `未知质量分级 ${quality}` };
  }
  if (!run.content_hash) {
    return { eligible: false, reason: "MISSING_CONTENT_HASH", detail: "缺少正文指纹，无法回放校验" };
  }
  if ((run.visible_text_length ?? 0) < MIN_AUTO_TEXT_LENGTH) {
    return {
      eligible: false,
      reason: "TEXT_TOO_SHORT",
      detail: `正文 ${run.visible_text_length} 字符，低于自动路径的 ${MIN_AUTO_TEXT_LENGTH} 下限`,
    };
  }
  return { eligible: true, basis: "AUTO_SUBSTANTIAL" };
}
