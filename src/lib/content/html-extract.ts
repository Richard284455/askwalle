import { parseDocument } from "htmlparser2";
import { findAll, findOne, getAttributeValue, isTag, isText } from "domutils";
import type { AnyNode, Element } from "domhandler";

import { parseFeedDate } from "@/lib/content/feed-parser";

/**
 * 文章页的**有限**提取。
 *
 * 这里的目标不是「把网页存下来」，而是「留下足以核验一条事实的最小证据」：
 * 标题、作者、时间、canonical、可见正文的长度与指纹、以及一段摘要。
 * 完整 HTML 与完整正文只在内存里短暂存在，函数返回后即可丢弃 —— 长期保存
 * 第三方正文既没必要，也不是我们有权做的事。
 *
 * 不做浏览器渲染、不执行 JavaScript、不登录、不绕付费墙、不绕反爬。
 * 拿不到就如实记 CONTENT_INSUFFICIENT，不去想办法「弄到」。
 */

export const EXCERPT_MAX_CHARS = 2_000;
export const MAX_HEADINGS = 20;
/** 少于这个字符数视为「没有真正的正文」（应用壳、跳转页、纯导航） */
export const MIN_VISIBLE_TEXT_CHARS = 300;

/** 这些元素的文本永远不算正文 —— 它们不是文章，是脚手架 */
const STRIPPED_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "nav",
  "footer",
  "header",
  "aside",
  "form",
]);

/** 块级元素：文本拼接时要断行，否则标题会和正文粘成一个词 */
const BLOCK_TAGS = new Set([
  "address", "article", "blockquote", "br", "dd", "div", "dl", "dt",
  "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li",
  "main", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul",
]);

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export type ExtractedHeading = { level: number; text: string };

export type ExtractedArticle = {
  canonicalUrl: string | null;
  title: string | null;
  author: string | null;
  publishedAt: Date | null;
  modifiedAt: Date | null;
  language: string | null;
  /** 规范化后的可见正文。**调用方用完即弃，不得落库** */
  visibleText: string;
  visibleTextLength: number;
  /** 至多 EXCERPT_MAX_CHARS 字符 */
  excerpt: string;
  headings: ExtractedHeading[];
  /** 只放**已提取字段**，不是页面原文 */
  metadata: Record<string, string>;
  /** 正文取自哪一层，用于判断提取质量 */
  container: "article" | "main" | "body";
};

/** 只接受 http/https 的绝对化；其它协议（javascript:、data: 等）一律丢弃 */
function absoluteHttpUrl(href: string | undefined, baseUrl: string): string | null {
  if (!href || !href.trim()) return null;
  try {
    const url = new URL(href.trim(), baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : null;
}

/**
 * 收集可见文本。
 *
 * 用 DOM 遍历而不是正则：正则改不动嵌套结构，遇到属性里带 `<` 的页面就会
 * 把正文切碎，也没法可靠地把 script/style 整段排除。
 */
function collectVisibleText(node: AnyNode, out: string[]): void {
  if (isText(node)) {
    out.push(node.data);
    return;
  }
  if (!isTag(node)) return;
  const tag = node.tagName.toLowerCase();
  if (STRIPPED_TAGS.has(tag)) return;
  const block = BLOCK_TAGS.has(tag);
  if (block) out.push("\n");
  for (const child of node.children) collectVisibleText(child, out);
  if (block) out.push("\n");
}

function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function metaContent(doc: AnyNode[], names: string[]): string | null {
  for (const name of names) {
    const lower = name.toLowerCase();
    const found = findOne(
      (el) =>
        el.tagName.toLowerCase() === "meta" &&
        [getAttributeValue(el, "property"), getAttributeValue(el, "name"), getAttributeValue(el, "itemprop")]
          .some((v) => typeof v === "string" && v.toLowerCase() === lower),
      doc,
      true
    );
    const value = clean(found ? getAttributeValue(found, "content") : null);
    if (value) return value;
  }
  return null;
}

/** JSON-LD：只取四个字段，其余整块丢弃。解析失败不影响其它提取路径 */
function readJsonLd(doc: AnyNode[]): {
  headline: string | null;
  author: string | null;
  datePublished: string | null;
  dateModified: string | null;
} {
  const result = { headline: null, author: null, datePublished: null, dateModified: null } as {
    headline: string | null; author: string | null; datePublished: string | null; dateModified: string | null;
  };
  const scripts = findAll(
    (el) =>
      el.tagName.toLowerCase() === "script" &&
      (getAttributeValue(el, "type") ?? "").toLowerCase().trim() === "application/ld+json",
    doc
  );

  const authorOf = (value: unknown): string | null => {
    if (typeof value === "string") return clean(value);
    if (Array.isArray(value)) {
      const names = value.map(authorOf).filter((n): n is string => Boolean(n));
      return names.length ? names.join(", ") : null;
    }
    if (value && typeof value === "object") return clean((value as { name?: unknown }).name as string);
    return null;
  };

  const absorb = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) absorb(entry);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record["@graph"])) absorb(record["@graph"]);
    result.headline ??= clean(record.headline as string) ?? clean(record.name as string);
    result.author ??= authorOf(record.author);
    result.datePublished ??= clean(record.datePublished as string);
    result.dateModified ??= clean(record.dateModified as string);
  };

  for (const script of scripts) {
    const raw = script.children.map((c) => (isText(c) ? c.data : "")).join("");
    if (!raw.trim()) continue;
    try {
      absorb(JSON.parse(raw));
    } catch {
      // 站点的 JSON-LD 经常带尾逗号或注释。解析不了就跳过这一块，
      // og/meta 与 <article> 路径仍然有效 —— 不因为一段坏结构判整页失败。
    }
  }
  return result;
}

function headingsOf(root: AnyNode[]): ExtractedHeading[] {
  const found = findAll((el) => HEADING_TAGS.has(el.tagName.toLowerCase()), root);
  const out: ExtractedHeading[] = [];
  for (const el of found) {
    if (out.length >= MAX_HEADINGS) break;
    const parts: string[] = [];
    collectVisibleText(el, parts);
    const text = clean(parts.join(" "));
    if (text) out.push({ level: Number(el.tagName.slice(1)), text: text.slice(0, 200) });
  }
  return out;
}

/**
 * 提取顺序（越靠前越可信）：
 *   canonical → OG/Twitter → JSON-LD → <article> → <main> → body
 * 正文容器同理：<article> 最准，body 是最后的兜底。
 */
export function extractArticle(html: string, baseUrl: string): ExtractedArticle {
  const document = parseDocument(html);
  const nodes = document.children;

  // ① canonical
  const canonicalEl = findOne(
    (el) =>
      el.tagName.toLowerCase() === "link" &&
      (getAttributeValue(el, "rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"),
    nodes,
    true
  );
  const canonicalUrl =
    absoluteHttpUrl(canonicalEl ? getAttributeValue(canonicalEl, "href") : undefined, baseUrl) ??
    absoluteHttpUrl(metaContent(nodes, ["og:url"]) ?? undefined, baseUrl);

  // ② Open Graph / Twitter
  const ogTitle = metaContent(nodes, ["og:title", "twitter:title"]);
  const ogAuthor = metaContent(nodes, ["article:author", "author", "twitter:creator"]);
  const ogPublished = metaContent(nodes, ["article:published_time", "datePublished", "date"]);
  const ogModified = metaContent(nodes, ["article:modified_time", "dateModified"]);
  const ogLocale = metaContent(nodes, ["og:locale"]);
  const ogDescription = metaContent(nodes, ["og:description", "twitter:description", "description"]);

  // ③ JSON-LD
  const jsonLd = readJsonLd(nodes);

  // <title> 是最后的兜底
  const titleEl = findOne((el) => el.tagName.toLowerCase() === "title", nodes, true);
  const docTitle = titleEl ? clean(titleEl.children.map((c) => (isText(c) ? c.data : "")).join("")) : null;

  const htmlEl = findOne((el) => el.tagName.toLowerCase() === "html", nodes, true);
  const language =
    clean(htmlEl ? getAttributeValue(htmlEl, "lang") : null) ?? (ogLocale ? ogLocale.replace("_", "-") : null);

  // ④⑤⑥ 正文容器
  const articleEl = findOne((el) => el.tagName.toLowerCase() === "article", nodes, true);
  const mainEl = findOne((el) => el.tagName.toLowerCase() === "main", nodes, true);
  const bodyEl = findOne((el) => el.tagName.toLowerCase() === "body", nodes, true);

  const pick = (el: Element | null): string => {
    if (!el) return "";
    const parts: string[] = [];
    collectVisibleText(el, parts);
    return normalizeText(parts.join(""));
  };

  let container: ExtractedArticle["container"] = "body";
  let visibleText = pick(articleEl);
  if (visibleText.length >= MIN_VISIBLE_TEXT_CHARS) {
    container = "article";
  } else {
    const mainText = pick(mainEl);
    if (mainText.length >= MIN_VISIBLE_TEXT_CHARS) {
      container = "main";
      visibleText = mainText;
    } else {
      const bodyText = pick(bodyEl ?? null) || normalizeText(nodes.map((n) => { const p: string[] = []; collectVisibleText(n, p); return p.join(""); }).join(""));
      // 三层都不够长时，取最长的那个如实上报（后续判 CONTENT_INSUFFICIENT）
      const best = [
        { key: "article" as const, text: visibleText },
        { key: "main" as const, text: mainText },
        { key: "body" as const, text: bodyText },
      ].reduce((a, b) => (b.text.length > a.text.length ? b : a));
      container = best.key;
      visibleText = best.text;
    }
  }

  const headingRoot = (container === "article" && articleEl) || (container === "main" && mainEl) || bodyEl;
  const headings = headingsOf(headingRoot ? [headingRoot] : nodes);

  const title = ogTitle ?? jsonLd.headline ?? docTitle;
  const author = ogAuthor ?? jsonLd.author;
  const publishedAt = parseFeedDate(ogPublished ?? jsonLd.datePublished);
  const modifiedAt = parseFeedDate(ogModified ?? jsonLd.dateModified);

  // metadata 只放已提取字段，且逐项截断 —— 它是索引，不是页面副本
  const metadata: Record<string, string> = {};
  const put = (key: string, value: string | null, max = 300) => {
    if (value) metadata[key] = value.slice(0, max);
  };
  put("canonical", canonicalUrl, 2_000);
  put("ogTitle", ogTitle);
  put("ogDescription", ogDescription, 500);
  put("ogAuthor", ogAuthor);
  put("ogPublished", ogPublished);
  put("ogModified", ogModified);
  put("jsonLdHeadline", jsonLd.headline);
  put("jsonLdAuthor", jsonLd.author);
  put("jsonLdPublished", jsonLd.datePublished);
  put("jsonLdModified", jsonLd.dateModified);
  put("docTitle", docTitle);
  put("container", container);

  return {
    canonicalUrl,
    title,
    author,
    publishedAt,
    modifiedAt,
    language,
    visibleText,
    visibleTextLength: visibleText.length,
    excerpt: visibleText.slice(0, EXCERPT_MAX_CHARS),
    headings,
    metadata,
    container,
  };
}
