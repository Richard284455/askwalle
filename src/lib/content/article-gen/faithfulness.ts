import { BRIEF_MAX_CHARS, FULL_MAX_CHARS, type FaithfulnessIssue, type GeneratedDraft, type SourceArticleInput } from "./types";

/**
 * 忠实度检查。**确定性规则，不用模型判模型。**
 *
 * 它只回答一个问题：文章里的东西，来源里有没有说过。
 * 它**不**回答「来源说的对不对」—— 那是外部事实核查，已经不在这条链路上。
 *
 * 让模型来判断模型的输出是否忠实，等于把同一类错误再犯一次；
 * 数字、日期、型号这些恰恰是可以逐字比对的，那就逐字比对。
 */

/** 金额、百分比、版本号、纯数字 —— 全部按原文形态提取 */
const NUMBER_RE = /(?:\$|US\$|€|£|¥)?\d[\d,._]*(?:\s?(?:%|percent|million|billion|trillion|万|亿))?/gi;
/**
 * 型号/版本标识：GPT-5.6、ARC-AGI-3、v1.2.3、Gemini 3.5。
 *
 * 必须收得很紧。宽松写法（允许「词 空格 数字」）会把普通英文散句里的
 * "picks 12 Horizon"、"at 25"、"July 22" 全部当成型号，然后因为「来源里
 * 没有这个型号」把忠实的稿子判失败 —— 误报会让整个闸门失去意义。
 *
 * 空格分隔只在数字带小数点时接受（Gemini 3.5 是版本，12 projects 不是）。
 */
const MODEL_RE = new RegExp(
  [
    "\\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z][A-Za-z0-9]*)*-\\d+(?:\\.\\d+)*\\b", // GPT-5.6 / ARC-AGI-3
    "\\bv\\d+(?:\\.\\d+)+\\b",                                              // v1.2.3
    "\\b[A-Z][a-zA-Z0-9]+\\s\\d+\\.\\d+\\b",                                 // Gemini 3.5
  ].join("|"),
  "g"
);
/**
 * 专名：**只认连续两个及以上的大写词**（Genesis Mission、Google Cloud、Jane Roe）。
 *
 * 刻意不收单个大写词：英文句首本来就大写，"According"、"The"、"Twelve" 这些
 * 会被误当成专名，然后因为「来源里没有这个专名」而把一篇完全忠实的稿子判失败。
 * 单词专名（Google、OpenAI）几乎总会出现在某个多词短语里，漏掉的代价远小于
 * 每篇都误报的代价。型号与版本号另有 MODEL_RE 兜底。
 */
const PROPER_RE = /\b[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){1,3}\b/g;

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const MONTH_LIST = MONTHS.split("|");
const DATE_RE = new RegExp(
  `\\b(?:${MONTHS})\\s+\\d{1,2},?\\s+\\d{4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b(?:${MONTHS})\\s+\\d{4}\\b`,
  "gi"
);

/**
 * 情态词。来源说「计划/预计/拟」，文章不得写成「已完成/已发布」——
 * 把预测写成结果是最隐蔽也最严重的失真：读者会以为事情已经发生了。
 */
const TENTATIVE = /\b(plan(s|ned|ning)?|expect(s|ed)?|aim(s|ed)?|intend(s|ed)?|propose(s|d)?|will|would|may|might|could|seek(s|ing)?|plans to|is set to|计划|预计|拟|有望|将)\b/i;
const COMPLETED = /\b(has|have|had)\s+(launched|shipped|released|completed|delivered|achieved|deployed)\b|\b(launched|shipped|released|completed|delivered|achieved|deployed)\s+(?:on|in|last)\b|已(经)?(发布|上线|完成|交付|部署|实现)/i;

/** 归属线索：来源的意见/预测/声明必须保持归属 */
const ATTRIBUTION = /\b(said|announced|according to|stated|reported|wrote|noted|the (?:report|company|department|agency) (?:states|says))\b|表示|宣布|according|称|指出/i;

/**
 * 归一化。
 *
 * 必须统一各种连字符：出版方普遍在型号里用不换行连字符（U+2011）或短破折号，
 * 而 NFKC **不会**把它们折成 ASCII 连字符。不处理的话，来源里的 `GPT‑5.5`
 * 与文章里的 `GPT-5.5` 会被判成两个不同的型号，一篇完全忠实的稿子就此被拒。
 * 这不是假想 —— 首轮 canary 就栽在这里。
 */
function norm(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .toLowerCase()
    .replace(/[\s,]+/g, "");
}

function uniq(matches: RegExpMatchArray | null): string[] {
  return [
    ...new Set(
      (matches ?? [])
        // 去掉被正则顺带吃进来的尾随标点：句末的 "GPT-5.5." 会产出 "5.5."，
        // 然后因为来源里没有 "5.5." 而误报
        .map((m) => m.trim().replace(/[.,_\-：:；;、]+$/, ""))
        .filter(Boolean)
    ),
  ];
}

/** 从一段文本里抽出需要逐字保真的 token */
export function protectedTokens(text: string) {
  return {
    numbers: uniq(text.match(NUMBER_RE)),
    dates: uniq(text.match(DATE_RE)),
    models: uniq(text.match(MODEL_RE)),
    propers: uniq(text.match(PROPER_RE)),
  };
}

/** 来源全文（标题 + 正文 + claim 值）作为比对基准 */
function sourceCorpus(input: SourceArticleInput): string {
  return [input.title, input.sourceText, input.publisher, input.author ?? "",
    input.publishedAt?.toISOString() ?? "",
    ...input.claims.map((c) => c.value)].join("\n");
}

/**
 * 数量级单位。中文用万/亿（4 位一级），英文用 thousand/million/billion（3 位一级）。
 *
 * 我们从英文来源生成中文稿，所以 `$40 million` 会被正当地写成「4000 万」。
 * 只做字面比对的话，**每一篇中文稿的每一个大数字都会误报** —— 闸门会因为
 * 噪声太大而失去意义。所以这里按数量级比较，而不是按字面。
 */
const MAGNITUDE: Record<string, number> = {
  thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12,
  k: 1e3, m: 1e6, b: 1e9,
  万: 1e4, 亿: 1e8, 千: 1e3, 百万: 1e6, 十亿: 1e9,
};

/** 把「4000 万」「$40 million」都折成数值 4e7；折不出来返回 null */
export function numericMagnitude(token: string): number | null {
  const t = token.normalize("NFKC").toLowerCase().replace(/[\s,]/g, "").replace(/^(us\$|\$|€|£|¥)/, "");
  const m = /^([\d.]+)(thousand|million|billion|trillion|百万|十亿|万|亿|千|k|m|b)?$/.exec(t);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = m[2];
  return unit ? value * (MAGNITUDE[unit] ?? 1) : value;
}

/** 收集来源里所有能折成数值的数字，供跨语言数量级比对 */
function sourceMagnitudes(corpus: string): Set<number> {
  const out = new Set<number>();
  for (const raw of uniq(corpus.match(NUMBER_RE))) {
    const v = numericMagnitude(raw);
    if (v !== null) out.add(v);
  }
  return out;
}

/**
 * 数字是否来自来源。
 *
 * 先按数量级比（跨语言等价），再退回字面比（日期年份、计数这类没有单位的）。
 * 40 与 40,000,000 仍然不等价 —— 折算后数值不同。
 */
function numberInSource(
  token: string, corpusNorm: string, magnitudes: Set<number>, followedByCjkDateUnit = false
): boolean {
  // 中文里的月份就是数字：来源写 "In December"，中文稿写「12 月」。
  // 这是日期而不是数量，按月份名去来源里找。
  if (followedByCjkDateUnit) {
    const n = Number(token.replace(/[^\d]/g, ""));
    if (n >= 1 && n <= 12 && corpusNorm.includes(norm(MONTH_LIST[n - 1]))) return true;
    // 年份与日：能在来源里找到该数字即可
    if (corpusNorm.includes(norm(token))) return true;
  }
  const v = numericMagnitude(token);
  if (v !== null && magnitudes.has(v)) return true;
  const n = norm(token);
  if (corpusNorm.includes(n)) return true;
  const bare = n.replace(/^(us\$|\$|€|£|¥)/, "").replace(/(%|percent|million|billion|trillion|万|亿)$/, "");
  return bare.length > 0 && corpusNorm.includes(bare);
}

export function checkFaithfulness(
  draft: GeneratedDraft,
  input: SourceArticleInput
): { verdict: "PASSED" | "NEEDS_REWRITE"; issues: FaithfulnessIssue[] } {
  const issues: FaithfulnessIssue[] = [];
  const article = [draft.headline, draft.shortSummary, draft.body].join("\n");
  const corpus = sourceCorpus(input);
  const corpusNorm = norm(corpus);
  const magnitudes = sourceMagnitudes(corpus);

  if (!draft.headline?.trim() || !draft.shortSummary?.trim() || !draft.body?.trim()) {
    issues.push({ code: "EMPTY_FIELD", detail: "标题、摘要或正文为空" });
  }

  const tok = protectedTokens(article);
  // 记录哪些数字后面直接跟着中文日期单位，交给数字检查特判
  const cjkDated = new Set(
    [...article.matchAll(/([\d]+)\s*[年月日号]/g)].map((m) => m[1])
  );
  for (const n of tok.numbers) {
    if (!numberInSource(n, corpusNorm, magnitudes, cjkDated.has(n.replace(/[^\d]/g, "")))) {
      issues.push({ code: "NUMBER_NOT_IN_SOURCE", detail: `数字「${n}」未出现在来源中`, snippet: n });
    }
  }
  for (const d of tok.dates) {
    if (!corpusNorm.includes(norm(d))) {
      issues.push({ code: "DATE_NOT_IN_SOURCE", detail: `日期「${d}」未出现在来源中`, snippet: d });
    }
  }
  for (const m of tok.models) {
    // 型号必须逐字一致：GPT-5.6 写成 GPT-5 是实质性失真
    if (!corpusNorm.includes(norm(m))) {
      issues.push({ code: "ENTITY_NOT_IN_SOURCE", detail: `型号/版本「${m}」未出现在来源中`, snippet: m });
    }
  }
  for (const p of tok.propers) {
    if (p.length < 4) continue;
    // 整体不在来源里时，逐词回退：多词短语可能是文章自己的组合方式，
    // 只要每个词都来自来源就不算引入新实体
    if (p.split(/\s+/).every((w) => corpusNorm.includes(norm(w)))) continue;
    if (!corpusNorm.includes(norm(p))) {
      issues.push({ code: "ENTITY_NOT_IN_SOURCE", detail: `专名「${p}」未出现在来源中`, snippet: p });
    }
  }

  // 情态：来源是预期语气而文章写成已完成
  if (TENTATIVE.test(corpus) && COMPLETED.test(article) && !COMPLETED.test(corpus)) {
    issues.push({
      code: "MODALITY_UPGRADED",
      detail: "来源使用计划/预期语气，文章却表述为已完成",
      snippet: (article.match(COMPLETED)?.[0] ?? "").slice(0, 80),
    });
  }

  // 归属：来源带归属线索时，文章也必须保留
  if (ATTRIBUTION.test(corpus) && !ATTRIBUTION.test(article)) {
    issues.push({ code: "ATTRIBUTION_MISSING", detail: "来源的主张带归属，文章未保留归属主体" });
  }
  // 无论如何，正文必须提到发布者 —— 这是最低限度的归属
  if (!norm(article).includes(norm(input.publisher))) {
    issues.push({ code: "ATTRIBUTION_MISSING", detail: `正文未提及发布者「${input.publisher}」` });
  }

  // 篇幅：可用事实少就不许写长，防止为凑字数编内容
  const limit = input.mode === "FEED_ONLY_BRIEF" ? BRIEF_MAX_CHARS : FULL_MAX_CHARS;
  if (draft.body.length > limit) {
    issues.push({
      code: input.mode === "FEED_ONLY_BRIEF" ? "BRIEF_TOO_LONG" : "BODY_TOO_LONG",
      detail: `正文 ${draft.body.length} 字符，超过 ${input.mode} 的 ${limit} 上限`,
    });
  }

  // 逐字照搬：连续 25 词与来源完全一致视为复制而非改写
  const words = draft.body.split(/\s+/);
  for (let i = 0; i + 25 <= words.length; i += 5) {
    const window = words.slice(i, i + 25).join(" ");
    if (window.length > 60 && norm(corpus).includes(norm(window))) {
      issues.push({ code: "VERBATIM_COPY", detail: "正文存在与来源逐字一致的长段落", snippet: window.slice(0, 90) });
      break;
    }
  }

  return { verdict: issues.length === 0 ? "PASSED" : "NEEDS_REWRITE", issues };
}
