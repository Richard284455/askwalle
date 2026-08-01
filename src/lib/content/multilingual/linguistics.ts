/**
 * 跨语言的数字与日期归一化。
 *
 * 这是整条多语言链路里最容易出错、也最难事后发现的部分：
 * 一个把 `1.500`（西语的一千五）读成 1.5 的比对器，会**放过**真正的失真，
 * 同时把忠实的译文判失败。所以数字与日期一律先折成规范值再比较，不比字面。
 */

export type Lang = "EN_US" | "ES_ES" | "PT_BR" | "JA_JP" | "SOURCE";

// ── 数量级 ────────────────────────────────────────────────────────────────

/**
 * 各语言的数量级词。
 *
 * 两个必须点名的陷阱：
 *   - 西语 `billón` 是 10^12，**不是** 10^9；10^9 要说 `mil millones`。
 *   - 巴葡 `bilhão` 才是 10^9。两者拼写相近、量级差一千倍。
 * 按英语习惯统一处理会让金额直接错三个数量级。
 */
const MAGNITUDE_BY_LANG: Record<string, Record<string, number>> = {
  EN_US: { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, k: 1e3, m: 1e6, bn: 1e9, b: 1e9 },
  ES_ES: { mil: 1e3, millon: 1e6, millones: 1e6, "milmillones": 1e9, billon: 1e12, billones: 1e12, mm: 1e6 },
  PT_BR: { mil: 1e3, milhao: 1e6, milhoes: 1e6, bilhao: 1e9, bilhoes: 1e9, trilhao: 1e12, trilhoes: 1e12 },
  JA_JP: { 千: 1e3, 万: 1e4, 億: 1e8, 兆: 1e12 },
  // 来源是中文（AI HOT 的转述语言），保留中英两套
  SOURCE: {
    千: 1e3, 万: 1e4, 亿: 1e8, 億: 1e8, 兆: 1e12, 百万: 1e6, 十亿: 1e9,
    thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, k: 1e3, m: 1e6, b: 1e9,
  },
};

/** 小数点/千分位约定：西语与巴葡是「点分千位、逗号分小数」，与英中日相反 */
const COMMA_IS_DECIMAL = new Set(["ES_ES", "PT_BR"]);

const NUMBER_TOKEN_RE =
  /(?:\$|US\$|€|£|¥|R\$)?\s?\d[\d., ]*\s?(?:%|percent|por\s?ciento|por\s?cento|パーセント|mil\s+millones|thousand|million|billion|trillion|millones|mill[oó]n|bilh[oõ]es|bilh[aã]o|milh[oõ]es|milh[aã]o|trilh[oõ]es|trilh[aã]o|mil|千|万|亿|億|兆|百万|十亿)?/gi;

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * 把一个数字 token 折成数值。折不出来返回 null。
 *
 * 例：`$40 million` → 4e7；`4000万` → 4e7；`40 millones` → 4e7；
 *     西语 `1.500` → 1500；西语 `1,5` → 1.5。
 */
export function parseNumber(token: string, lang: Lang): number | null {
  let t = stripDiacritics(token.normalize("NFKC").toLowerCase())
    .replace(/[ \s]/g, "")
    .replace(/^(us\$|r\$|\$|€|£|¥)/, "");

  // 百分比不参与数量级换算，去掉单位后按纯数解析
  const isPercent = /(%|percent|porciento|porcento|パーセント)$/.test(t);
  t = t.replace(/(%|percent|porciento|porcento|パーセント)$/, "");

  const table = MAGNITUDE_BY_LANG[lang] ?? MAGNITUDE_BY_LANG.EN_US;
  // 先匹配最长的单位词（milmillones 必须先于 mil 命中，否则 10^9 会被读成 10^3）
  const units = Object.keys(table).sort((a, b) => b.length - a.length);
  let multiplier = 1;
  for (const u of units) {
    if (t.endsWith(u)) {
      multiplier = table[u];
      t = t.slice(0, -u.length);
      break;
    }
  }

  if (!t) return null;

  if (COMMA_IS_DECIMAL.has(lang)) {
    // 1.234.567,89 → 1234567.89 ；1,5 → 1.5
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
    else if (/^\d+,\d+$/.test(t)) t = t.replace(",", ".");
    // 点后不是整三位就不是千分位（`3.5` 是三点五，不是三十五）。
    // 把它当千分位剥掉，会让版本号与小数在西语/巴葡里整体放大十倍
    else t = t.replace(/,/g, "");
  } else {
    // 1,234,567.89 → 1234567.89
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
    else t = t.replace(/,/g, "");
  }

  if (!/^\d*\.?\d+$/.test(t)) return null;
  const v = Number(t);
  if (!Number.isFinite(v)) return null;
  return isPercent ? v : v * multiplier;
}

/**
 * 抽数字之前先把日期与型号挖掉。
 *
 * 不挖的话，`Lyria 3.5` 会贡献一个「3.5」、`2026年7月31日` 会贡献
 * 2026 / 7 / 31 三个数 —— 而这两类恰恰各有专门的检查。
 * 混进数量比对只会让「英文写 July 31、日文写 7月31日」这种正常译法
 * 报出一堆并不存在的漂移。
 */
export function stripDatesAndModels(text: string): string {
  let t = text;
  for (const m of modelTokens(t)) t = t.split(m).join(" ");
  const monthAlt = Object.keys(MONTH_LOOKUP).sort((a, b) => b.length - a.length).join("|");
  t = t
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ")
    .replace(/(?:\d{4}\s*年)?\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*[日号])?/g, " ")
    .replace(/\d{4}\s*年/g, " ")
    .replace(new RegExp(`\\b(?:${monthAlt})\\.?\\s+\\d{1,2}(?:\\s*,)?(?:\\s+\\d{4})?\\b`, "gi"), " ")
    .replace(new RegExp(`\\b\\d{1,2}\\s*(?:o|a|º|ª)?\\s+de\\s+(?:${monthAlt})(?:\\s+de\\s+\\d{4})?`, "gi"), " ")
    .replace(new RegExp(`\\b(?:${monthAlt})\\.?\\s+(?:de\\s+)?\\d{4}\\b`, "gi"), " ");
  return t;
}

/** 抽出一段文本里所有能折成数值的量，用于跨语言比对 */
export function numberSet(text: string, lang: Lang): Set<number> {
  const out = new Set<number>();
  for (const raw of stripDatesAndModels(text).match(NUMBER_TOKEN_RE) ?? []) {
    const tok = raw.trim().replace(/[.,;:]+$/, "");
    if (!tok || !/\d/.test(tok)) continue;
    const v = parseNumber(tok, lang);
    if (v !== null) out.add(v);
  }
  return out;
}

/** 原样保留 token（报错时给人看的），与 numberSet 一一对应 */
export function numberTokens(text: string): string[] {
  return [
    ...new Set(
      (stripDatesAndModels(text).match(NUMBER_TOKEN_RE) ?? [])
        .map((m) => m.trim().replace(/[.,;:]+$/, ""))
        .filter((m) => m && /\d/.test(m))
    ),
  ];
}

/**
 * 小数字的英文写法。
 *
 * 母版写 "the third quarter"，日文译成「第3四半期」—— 译文里多出一个 3，
 * 而母版里那个 3 是个单词，不是数字。这不是漂移，是两种语言的正常习惯。
 * 只用来**压制**误报，不用来制造新的要求。
 */
const SMALL_NUMBER_WORDS: Record<number, string[]> = {
  // 英文的不定冠词就是「一」："within about an hour" ↔ 「約1時間以内に」
  1: ["one", "first", "single", "a", "an"], 2: ["two", "second", "both"], 3: ["three", "third"],
  4: ["four", "fourth"], 5: ["five", "fifth"], 6: ["six", "sixth"], 7: ["seven", "seventh"],
  8: ["eight", "eighth"], 9: ["nine", "ninth"], 10: ["ten", "tenth"],
  11: ["eleven", "eleventh"], 12: ["twelve", "twelfth"],
};

/** 母版是否以英文单词的形式提到了这个数 */
export function spelledOutInEnglish(value: number, masterText: string): boolean {
  const words = SMALL_NUMBER_WORDS[value];
  if (!words) return false;
  const lower = masterText.toLowerCase();
  return words.some((w) => new RegExp(`\\b${w}\\b`).test(lower));
}

// ── 日期 ──────────────────────────────────────────────────────────────────

const MONTHS: Record<string, string[]> = {
  EN_US: ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
  ES_ES: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
  PT_BR: ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"],
};

const MONTH_LOOKUP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (const names of Object.values(MONTHS)) {
    names.forEach((n, i) => {
      m[n] = i + 1;
      m[n.slice(0, 3)] = i + 1; // jan / ene / fev …
    });
  }
  return m;
})();

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * 把各语言的日期写法折成规范键：
 *   完整日期 → `2026-08-01`，只有年月 → `2026-08`，只有月日 → `--08-01`
 *
 * 中日文的「2026年8月1日」与英文的「August 1, 2026」折成同一个键，
 * 译文里换了写法不会被误判成改了日期。
 */
export function dateKeys(text: string): Set<string> {
  const out = new Set<string>();
  const t = stripDiacritics(text.normalize("NFKC").toLowerCase());

  for (const m of t.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    out.add(`${m[1]}-${pad(+m[2])}-${pad(+m[3])}`);
  }
  // 2026年8月1日 / 8月1日 / 2026年8月
  for (const m of t.matchAll(/(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号])?/g)) {
    const [, y, mo, d] = m;
    if (y && d) out.add(`${y}-${pad(+mo)}-${pad(+d)}`);
    else if (y) out.add(`${y}-${pad(+mo)}`);
    else if (d) out.add(`--${pad(+mo)}-${pad(+d)}`);
  }
  const monthAlt = Object.keys(MONTH_LOOKUP).sort((a, b) => b.length - a.length).join("|");
  // August 1, 2026 / Aug 1 / August 2026
  for (const m of t.matchAll(new RegExp(`\\b(${monthAlt})\\.?\\s+(\\d{1,2})(?:\\s*,)?(?:\\s+(\\d{4}))?\\b`, "g"))) {
    const mo = MONTH_LOOKUP[m[1]];
    if (m[3]) out.add(`${m[3]}-${pad(mo)}-${pad(+m[2])}`);
    else out.add(`--${pad(mo)}-${pad(+m[2])}`);
  }
  for (const m of t.matchAll(new RegExp(`\\b(${monthAlt})\\.?\\s+(?:de\\s+)?(\\d{4})\\b`, "g"))) {
    out.add(`${m[2]}-${pad(MONTH_LOOKUP[m[1]])}`);
  }
  // 1 de agosto de 2026 / 1º de agosto
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})\\s*(?:o|a)?\\s+de\\s+(${monthAlt})(?:\\s+de\\s+(\\d{4}))?`, "g"))) {
    const mo = MONTH_LOOKUP[m[2]];
    if (m[3]) out.add(`${m[3]}-${pad(mo)}-${pad(+m[1])}`);
    else out.add(`--${pad(mo)}-${pad(+m[1])}`);
  }
  return out;
}

/**
 * 一个日期键是否被另一组键覆盖。
 *
 * 允许精度降低：来源写 `2026-08-01`，译文写「8月1日」时仍然算一致 ——
 * 少写年份不是失真。但**多出**来源没有的日期一定是问题。
 */
export function dateCovered(key: string, pool: Set<string>): boolean {
  if (pool.has(key)) return true;
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (full) return pool.has(`--${full[2]}-${full[3]}`) || pool.has(`${full[1]}-${full[2]}`);
  const md = /^--(\d{2})-(\d{2})$/.exec(key);
  if (md) return [...pool].some((p) => p.endsWith(`-${md[1]}-${md[2]}`));
  const ym = /^(\d{4})-(\d{2})$/.exec(key);
  if (ym) return [...pool].some((p) => p.startsWith(`${ym[1]}-${ym[2]}`));
  return false;
}

// ── 型号 / 版本号 ─────────────────────────────────────────────────────────

/**
 * 型号与版本标识：GPT-5.6、ARC-AGI-3、v1.2.3、Gemini 3.5。
 *
 * 必须收得紧。宽松写法会把普通句子里的 "at 25"、"July 22" 当成型号，
 * 然后因为「来源里没有这个型号」把忠实的稿子判失败 —— 误报会让闸门失去意义。
 */
const MODEL_RE = new RegExp(
  [
    "\\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z][A-Za-z0-9]*)*-\\d+(?:\\.\\d+)*\\b",
    "\\bv\\d+(?:\\.\\d+)+\\b",
    "\\b[A-Z][a-zA-Z0-9]+\\s\\d+\\.\\d+\\b",
  ].join("|"),
  "g"
);

/** 归一化型号：统一各种连字符，否则来源的 `GPT‑5.5`（U+2011）会与 `GPT-5.5` 判成两个型号 */
export function normModel(s: string): string {
  return s.normalize("NFKC").replace(/[‐-―−﹘﹣－]/g, "-").toLowerCase().replace(/\s+/g, "");
}

/**
 * 「词-数字」形态里并不是型号的那些常用词。
 *
 * `Top-3`、`Part-2`、`Level-4` 都能套上型号的形状，但它们是普通表达。
 * 中文来源写「前三」，英文母版写 "Top-3" —— 当成型号去来源里逐字找，
 * 必然找不到，于是一篇忠实的稿子被判失真。
 */
const NOT_MODEL_PREFIX = new Set([
  "top", "no", "number", "part", "chapter", "page", "section", "figure", "table",
  "tier", "level", "phase", "step", "round", "day", "week", "month", "year",
  "type", "class", "group", "set", "item", "line", "row", "rank", "place", "spot",
  "size", "grade", "stage", "unit", "point", "note", "rule", "case", "test",
]);

export function modelTokens(text: string): string[] {
  return [
    ...new Set(
      (text.match(MODEL_RE) ?? [])
        .map((m) => m.trim().replace(/[.,;:]+$/, ""))
        .filter(Boolean)
        .filter((m) => {
          const prefix = m.split(/[-\s]/)[0].toLowerCase();
          return !NOT_MODEL_PREFIX.has(prefix);
        })
    ),
  ];
}

/**
 * 这个词看起来像不像一个「名字」。
 *
 * 中文来源 → 英文母版这条路上，被翻译过来的普通名词（Intelligence、Index、
 * Analysis）永远不会逐字出现在中文语料里。把它们当专名去查，等于要求
 * 模型不许翻译名词 —— 那不是忠实，那是不可能。
 *
 * 所以单词专名只查三类真正像名字的：登记过的实体、驼峰写法、全大写缩写。
 * 代价：没登记、又没有大小写特征的单词新实体查不到，写在残余风险里。
 */
/**
 * 通用缩写。它们看着像专名，其实是普通词，而且**跨语言会被翻译**：
 * AI→IA、EU→UE。当成实体去比对，「Interactive AI」「Ley de IA」
 * 这类忠实译法就会被判成凭空冒出来的机构。
 */
const COMMON_ACRONYMS = new Set([
  "AI", "IA", "EU", "UE", "US", "USA", "EUA", "UK", "UN", "IT", "API", "RSS",
  "CEO", "CTO", "CFO", "ML", "LLM", "LLMS", "GPU", "CPU", "TPU", "OS", "PC",
  "TV", "FAQ", "PDF", "URL", "HTTP", "JSON", "XML", "SDK", "IDE", "AR", "VR",
  "IOT", "NLP", "OCR", "SaaS", "APP", "RAG", "SOTA", "FP4", "FP8", "PR", "MIT",
  "RL", "SFT", "MOE", "QA", "UI", "UX", "B2B", "B2C", "IPO", "AGI", "ASI",
]);

/**
 * 缩写的复数形式：`PRs` → `PR`、`APIs` → `API`。
 *
 * 来源写「真实 PR 反馈」，母版写 "real PRs" —— 不还原复数，
 * 就会因为语料里没有 "prs" 而把一个来自来源的缩写判成新实体。
 */
export function singularizeAcronym(word: string): string {
  return /^[A-Z0-9]{2,6}s$/.test(word) ? word.slice(0, -1) : word;
}

export function looksLikeName(word: string, isKnownEntity: (w: string) => boolean): boolean {
  const base = singularizeAcronym(word);
  if (isKnownEntity(word) || isKnownEntity(base)) return true;
  if (COMMON_ACRONYMS.has(base.toUpperCase())) return false;
  if (/^[A-Z][a-z0-9]*[A-Z]/.test(word)) return true; // DeepMind / OpenAI / GitHub
  if (/^[A-Z0-9]{2,6}$/.test(base)) return true; // IBM / AWS / MIT
  return false;
}

/**
 * 专名：只认连续两个及以上的大写词（Google DeepMind、Genesis Mission）。
 *
 * 刻意不收单个大写词：英文句首本来就大写，"According"、"The" 会被误当专名。
 * 单词专名几乎总会出现在某个多词短语里，漏掉的代价远小于每篇都误报。
 */
const PROPER_RE =
  /\b[A-Z][a-zA-Z0-9]+(?:\s+(?:of|the|de|da|do)\s+[A-Z][a-zA-Z0-9]+|\s+[A-Z][a-zA-Z0-9]+){1,3}\b/g;

/**
 * 句首常见的功能词。
 *
 * 英文句子开头本来就大写，"The Company"、"According To" 这类会被当成专名，
 * 然后因为中文来源里当然没有 "The"，把一篇完全忠实的稿子判为「引入新实体」。
 * 剥掉开头的功能词后若不足两个大写词，就不是我们要查的专名。
 */
const LEADING_STOPWORDS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "it", "its", "they", "we", "you",
  "in", "on", "at", "for", "with", "from", "and", "but", "or", "as", "by", "to", "of",
  "according", "however", "meanwhile", "additionally", "furthermore", "moreover",
  "while", "when", "where", "which", "who", "what", "why", "how", "if", "although",
  "though", "because", "since", "after", "before", "during", "until", "also", "now",
  "then", "today", "yesterday", "tomorrow", "both", "each", "every", "all", "any",
  "no", "not", "one", "two", "three", "first", "second", "third", "last", "next",
  "new", "other", "some", "many", "most", "more", "less", "several", "such", "there",
  "his", "her", "their", "our", "your", "my",
]);

/** 月份与星期：英文里大写，中文来源里是数字，逐字比对必然对不上 */
const CALENDAR_WORDS = new Set([
  ...Object.keys(MONTH_LOOKUP),
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "mon", "tue", "wed", "thu", "fri", "sat", "sun",
]);

/** 冠词。英语/西语/巴葡都收 —— 译文侧同样要用这条规则 */
const DETERMINERS = new Set([
  "the", "a", "an", "el", "la", "los", "las", "un", "una", "unos", "unas",
  "o", "os", "as", "um", "uma", "uns", "umas",
]);

/**
 * 专名：连续两个及以上的大写词（Google DeepMind），
 * 外加句中出现的单个大写词（"… and Microsoft"）。
 *
 * **不要拿标题喂这个函数。** 英文标题按惯例是 Title Case，
 * "Releases Lyria Music Generation Model" 里每个词都大写，
 * 逐个当专名去来源里找，必然全军覆没。
 */
export function properTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(PROPER_RE) ?? []) {
    let words = raw.trim().split(/\s+/);
    while (words.length && LEADING_STOPWORDS.has(words[0].toLowerCase())) words = words.slice(1);
    while (words.length && LEADING_STOPWORDS.has(words[words.length - 1].toLowerCase())) words = words.slice(0, -1);
    const capitalized = words.filter((w) => /^[A-Z]/.test(w));
    if (capitalized.length < 2) continue;
    const phrase = words.join(" ");
    if (phrase.length >= 4) out.push(phrase);
  }

  /*
   * 句中的单个大写词（"… and Microsoft confirmed"）。
   *
   * 只收**句中**的：英文句子第一个词本来就大写，"Training used 40 million
   * tracks" 里的 "Training" 会被当成机构名。句中大写几乎总是专名，
   * 句首大写几乎总不是 —— 这个区分让单词专名也能查，而不至于满屏误报。
   *
   * 代价说清楚：句首出现且全文只出现一次的单词专名查不到。
   */
  // 日期先挖掉：英文月份是大写的，"on July 31" 里的 July 会被当成机构名，
  // 而中文来源写的是「7 月」—— 一篇完全忠实的稿子就此被判引入新实体
  for (const sentence of stripDatesAndModels(text).split(/[.!?。！？\n]+/)) {
    const words = sentence.trim().split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const w = words[i].replace(/^[("'“‘]+|[)"'”’,;:]+$/g, "");
      if (!/^[A-Z][a-zA-Z0-9]{2,}$/.test(w)) continue;
      const lower = w.toLowerCase();
      if (LEADING_STOPWORDS.has(lower)) continue;
      if (CALENDAR_WORDS.has(lower)) continue;
      // 冠词后面的大写词是被当作专有称谓的普通名词（"the Company"、
      // "el Proyecto"），不是机构名。真正的机构名前面不带冠词
      const prev = words[i - 1].toLowerCase().replace(/[^a-zà-ÿ]/g, "");
      if (DETERMINERS.has(prev)) continue;
      out.push(w);
    }
  }
  return [...new Set(out)];
}
