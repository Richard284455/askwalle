import type {
  ContentSourceTier,
  FactCertainty,
  FactClaimScope,
  FactEvidenceOrigin,
  FactObjectType,
  FactUsage,
  Prisma,
} from "@prisma/client";

/**
 * Source Fact Pack 的共享类型。
 *
 * 一个 pack 只代表**一篇来源文档的一次确定提取结果**。它不是事件，
 * 标题也不是已确认的事实 —— 那些判断属于后续聚类与语义抽取。
 */

export const EXTRACTOR_VERSION = "source-fact-pack-v1";
/** 自动路径要求的最短可见正文 */
export const MIN_AUTO_TEXT_LENGTH = 1_500;
/** 证据摘录上限：证据是指针，不是第三方内容的副本 */
export const EVIDENCE_EXCERPT_MAX = 500;

export type IneligibleReason =
  | "SOURCE_ITEM_NOT_FOUND"
  | "SOURCE_DISABLED"
  | "NO_ENRICHMENT_RUN"
  | "ENRICHMENT_NOT_OK"
  | "THIN_REQUIRES_REVIEW"
  | "CONTENT_INSUFFICIENT"
  | "CONTENT_TRUNCATED"
  | "CONTENT_UNSUPPORTED"
  | "MISSING_CONTENT_HASH"
  | "TEXT_TOO_SHORT"
  | "CLIENT_INTERNAL_ERROR"
  | "RUN_ITEM_MISMATCH"
  | "RUN_EXCLUDED";

export type EligibilityResult =
  | { eligible: true; basis: "AUTO_SUBSTANTIAL" }
  | { eligible: false; reason: IneligibleReason; detail: string };

export type BuildStatus = "BUILT" | "EXISTING" | "INELIGIBLE" | "OLDER_THAN_CURRENT" | "INFRA_ERROR";

export type BuildResult = {
  sourceItemId: number;
  enrichmentRunId: number | null;
  factPackId: number | null;
  status: BuildStatus;
  ineligibleReason: IneligibleReason | null;
  claimCount: number;
  evidenceCount: number;
  inputHash: string | null;
  message: string | null;
};

/** 一条待写入的断言，object 字段**恰好一个**有值 */
export type ClaimDraft = {
  claimKey: string;
  claimScope: FactClaimScope;
  claimType: string;
  subject: string;
  predicate: string;
  objectType: FactObjectType;
  objectText?: string;
  objectNumber?: number;
  objectBoolean?: boolean;
  objectDatetime?: Date;
  objectUrl?: string;
  objectJson?: Prisma.InputJsonValue;
  certainty: FactCertainty;
  usage: FactUsage;
  confidence?: number;
  isVendorClaim?: boolean;
  evidence: EvidenceDraft[];
};

export type EvidenceDraft = {
  origin: FactEvidenceOrigin;
  fieldPath: string;
  excerpt?: string | null;
  sourceUrl?: string | null;
};

/** 生成 pack 所需的全部输入，全部来自**同一次** enrichment run */
export type PackInput = {
  sourceItemId: number;
  enrichmentRunId: number;
  extractorVersion: string;
  publisher: string;
  sourceTier: ContentSourceTier | null;
  sourceExternalKey: string | null;
  feedTitle: string;
  feedUrl: string;
  feedAuthor: string | null;
  feedPublishedAt: Date | null;
  requestedUrl: string;
  finalUrl: string | null;
  canonicalUrl: string | null;
  documentTitle: string | null;
  documentAuthor: string | null;
  documentPublishedAt: Date | null;
  language: string | null;
  contentQuality: string;
  contentHash: string | null;
  visibleTextLength: number | null;
  capturedAt: Date;
  titleSource: string;
  authorSource: string;
  publishedAtSource: string;
  requestedHost: string | null;
  finalHost: string | null;
  canonicalHost: string | null;
  crossDomainRedirect: boolean;
};
