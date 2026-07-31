import crypto from "crypto";

import { jaccard } from "./title-normalize";
import { hoursBetween } from "./time-window";
import type { ClusteringInput, PairFeatures } from "./types";

/**
 * 两两特征。
 *
 * pair 顺序恒规范化为 left < right —— 传入顺序不同不得产生不同的 hash 或分数，
 * 否则同一对 pack 会在两次运行里得到两条边。
 */
export function pairHashOf(ruleVersion: string, a: number, b: number): string {
  const [left, right] = a < b ? [a, b] : [b, a];
  return crypto.createHash("sha256").update(`${ruleVersion}|${left}|${right}`).digest("hex").slice(0, 32);
}

export function computePairFeatures(a: ClusteringInput, b: ClusteringInput): PairFeatures {
  const [left, right] = a.factPackId < b.factPackId ? [a, b] : [b, a];
  const reasonCodes: string[] = [];

  const sameCanonicalIdentity = Boolean(
    left.canonicalIdentity && right.canonicalIdentity && left.canonicalIdentity === right.canonicalIdentity
  );
  const canonicalConflict = Boolean(
    left.canonicalIdentity && right.canonicalIdentity && left.canonicalIdentity !== right.canonicalIdentity
  );
  const sameFinalIdentity = Boolean(
    left.finalIdentity && right.finalIdentity && left.finalIdentity === right.finalIdentity
  );
  const sameNormalizedTitle = Boolean(
    left.normalizedTitle && right.normalizedTitle && left.normalizedTitle === right.normalizedTitle
  );

  const titleJaccard = jaccard(left.titleTokenSet, right.titleTokenSet);
  const titleShingleSimilarity = jaccard(left.titleShingles, right.titleShingles);

  const shared = [...left.identifiers].filter((id) => right.identifiers.has(id)).sort();
  // 「双方都有标识符且完全一致」才算精确匹配。一方没有标识符时不能算 ——
  // 空集合与任何集合都「不冲突」，那是没有信息，不是吻合。
  const identifierExactMatch =
    left.identifiers.size > 0 &&
    right.identifiers.size > 0 &&
    shared.length === left.identifiers.size &&
    shared.length === right.identifiers.size;

  const publishedTimeDistanceHours = hoursBetween(left.timeValue, right.timeValue);
  const samePublisher = left.publisher === right.publisher;
  const sameRegistrableDomain = Boolean(
    left.registrableDomain && right.registrableDomain && left.registrableDomain === right.registrableDomain
  );

  if (sameCanonicalIdentity) reasonCodes.push("SAME_CANONICAL_IDENTITY");
  if (canonicalConflict) reasonCodes.push("CANONICAL_CONFLICT");
  if (!sameCanonicalIdentity && sameFinalIdentity) reasonCodes.push("SAME_FINAL_IDENTITY");
  if (sameNormalizedTitle) reasonCodes.push("SAME_NORMALIZED_TITLE");
  if (shared.length) reasonCodes.push(`SHARED_IDENTIFIERS:${shared.length}`);
  if (identifierExactMatch) reasonCodes.push("IDENTIFIER_EXACT_MATCH");
  if (samePublisher) reasonCodes.push("SAME_PUBLISHER");
  else reasonCodes.push("DIFFERENT_PUBLISHER");
  if (sameRegistrableDomain) reasonCodes.push("SAME_REGISTRABLE_DOMAIN");
  if (publishedTimeDistanceHours !== null) {
    reasonCodes.push(`TIME_DISTANCE_H:${Math.round(publishedTimeDistanceHours)}`);
  }
  reasonCodes.push(`TIME_RELIABILITY:${left.timeReliability}/${right.timeReliability}`);

  return {
    leftPackId: left.factPackId,
    rightPackId: right.factPackId,
    sameCanonicalIdentity,
    canonicalConflict,
    sameFinalIdentity,
    sameNormalizedTitle,
    titleJaccard: Number(titleJaccard.toFixed(4)),
    titleShingleSimilarity: Number(titleShingleSimilarity.toFixed(4)),
    sharedIdentifiers: shared,
    identifierExactMatch,
    publishedTimeDistanceHours:
      publishedTimeDistanceHours === null ? null : Number(publishedTimeDistanceHours.toFixed(2)),
    timeReliabilityPair: [left.timeReliability, right.timeReliability],
    samePublisher,
    differentPublisher: !samePublisher,
    sameRegistrableDomain,
    crossDomainPair: !sameRegistrableDomain,
    sourceTiers: [left.sourceTier, right.sourceTier],
    reasonCodes,
  };
}
