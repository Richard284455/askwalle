import type { SourceFactPack } from "@prisma/client";

import { SUPPORTED_EXTRACTOR_VERSIONS, type ClusteringEligibility } from "./types";

/**
 * 参与聚类的资格。纯函数，不查库。
 *
 * 缺失证据的 pack 一律排除 —— 一份没有标题或没有任何 URL 的 pack
 * 在相似度计算里只会贡献噪声：它和谁都「不冲突」，于是和谁都可能被判像。
 */
export function evaluateEventClusteringEligibility(pack: SourceFactPack): ClusteringEligibility {
  if (pack.status === "REJECTED") {
    return { eligible: false, reason: "REJECTED", detail: "该 pack 已被否决" };
  }
  if (pack.status === "SUPERSEDED" || pack.superseded_at !== null) {
    return { eligible: false, reason: "SUPERSEDED", detail: "该 pack 已被更新的提取结果取代" };
  }
  if (pack.status !== "READY" && pack.status !== "APPROVED") {
    return { eligible: false, reason: "NOT_READY", detail: `状态为 ${pack.status}` };
  }
  if (!SUPPORTED_EXTRACTOR_VERSIONS.includes(pack.extractor_version)) {
    return {
      eligible: false,
      reason: "UNSUPPORTED_EXTRACTOR",
      detail: `提取器版本 ${pack.extractor_version} 不在支持列表内`,
    };
  }
  if (!pack.input_hash) {
    return { eligible: false, reason: "MISSING_INPUT_HASH", detail: "缺少输入指纹，无法回放" };
  }
  if (!pack.publisher_snapshot?.trim()) {
    return { eligible: false, reason: "MISSING_PUBLISHER", detail: "缺少发布者快照" };
  }
  if (!pack.document_title_snapshot?.trim()) {
    return { eligible: false, reason: "MISSING_TITLE", detail: "缺少标题快照" };
  }
  if (!pack.canonical_url_snapshot?.trim() && !pack.final_url_snapshot?.trim()) {
    return { eligible: false, reason: "MISSING_URL", detail: "canonical 与 final URL 均为空" };
  }
  return { eligible: true };
}
