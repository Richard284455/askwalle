import { isLowConfidence } from "./time-window";
import {
  STRONG_WINDOW_HOURS,
  STRONG_WINDOW_HOURS_LOW_RELIABILITY,
  WEAK_WINDOW_HOURS,
  type PairFeatures,
  type ScoreResult,
} from "./types";

/**
 * 相似度评分。**纯函数**，同输入必得同输出。
 *
 * 几条硬限制写死在这里，因为它们是这套系统最容易被绕过的地方：
 *
 * - 同一个 publisher 的两篇文章标题再像也不自动成为「多来源事件」。
 *   同一家公司连发两篇讲同一件事，那是一个来源说了两次，不是两方印证。
 * - 标题完全相同但时间隔得很远，只能 review。功能名会被复用，
 *   「Introducing X」在两年里出现两次是常事。
 * - 没有标识符、只有宽泛标题相似，不得 strong。
 * - FEED 日期不能作为唯一强信号 —— 它是订阅的说法，不是事件时间。
 * - final host 相同不能证明 publisher 相同。
 */
export function scoreEventSimilarity(f: PairFeatures): ScoreResult {
  const reasons = [...f.reasonCodes];

  // ── 6.1 同一份文档 ─────────────────────────────────────────────────
  // 注意语义：这说明两份 pack 指向**同一份文档**，
  // 不说明它们是两个独立来源对同一事件的相互验证。
  if (f.sameCanonicalIdentity) {
    return { score: 100, classification: "EXACT_DOCUMENT_MATCH", reasonCodes: [...reasons, "EXACT_BY_CANONICAL"] };
  }
  // 只有在 canonical 无法比较时才退到 final URL。双方都声明了 canonical 且不同，
  // 说明**页面自己**认为这是两份文档 —— 那时落到同一个地址只是跳转的巧合
  // （聚合页、短链、A/B 入口都会这样），不能判为同一份文档。
  // EXACT 是唯一允许传递性合并的关系，误判一次会把两簇无关文档焊在一起。
  if (f.sameFinalIdentity && f.sameNormalizedTitle && !f.canonicalConflict) {
    return { score: 100, classification: "EXACT_DOCUMENT_MATCH", reasonCodes: [...reasons, "EXACT_BY_FINAL_URL"] };
  }

  const lowConfidence = isLowConfidence(f.timeReliabilityPair);
  const window = lowConfidence ? STRONG_WINDOW_HOURS_LOW_RELIABILITY : STRONG_WINDOW_HOURS;
  const distance = f.publishedTimeDistanceHours;
  const withinStrongWindow = distance !== null && distance <= window;
  const withinWeakWindow = distance !== null && distance <= WEAK_WINDOW_HOURS;

  const strongTitleSignal =
    f.sameNormalizedTitle ||
    (f.titleJaccard >= 0.85 && f.identifierExactMatch) ||
    (f.titleShingleSimilarity >= 0.8 && f.sharedIdentifiers.length > 0);

  // ── 6.2 强候选：必须跨来源 ──────────────────────────────────────────
  if (f.differentPublisher && withinStrongWindow && strongTitleSignal) {
    let score = 80;
    if (f.sameNormalizedTitle) score += 8;
    if (f.identifierExactMatch) score += 6;
    if (f.sharedIdentifiers.length >= 2) score += 3;
    if (!lowConfidence) score += 2;
    return {
      score: Math.min(99, score),
      classification: "STRONG_REVIEW_CANDIDATE",
      reasonCodes: [...reasons, "STRONG_CROSS_PUBLISHER", lowConfidence ? "WINDOW_RELAXED_LOW_RELIABILITY" : "WINDOW_STRICT"],
    };
  }

  // 同来源的高相似只能是弱候选 —— 不构成多来源事件
  if (f.samePublisher && strongTitleSignal && withinWeakWindow) {
    return {
      score: 72,
      classification: "WEAK_REVIEW_CANDIDATE",
      reasonCodes: [...reasons, "SAME_PUBLISHER_NOT_MULTI_SOURCE"],
    };
  }
  // 标题完全相同但超出时间窗：只 review
  if (f.sameNormalizedTitle && !withinWeakWindow) {
    return {
      score: 65,
      classification: "WEAK_REVIEW_CANDIDATE",
      reasonCodes: [...reasons, "TITLE_MATCH_OUTSIDE_TIME_WINDOW"],
    };
  }

  // ── 6.3 弱候选 ─────────────────────────────────────────────────────
  if (f.titleJaccard >= 0.7 && withinWeakWindow) {
    const score = f.sharedIdentifiers.length > 0 ? 70 : 62;
    return {
      score,
      classification: "WEAK_REVIEW_CANDIDATE",
      reasonCodes: [
        ...reasons,
        f.sharedIdentifiers.length > 0 ? "PARTIAL_IDENTIFIER_OVERLAP" : "TITLE_OVERLAP_ONLY",
      ],
    };
  }

  return { score: 0, classification: "NO_MATCH", reasonCodes: reasons };
}
