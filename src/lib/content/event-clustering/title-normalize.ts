/**
 * 标题归一化。
 *
 * 标题只是**匹配特征**，永远不会变成事件事实 —— Fact Pack 里它的 usage
 * 就是 CONTEXT_ONLY。这里做的一切只为让「这两个标题像不像」这个问题
 * 有一个确定性可复现的答案。
 *
 * 刻意不做：stemming、翻译、同义词、实体消歧。那些都需要语言知识，
 * 一旦引入，结果就不再是确定性的，也不再可回放。
 */

/** 有限的站点标题模板后缀。只删这些，不做通用「去品牌」 */
const TITLE_SUFFIXES = [
  "openai",
  "google deepmind",
  "google cloud blog",
  "google",
  "github changelog",
  "the github blog",
  "hugging face",
  "aws machine learning blog",
  "amazon web services",
];

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&apos;": "'", "&#39;": "'", "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–",
};

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

export type NormalizedTitle = {
  normalizedTitle: string;
  titleTokens: string[];
  titleTokenSet: Set<string>;
  titleShingles: Set<string>;
};

/**
 * 版本号、模型名里的连字符与小数点必须保留 ——
 * 把 `GPT-5.6` 切成 `gpt 5 6` 会让它和 `GPT-5` 变得难以区分，
 * 而这两者的差别正是判断「同一件事」的关键。
 */
export function normalizeEventTitle(raw: string | null | undefined): NormalizedTitle {
  const empty = { normalizedTitle: "", titleTokens: [], titleTokenSet: new Set<string>(), titleShingles: new Set<string>() };
  if (!raw || !raw.trim()) return empty;

  let text = decodeEntities(raw).normalize("NFKC").toLowerCase();
  // 破折号、引号、空白统一
  text = text
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

  // 去掉有限的站点后缀（| OpenAI / - Google DeepMind / — GitHub Changelog）
  for (let i = 0; i < 2; i += 1) {
    const m = /^(.*?)\s*[|\-–—:]\s*([^|\-–—:]+)$/.exec(text);
    if (!m) break;
    const tail = m[2].trim();
    if (!TITLE_SUFFIXES.includes(tail)) break;
    text = m[1].trim();
  }

  // 保留字母数字、连字符、小数点、撇号；其余标点变空格
  const cleaned = text
    .replace(/[^\p{L}\p{N}\-.'’ ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = cleaned
    .split(" ")
    .map((t) => t.replace(/^[-.']+|[-.']+$/g, "")) // 去掉首尾悬挂的连字符/句点
    .filter((t) => t.length > 0 && /[\p{L}\p{N}]/u.test(t)); // 纯标点丢弃

  const normalizedTitle = tokens.join(" ");
  const tokenSet = new Set(tokens);
  const shingles = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i += 1) shingles.add(`${tokens[i]} ${tokens[i + 1]}`);

  return { normalizedTitle, titleTokens: tokens, titleTokenSet: tokenSet, titleShingles: shingles };
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
