import type { ArticleGenerationMode } from "@prisma/client";

/**
 * 来源忠实的原创资讯生成。
 *
 * 产品边界，写死在这里省得后来的人误解：
 *   - 系统**不判断信源说的是否客观正确**。事实核查、跨来源印证、事件聚类
 *     都不在这条链路上。
 *   - 系统**只保证**生成的文章忠实于指定信源：不改数字、不改时间、不改归属、
 *     不添加来源没说的事。
 *   - 每个合格 SourceItem 都是独立发布单元。内容重复**不是**拒绝理由。
 */

export const GENERATION_VERSION = "source-faithful-article-v1";
export const DEFAULT_VARIANT = "default";

/** FEED_ONLY_BRIEF 的正文上限：可用事实少，硬性限制篇幅，防止为凑长度编内容 */
export const BRIEF_MAX_CHARS = 700;
export const FULL_MAX_CHARS = 4_000;
/** 低于这个可用信息量，连短讯都写不成 */
export const MIN_SOURCE_CHARS = 40;

/**
 * 生成所依据的来源输入。
 *
 * 刻意与 SourceFactPack 分开：FEED_ONLY 只有订阅字段，把它包装成
 * SUBSTANTIAL 的 FactPack 会污染「已提取完整正文」这个语义。
 */
export type SourceArticleInput = {
  sourceItemId: number;
  factPackId: number | null;
  mode: ArticleGenerationMode;
  /** FULL_SOURCE = ARTICLE_PAGE；FEED_ONLY_BRIEF = FEED */
  evidenceMode: "ARTICLE_PAGE" | "FEED";
  publisher: string;
  sourceUrl: string;
  canonicalUrl: string | null;
  title: string;
  author: string | null;
  publishedAt: Date | null;
  capturedAt: Date | null;
  /** 可用来源文本：正文摘录或订阅摘要。**不是**完整正文副本 */
  sourceText: string;
  /** 来源自身的结构化断言，来自 fact pack */
  claims: { key: string; predicate: string; value: string }[];
  language: string | null;
};

export type GeneratedDraft = {
  headline: string;
  shortSummary: string;
  body: string;
  factMapping: { fact: string; sourceEvidence: string }[];
};

export type FaithfulnessIssue = {
  code:
    | "NUMBER_NOT_IN_SOURCE"
    | "DATE_NOT_IN_SOURCE"
    | "ENTITY_NOT_IN_SOURCE"
    | "MODALITY_UPGRADED"
    | "ATTRIBUTION_MISSING"
    | "BRIEF_TOO_LONG"
    | "BODY_TOO_LONG"
    | "VERBATIM_COPY"
    | "EMPTY_FIELD";
  detail: string;
  /** 出问题的片段（限长，便于人工定位） */
  snippet?: string;
};
