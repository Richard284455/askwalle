import type { ContentSourceTier, EdgeClassification } from "@prisma/client";

/**
 * 事件候选发现的共享类型。
 *
 * 这里产出的**只是候选**。「两篇文章标题很像」不等于「它们讲的是同一件事」——
 * 两家公司同一天发同名功能是常态，靠标题自动合并会造出现实中不存在的事件。
 */

export const RULE_VERSION = "event-cluster-rules-v1";
export const SUPPORTED_EXTRACTOR_VERSIONS = ["source-fact-pack-v1"];

/** 低于这个分数不落库 */
export const MIN_PERSISTED_SCORE = 60;
export const STRONG_MIN_SCORE = 80;

/** 强候选的时间窗；一方日期可靠性为 LOW 时放宽 */
export const STRONG_WINDOW_HOURS = 72;
export const STRONG_WINDOW_HOURS_LOW_RELIABILITY = 120;
/** 弱候选的时间窗 */
export const WEAK_WINDOW_HOURS = 24 * 7;

export type TimeReliability = "HIGH" | "MEDIUM" | "LOW" | "FALLBACK";

export type IneligibleReason =
  | "NOT_FOUND"
  | "NOT_READY"
  | "SUPERSEDED"
  | "REJECTED"
  | "MISSING_PUBLISHER"
  | "MISSING_TITLE"
  | "MISSING_URL"
  | "MISSING_INPUT_HASH"
  | "UNSUPPORTED_EXTRACTOR"
  | "SOURCE_EVIDENCE_MISSING";

export type ClusteringEligibility =
  | { eligible: true }
  | { eligible: false; reason: IneligibleReason; detail: string };

/** 一个 pack 参与聚类时用到的全部确定性特征 */
export type ClusteringInput = {
  factPackId: number;
  publisher: string;
  sourceTier: ContentSourceTier | null;
  rawTitle: string;
  normalizedTitle: string;
  titleTokens: string[];
  titleTokenSet: Set<string>;
  titleShingles: Set<string>;
  identifiers: Set<string>;
  canonicalIdentity: string | null;
  finalIdentity: string | null;
  registrableDomain: string | null;
  normalizedPath: string | null;
  timeValue: Date | null;
  timeSource: string;
  timeReliability: TimeReliability;
};

export type PairFeatures = {
  leftPackId: number;
  rightPackId: number;
  sameCanonicalIdentity: boolean;
  /** 双方都声明了 canonical 但**不相同** —— 页面自己说它们是两份文档 */
  canonicalConflict: boolean;
  sameFinalIdentity: boolean;
  sameNormalizedTitle: boolean;
  titleJaccard: number;
  titleShingleSimilarity: number;
  sharedIdentifiers: string[];
  identifierExactMatch: boolean;
  publishedTimeDistanceHours: number | null;
  timeReliabilityPair: [TimeReliability, TimeReliability];
  samePublisher: boolean;
  differentPublisher: boolean;
  sameRegistrableDomain: boolean;
  crossDomainPair: boolean;
  sourceTiers: [string | null, string | null];
  reasonCodes: string[];
};

export type ScoreResult = {
  score: number;
  classification: EdgeClassification;
  reasonCodes: string[];
};
