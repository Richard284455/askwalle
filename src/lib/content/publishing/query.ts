import type { DraftLanguage } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { httpUrlOrNull } from "../aihot/types";

import { absoluteUrl, LOCALE_HREFLANG, LOCALES, publicPath, type ChecklistKey } from "./types";

/**
 * 公开页的数据读取。
 *
 * **只返回真正已发布的内容。** 草稿、退回稿、未批准稿一律读不到 ——
 * 「不可公开访问」不能靠前端不加链接来实现，得让查询本身取不到。
 *
 * 也**只**返回页面要展示的字段：QA 详情、prompt、provider 载荷、
 * 内部状态一概不出现在返回值里，从源头上杜绝泄露。
 */

export type PublishedPage = {
  locale: DraftLanguage;
  path: string;
  canonical: string;
  headline: string;
  summary: string;
  body: string;
  sections: { label: string; body: string }[] | null;
  contentForm: string;
  categorySlug: string | null;
  /** 归因 */
  attributionName: string;
  attributionUrl: string;
  originalSourceName: string | null;
  originalSourceUrl: string | null;
  sourcePublishedAt: Date | null;
  sitePublishedAt: Date;
  /** 四语言互链：只包含**同样已发布**的语言 */
  alternates: { locale: DraftLanguage; hreflang: string; href: string }[];
  xDefault: string | null;
};

async function buildAlternates(familyId: number) {
  const pubs = await prisma.articlePublication.findMany({
    where: { status: "PUBLISHED", translation: { family_id: familyId } },
    select: { locale: true, path: true },
  });
  const published = new Set(pubs.map((p) => p.locale));
  const alternates = LOCALES.filter((l) => published.has(l)).map((locale) => ({
    locale,
    hreflang: LOCALE_HREFLANG[locale],
    href: absoluteUrl(
      pubs.find((p) => p.locale === locale)!.path
    ),
  }));
  // x-default 指向 en-US；英文没发布就不给 x-default，而不是随便指一个
  const en = pubs.find((p) => p.locale === "EN_US");
  return { alternates, xDefault: en ? absoluteUrl(en.path) : null };
}

/**
 * 从正文里还原 `## 栏目名` 结构。
 *
 * 只在正文确实带这种标记时才生效；没有标记就返回 null，走整段正文渲染。
 * 导语（第一个 `##` 之前的部分）会并进第一个栏目之前单独保留 —— 丢掉它
 * 等于把日报的开场白吞了。
 */
export function deriveSections(body: string): { label: string; body: string }[] | null {
  if (!/^##\s+\S/m.test(body)) return null;
  const parts = body.split(/^##\s+(.+)$/m);
  // split 后形如 [导语, 标题1, 正文1, 标题2, 正文2, …]
  const lead = parts[0]?.trim();
  const out: { label: string; body: string }[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const label = parts[i].trim();
    const text = parts[i + 1].trim();
    if (label) out.push({ label, body: text });
  }
  if (!out.length) return null;
  if (lead) out.unshift({ label: "", body: lead });
  return out;
}

async function loadByPath(locale: DraftLanguage, path: string): Promise<PublishedPage | null> {
  const pub = await prisma.articlePublication.findUnique({
    where: { locale_path: { locale, path } },
    include: { translation: { include: { family: true } } },
  });
  if (!pub || pub.status !== "PUBLISHED") return null;

  const revision = await prisma.articleRevision.findUnique({ where: { id: pub.revision_id } });
  if (!revision) return null;

  const family = pub.translation.family;
  const { alternates, xDefault } = await buildAlternates(family.id);

  const stored = Array.isArray(revision.sections_json)
    ? (revision.sections_json as unknown as { label: string; body: string }[])
    : null;
  /*
   * 译文侧没有独立的 sections：翻译时输入的是母版正文，产出也是一整段正文，
   * 里面的 `## 栏目名` 是母版留下的标记。不还原它，四种语言里就只有英文
   * 有栏目结构，其余三种会把 "## Noticias de la industria" 当普通文字印出来。
   *
   * 正文才是权威内容，栏目是它的呈现方式，所以在读取层还原而不是回头改
   * revision —— revision 一旦冻结就不该再动。
   */
  // 正文优先：它同时含导语与全部栏目，是完整产出。
  // 只用 sections_json 的话，英文页会把导语整段丢掉（导语不在 sections 里）
  const sections = deriveSections(revision.body) ?? (stored?.length ? stored : null);

  return {
    locale, path,
    canonical: absoluteUrl(path),
    headline: revision.headline,
    summary: revision.summary,
    body: revision.body,
    sections,
    contentForm: family.content_form,
    categorySlug: family.category_slug,
    attributionName: family.attribution_name,
    attributionUrl: family.attribution_url,
    originalSourceName: family.original_source_name,
    // 再验一次链接：数据库里存的是发布当时合法的值，渲染前仍要确认
    originalSourceUrl: httpUrlOrNull(family.original_source_url),
    sourcePublishedAt: family.source_published_at,
    sitePublishedAt: pub.published_at,
    alternates, xDefault,
  };
}

export function getUpdatePage(locale: DraftLanguage, slug: string) {
  return loadByPath(locale, publicPath({ locale, contentForm: "MULTILINGUAL_NEWS_BRIEF", slug }));
}

export function getTrendingPage(locale: DraftLanguage, slug: string) {
  return loadByPath(locale, publicPath({ locale, contentForm: "HOT_TOPIC_BRIEF", slug }));
}

export function getDailyPage(locale: DraftLanguage, date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Promise.resolve(null);
  return loadByPath(locale, publicPath({ locale, contentForm: "DAILY_BRIEF", slug: "", reportDate: date }));
}

/** sitemap 用：只收已发布页面 */
export async function listPublishedPaths(): Promise<{ path: string; lastModified: Date }[]> {
  const pubs = await prisma.articlePublication.findMany({
    where: { status: "PUBLISHED" },
    select: { path: true, published_at: true, updated_at: true },
    orderBy: { published_at: "desc" },
  });
  return pubs.map((p) => ({ path: p.path, lastModified: p.updated_at ?? p.published_at }));
}

export type { ChecklistKey };
