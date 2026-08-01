import type { AihotContentKind, DraftLanguage, MultilingualContentForm } from "@prisma/client";

/**
 * 多语言内容闭环的类型与产品边界。
 *
 * 系统**不验证 AI HOT 的信息是否客观正确**，只保证内容忠实于 AI HOT 的输入。
 */

export const LANGUAGES: DraftLanguage[] = ["EN_US", "ES_ES", "PT_BR", "JA_JP"];
export const MASTER_LANGUAGE: DraftLanguage = "EN_US";
export const TRANSLATION_LANGUAGES = LANGUAGES.filter((l) => l !== MASTER_LANGUAGE);

export const LANGUAGE_LABEL: Record<DraftLanguage, string> = {
  EN_US: "English (United States)",
  ES_ES: "Español (España)",
  PT_BR: "Português (Brasil)",
  JA_JP: "日本語",
};

/**
 * 各体裁的正文上限。
 *
 * 上限不是排版偏好，是**防编造的闸门**：可用事实少却允许写长，模型只能靠
 * 编细节来凑长度。热点尤其严格 —— API 只给标题与计数，没有摘要。
 */
/**
 * 正文上限的参数：相对素材字符数的倍率，以及上下夹逼。
 *
 * **为什么是倍率而不是固定字符数。**
 * AI HOT 的转述语言是中文，母版是英文，而中文字符的信息密度高得多。
 * 首轮 canary 实测 10 条精选的「中文输入 → 英文母版」字符膨胀比是
 * 1.61 ～ 3.17（中位 2.30）。也就是说，一份 4068 字符的中文日报素材，
 * 忠实译写出来本就该有 9000 字符上下。拿一个固定的字符数去卡，
 * 卡住的不是编造，是中英文的字符换算 —— 那是把度量单位搞错了。
 *
 * 上限真正要防的是**用远超素材的篇幅去编细节**，所以按素材量成比例设。
 * 日报的倍率刻意压在中位数以下：日报的职责是概括，不是逐条译写。
 */
const LIMIT_RULES: Record<MultilingualContentForm, { ratio: number; floor: number; ceiling: number }> = {
  MULTILINGUAL_NEWS_BRIEF: { ratio: 3.5, floor: 400, ceiling: 1_800 },
  // 热点素材天然很少（API 不返回热点摘要），给一个能写两三句的地板
  HOT_TOPIC_BRIEF: { ratio: 3.5, floor: 500, ceiling: 900 },
  // 2.0 < 实测中位 2.30：必须比「照直译写」更短，否则就不是简报
  DAILY_BRIEF: { ratio: 2.0, floor: 1_600, ceiling: 8_000 },
};

/** 兜底常量，仅供不便取素材量的场合使用 */
export const BODY_MAX_CHARS: Record<MultilingualContentForm, number> = {
  MULTILINGUAL_NEWS_BRIEF: 1_200,
  HOT_TOPIC_BRIEF: 700,
  DAILY_BRIEF: 4_000,
};

/** 一个单元真正可用的素材量：正文 + 结构化字段 + 栏目条目 */
export function materialChars(input: Pick<ContentUnitInput, "sourceText" | "facts" | "sections">): number {
  const facts = input.facts.reduce((n, f) => n + f.label.length + f.value.length + 2, 0);
  const sections = input.sections.reduce(
    (n, s) => n + (s.label?.length ?? 0) +
      s.items.reduce((m, i) => m + i.title.length + (i.summary?.length ?? 0), 0),
    0
  );
  return input.sourceText.length + facts + sections;
}

export function bodyLimitFor(
  input: Pick<ContentUnitInput, "contentForm" | "sourceText" | "facts" | "sections">
): number {
  const rule = LIMIT_RULES[input.contentForm];
  const scaled = materialChars(input) * rule.ratio;
  return Math.round(Math.min(rule.ceiling, Math.max(rule.floor, scaled)));
}

/** 低于这个可用信息量，连简讯都写不成 */
export const MIN_SOURCE_CHARS = 24;

/** 一个待生成的内容单元（三类内容归一化后的统一形状） */
export type ContentUnitInput = {
  contentKind: AihotContentKind;
  contentForm: MultilingualContentForm;
  /** 业务身份键，决定草稿的唯一性 */
  unitKey: string;
  selectedItemId: number | null;
  hotTopicSnapshotId: number | null;
  dailyReportId: number | null;

  title: string;
  /** 可用来源文本。**只来自 AI HOT API 返回的字段** */
  sourceText: string;
  /** 分栏材料（日报用），保留原始栏目顺序 */
  sections: { label: string | null; items: { title: string; summary: string | null; sourceName: string | null; url: string | null }[] }[];

  categorySlug: string | null;
  sourceSnapshotHash: string;

  // ── 归因 ──
  attributionName: string;
  attributionUrl: string;
  originalSourceName: string | null;
  originalSourceUrl: string | null;

  publishedAt: Date | null;
  /** 供提示词与 QA 使用的结构化事实（全部来自 API 字段） */
  facts: { label: string; value: string }[];
};

export type DraftContent = {
  headline: string;
  summary: string;
  body: string;
};

/**
 * QA 问题码。
 *
 * 阻断码对应「内容偏离了 AI HOT 的输入」。
 * NON_BLOCKING 那四个是**刻意保留但永不阻断**的：它们属于已经从主链路
 * 移除的事实核查与去重职责 —— 内容重复、只有单一来源、未经外部验证、
 * 重要性不高，都不是拒绝生成的理由。
 */
export type MlIssueCode =
  | "NUMBER_MISMATCH"
  | "DATE_MISMATCH"
  | "MODEL_MISMATCH"
  | "ENTITY_MISMATCH"
  | "ATTRIBUTION_MISMATCH"
  | "MODALITY_UPGRADE"
  | "UNSUPPORTED_DETAIL"
  | "SOURCE_LINK_INVALID"
  | "TRANSLATION_FACT_DRIFT"
  | "EMPTY_FIELD";

export const BLOCKING_CODES: MlIssueCode[] = [
  "NUMBER_MISMATCH", "DATE_MISMATCH", "MODEL_MISMATCH", "ENTITY_MISMATCH",
  "ATTRIBUTION_MISMATCH", "MODALITY_UPGRADE", "UNSUPPORTED_DETAIL",
  "SOURCE_LINK_INVALID", "TRANSLATION_FACT_DRIFT", "EMPTY_FIELD",
];

/**
 * 永不阻断的判断。这条链路**不产出**这些结论，列在这里是为了让边界显式：
 * 谁要是以后想拿它们卡发布，会先看到这段注释。
 */
export const NEVER_BLOCKING_CODES = [
  "DUPLICATE_EVENT", "SINGLE_SOURCE", "NOT_EXTERNALLY_VERIFIED", "LOW_IMPORTANCE",
] as const;

export function isBlocking(code: string): boolean {
  return (BLOCKING_CODES as string[]).includes(code);
}

export type MlIssue = {
  code: MlIssueCode;
  detail: string;
  snippet?: string;
  language?: DraftLanguage;
};
