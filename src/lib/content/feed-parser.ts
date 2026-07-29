/**
 * RSS 2.0 / Atom 解析。
 *
 * 手写而不引依赖：feed 的结构很小，且我们只取溯源必需的六个字段。
 * 换来的代价是必须自己处理 CDATA、实体、命名空间前缀 —— 下面逐个处理。
 *
 * 解析器**不做任何判断**：拿到什么给什么，取舍留给上层。
 */

export type FeedItem = {
  title: string;
  link: string | null;
  /** RSS <guid> / Atom <id>：站点自己的唯一标识，可能不是 URL */
  guid: string | null;
  author: string | null;
  publishedAt: Date | null;
  /** <description> / <summary>，可能含 HTML */
  excerpt: string | null;
  /** <content:encoded> / Atom <content>，可能含 HTML */
  content: string | null;
};

export type ParsedFeed = {
  kind: "rss" | "atom";
  title: string | null;
  homepage: string | null;
  items: FeedItem[];
};

export class FeedParseError extends Error {}

// ── 基础工具 ────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  hellip: "…", mdash: "—", ndash: "–",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      // 代理区与超出 Unicode 范围的码点直接原样保留，别造出乱码
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** 取出元素文本：优先 CDATA，其次解实体 */
function textOf(xml: string): string {
  const cdata = [...xml.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)];
  if (cdata.length) return cdata.map((m) => m[1]).join("").trim();
  return decodeEntities(xml.replace(/<[^>]*>/g, "")).trim();
}

/** 抓取第一个匹配的子元素完整片段（含标签），支持命名空间前缀 */
function childRaw(scope: string, name: string): string | null {
  const re = new RegExp(
    `<((?:[A-Za-z0-9_.-]+:)?${name})(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</\\1\\s*>)`,
    "i"
  );
  const m = re.exec(scope);
  return m ? (m[3] ?? "") : null;
}

function childText(scope: string, name: string): string | null {
  const raw = childRaw(scope, name);
  if (raw === null) return null;
  const t = textOf(raw);
  return t.length ? t : null;
}

/** 读某个子元素的属性（Atom 的 <link href> / <category term>） */
function childAttr(scope: string, name: string, attr: string, filter?: RegExp): string | null {
  const re = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${name}(\\s[^>]*?)?/?>`, "gi");
  for (const m of scope.matchAll(re)) {
    const attrs = m[1] ?? "";
    if (filter && !filter.test(attrs)) continue;
    const a = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs);
    if (a) return decodeEntities(a[1]).trim();
  }
  return null;
}

/** 切出所有同名元素的完整片段 */
function blocks(xml: string, name: string): string[] {
  const re = new RegExp(
    `<((?:[A-Za-z0-9_.-]+:)?${name})(?:\\s[^>]*)?>([\\s\\S]*?)</\\1\\s*>`,
    "gi"
  );
  return [...xml.matchAll(re)].map((m) => m[2]);
}

/**
 * 日期解析：RFC 822（RSS）与 ISO 8601（Atom）都交给 Date 构造函数，
 * 解不出来就返回 null —— 宁可没有时间，也不要编一个。
 */
export function parseFeedDate(input: string | null): Date | null {
  if (!input) return null;
  const d = new Date(input.trim());
  if (Number.isNaN(d.getTime())) return null;
  // 明显不合理的时间当作无效（有些源会写 1970 或未来几十年）
  const year = d.getUTCFullYear();
  if (year < 1995 || year > new Date().getUTCFullYear() + 2) return null;
  return d;
}

// ── 主入口 ─────────────────────────────────────────────────────────────

export function parseFeed(xml: string): ParsedFeed {
  // 去掉注释，避免注释里的标签被当成内容
  const doc = xml.replace(/<!--[\s\S]*?-->/g, "");

  const isAtom = /<(?:[A-Za-z0-9_.-]+:)?feed[\s>]/i.test(doc);
  const isRss = /<(?:[A-Za-z0-9_.-]+:)?rss[\s>]/i.test(doc) || /<(?:[A-Za-z0-9_.-]+:)?channel[\s>]/i.test(doc);
  if (!isAtom && !isRss) {
    throw new FeedParseError("既不是 RSS 也不是 Atom（未找到 <rss>/<channel>/<feed>）");
  }

  return isAtom ? parseAtom(doc) : parseRss(doc);
}

function parseRss(doc: string): ParsedFeed {
  const channel = blocks(doc, "channel")[0] ?? doc;
  // channel 头部的 title/link 不能被 item 里的抢走：只看第一个 <item> 之前的部分
  const firstItem = channel.search(/<(?:[A-Za-z0-9_.-]+:)?item[\s>]/i);
  const head = firstItem === -1 ? channel : channel.slice(0, firstItem);

  const items = blocks(channel, "item").map((raw): FeedItem => {
    const link = childText(raw, "link");
    const guid = childText(raw, "guid");
    return {
      title: childText(raw, "title") ?? "(无标题)",
      link,
      guid,
      author:
        childText(raw, "creator") ?? // dc:creator，最常见
        childText(raw, "author"),
      publishedAt: parseFeedDate(childText(raw, "pubDate") ?? childText(raw, "date")),
      excerpt: childText(raw, "description"),
      // content:encoded 才是全文，description 往往只是摘要
      content: childText(raw, "encoded"),
    };
  });

  return {
    kind: "rss",
    title: childText(head, "title"),
    homepage: childText(head, "link"),
    items,
  };
}

function parseAtom(doc: string): ParsedFeed {
  const feed = blocks(doc, "feed")[0] ?? doc;
  const firstEntry = feed.search(/<(?:[A-Za-z0-9_.-]+:)?entry[\s>]/i);
  const head = firstEntry === -1 ? feed : feed.slice(0, firstEntry);

  const items = blocks(feed, "entry").map((raw): FeedItem => {
    // Atom 的 link 是属性；优先 rel="alternate"，其次第一个没有 rel 的
    const link =
      childAttr(raw, "link", "href", /rel\s*=\s*["']alternate["']/i) ??
      childAttr(raw, "link", "href", /^(?!.*\brel\s*=)/i) ??
      childAttr(raw, "link", "href");
    const authorBlock = blocks(raw, "author")[0] ?? "";
    return {
      title: childText(raw, "title") ?? "(无标题)",
      link,
      guid: childText(raw, "id"),
      author: authorBlock ? childText(authorBlock, "name") : null,
      publishedAt: parseFeedDate(childText(raw, "published") ?? childText(raw, "updated")),
      excerpt: childText(raw, "summary"),
      content: childText(raw, "content"),
    };
  });

  return {
    kind: "atom",
    title: childText(head, "title"),
    homepage:
      childAttr(head, "link", "href", /rel\s*=\s*["']alternate["']/i) ??
      childAttr(head, "link", "href"),
    items,
  };
}

/**
 * HTML → 纯文本。与探针的 text-blocks 分工不同：那边要判活，这边要留存正文快照。
 * 去掉脚本与样式，块级标签转换行，其余去标签解实体。
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}
