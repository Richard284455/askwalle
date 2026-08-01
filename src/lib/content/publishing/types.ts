import type { DraftLanguage, MultilingualContentForm } from "@prisma/client";

/**
 * 多语言发布的路径、locale 与人工审核清单。
 *
 * 产品边界不变：系统不判断 AI HOT 说的是否客观正确，只保证发布出去的内容
 * 忠实于 AI HOT 输入。**内容重复不是拒绝发布的理由。**
 */

export const LOCALES: DraftLanguage[] = ["EN_US", "ES_ES", "PT_BR", "JA_JP"];
export const DEFAULT_LOCALE: DraftLanguage = "EN_US";

/** URL 里的 locale 片段。x-default 指向 en */
export const LOCALE_SEGMENT: Record<DraftLanguage, string> = {
  EN_US: "en", ES_ES: "es", PT_BR: "pt-br", JA_JP: "ja",
};

/** hreflang 值（BCP 47） */
export const LOCALE_HREFLANG: Record<DraftLanguage, string> = {
  EN_US: "en-US", ES_ES: "es-ES", PT_BR: "pt-BR", JA_JP: "ja-JP",
};

/** HTML lang 属性 */
export const LOCALE_HTML_LANG = LOCALE_HREFLANG;

const SEGMENT_TO_LOCALE = new Map(
  Object.entries(LOCALE_SEGMENT).map(([k, v]) => [v, k as DraftLanguage])
);

export function localeFromSegment(seg: string): DraftLanguage | null {
  return SEGMENT_TO_LOCALE.get(seg.toLowerCase()) ?? null;
}

export const SITE_ORIGIN = process.env.NEXT_PUBLIC_SITE_ORIGIN?.replace(/\/$/, "") || "https://askwalle.com";

/**
 * 公开路径。
 *
 * 四种语言共用同一个 slug —— 只换 locale 前缀。
 * 每种语言各起一套 slug 的话，hreflang 就得额外维护一张映射表，
 * 而任何一处漏更新都会让互链指向 404。
 */
export function publicPath(args: {
  locale: DraftLanguage;
  contentForm: MultilingualContentForm;
  slug: string;
  reportDate?: string | null;
}): string {
  const loc = LOCALE_SEGMENT[args.locale];
  if (args.contentForm === "DAILY_BRIEF") {
    if (!args.reportDate) throw new Error("日报路径缺少 report_date");
    return `/${loc}/briefings/daily/${args.reportDate}`;
  }
  if (args.contentForm === "HOT_TOPIC_BRIEF") return `/${loc}/updates/trending/${args.slug}`;
  return `/${loc}/updates/${args.slug}`;
}

export function absoluteUrl(path: string): string {
  return `${SITE_ORIGIN}${path}`;
}

/**
 * slug 生成。
 *
 * 只从英文母版标题生成 —— 中日文标题转出来的 slug 要么是空的，
 * 要么是一串百分号转义，既不可读也不稳定。
 */
export function slugify(headline: string, suffix?: string): string {
  const base = headline
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s-]/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70)
    .replace(/-$/, "");
  const s = base || "update";
  return suffix ? `${s}-${suffix}` : s;
}

// ── 人工审核清单 ──────────────────────────────────────────────────────────

/**
 * 逐语言的十项审核。
 *
 * 存的是逐项结论而不是一个 approved 布尔 —— 事后要回答
 * 「当时到底看了什么、哪一项放过了」，一个布尔什么也答不了。
 */
export const REVIEW_CHECKLIST = [
  { key: "headline_natural", label: "标题自然，无明显机翻感" },
  { key: "numbers_consistent", label: "数字、金额、百分比、日期一致" },
  { key: "entities_consistent", label: "公司、人物、模型与版本号一致" },
  { key: "subject_action_consistent", label: "主体与动作一致" },
  { key: "modality_preserved", label: "计划/预计/可能未被写成已完成" },
  { key: "no_new_facts", label: "没有输入之外的新事实" },
  { key: "attribution_correct", label: "归因正确" },
  { key: "links_valid", label: "原始来源链接与 AI HOT 链接有效" },
  { key: "no_internal_leakage", label: "未泄露内部字段、prompt 或 QA 详情" },
  { key: "length_appropriate", label: "页面长度与内容类型匹配" },
] as const;

export type ChecklistKey = (typeof REVIEW_CHECKLIST)[number]["key"];
export type ChecklistResult = Record<ChecklistKey, boolean>;

export const ALL_CHECKS_PASS: ChecklistResult = Object.fromEntries(
  REVIEW_CHECKLIST.map((c) => [c.key, true])
) as ChecklistResult;

export function failedChecks(result: ChecklistResult): string[] {
  return REVIEW_CHECKLIST.filter((c) => !result[c.key]).map((c) => c.label);
}
