/**
 * HTML → 可见文本块（契约 §3.0 / §4.1）。
 *
 * ★ 反拼接规则：签名匹配必须逐块进行，绝不在拼接后的全文上匹配。
 *
 * 这是相似度闸门那个坑的同源问题 —— 当初把所有字段 join 成一段再比对，让
 * 「上一条尾巴 7 词 + 下一条开头 8 词」凑成 15 词的假抄袭。搬到这里就是：
 * 导航栏的 "Buy" 接上标题的 "This Domain Registry" 拼出 "buy this domain"。
 *
 * 做法：块间插入 \x00 哨兵，所有签名正则都不含 \x00，物理上跨不过去。
 */

export const BLOCK_SENTINEL = "\x00";

const BLOCK_TAGS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "tr",
  "section", "article", "header", "footer", "main", "nav", "aside",
  "blockquote", "figcaption", "dd", "dt", "pre", "form", "label", "br", "hr",
  "table", "ul", "ol", "dl", "body", "html", "center", "address", "fieldset",
]);

// 内容一律不参与匹配的元素
const DROP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "iframe", "canvas", "head"]);

export type ExtractedText = {
  blocks: string[];
  /** 全部块字符数之和，不含哨兵 */
  textLength: number;
  title: string | null;
  h1: string | null;
  /** <a href> 的原始值，供内链统计 */
  hrefs: string[];
  hasScriptSrc: boolean;
  hasNoscriptContent: boolean;
};

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", mdash: "—", ndash: "–", hellip: "…",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function normalizeBlock(raw: string): string {
  return decodeEntities(raw).replace(/\s+/g, " ").trim();
}

/**
 * 极简 HTML 分块。刻意不引入解析器依赖：我们只需要「可见文本按块级边界切开」，
 * 而且必须对畸形 HTML 稳健 —— 停放页和错误页恰恰最不规范。
 *
 * 属性值（alt / title / aria-*）一律不取：契约 §3.0 明确排除。
 */
export function extractText(html: string): ExtractedText {
  const blocks: string[] = [];
  const hrefs: string[] = [];
  let title: string | null = null;
  let h1: string | null = null;
  let hasScriptSrc = false;
  let hasNoscriptContent = false;

  // 先摘出 title（在剥离 head 之前）
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch) title = normalizeBlock(titleMatch[1]).slice(0, 300) || null;

  const noscriptMatch = /<noscript[^>]*>([\s\S]*?)<\/noscript>/i.exec(html);
  if (noscriptMatch && normalizeBlock(noscriptMatch[1]).length > 20) {
    hasNoscriptContent = true;
  }
  if (/<script[^>]+\bsrc\s*=/i.test(html)) hasScriptSrc = true;

  // 移除注释
  let source = html.replace(/<!--[\s\S]*?-->/g, " ");
  // 移除整段丢弃的元素（含内容）
  for (const tag of DROP_TAGS) {
    source = source.replace(
      new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"),
      " "
    );
    // 自闭合/未闭合兜底
    source = source.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
  }

  let buffer = "";
  let inH1 = false;
  let h1Buffer = "";
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  const flush = () => {
    const text = normalizeBlock(buffer);
    if (text) blocks.push(text);
    buffer = "";
  };

  while ((match = tagRe.exec(source)) !== null) {
    const chunk = source.slice(cursor, match.index);
    buffer += chunk;
    if (inH1) h1Buffer += chunk;
    cursor = tagRe.lastIndex;

    const tag = match[1].toLowerCase();
    const attrs = match[2] ?? "";
    const closing = match[0][1] === "/";

    if (tag === "a" && !closing) {
      const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/i.exec(attrs);
      if (href) hrefs.push((href[2] ?? href[3] ?? href[4] ?? "").trim());
    }
    if (tag === "h1") {
      if (!closing) {
        inH1 = true;
        h1Buffer = "";
      } else if (inH1) {
        inH1 = false;
        if (h1 === null) h1 = normalizeBlock(h1Buffer).slice(0, 300) || null;
      }
    }
    if (BLOCK_TAGS.has(tag)) flush();
  }
  buffer += source.slice(cursor);
  flush();
  if (h1 === null && inH1) h1 = normalizeBlock(h1Buffer).slice(0, 300) || null;

  const textLength = blocks.reduce((sum, b) => sum + b.length, 0);
  return { blocks, textLength, title, h1, hrefs, hasScriptSrc, hasNoscriptContent };
}

/** 仅用于长度统计与调试展示；**不可**用于签名匹配 */
export function joinWithSentinel(blocks: string[]): string {
  return blocks.join(BLOCK_SENTINEL);
}
