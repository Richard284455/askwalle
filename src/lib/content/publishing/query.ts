import type { DraftLanguage, HotTopicBriefMode } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import {
  buildPublicAttribution, redactAttribution, resolveAttributionMode,
  type PublicAttribution, type RedactionContext,
} from "./attribution";
import { absoluteUrl, LOCALE_HREFLANG, LOCALES, publicPath, type ChecklistKey } from "./types";

/**
 * 公开页的数据读取。
 *
 * 两条硬约束：
 *   1. **只返回真正已发布的内容。** 草稿、退回稿、未批准稿一律读不到 ——
 *      「不可公开访问」不能靠前端不加链接来实现，得让查询本身取不到。
 *   2. **返回值里没有实际来源名称与地址。** 不是「有但不渲染」，是根本不放进来。
 *      放进来再靠组件不显示，名字仍会出现在 RSC payload、序列化 props 与页面源码里。
 *
 * QA 详情、prompt、provider 载荷、内部状态同样一概不出现。
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
  hotTopicMode: HotTopicBriefMode | null;
  /** 本站发布时间。**来源发布时间不带来源名**，只是一个日期 */
  sourcePublishedAt: Date | null;
  sitePublishedAt: Date;
  /** 底部统一归因。这是页面上唯一的出处声明 */
  attribution: PublicAttribution;
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
    href: absoluteUrl(pubs.find((p) => p.locale === locale)!.path),
  }));
  const en = pubs.find((p) => p.locale === "EN_US");
  return { alternates, xDefault: en ? absoluteUrl(en.path) : null };
}

/**
 * 从正文里还原 `## 栏目名` 结构。
 *
 * 只在正文确实带这种标记时才生效；没有标记就返回 null，走整段正文渲染。
 * 导语（第一个 `##` 之前的部分）单独保留 —— 丢掉它等于把日报的开场白吞了。
 */
export function deriveSections(body: string): { label: string; body: string }[] | null {
  if (!/^##\s+\S/m.test(body)) return null;
  const parts = body.split(/^##\s+(.+)$/m);
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

/**
 * 收集该内容单元的**实际**来源名称。
 *
 * 只用于渲染层剔除，**不进返回值**。热点还要带上榜单的来源名单 ——
 * 那份名单整段出现在早期生成的正文里。
 */
async function redactionNames(family: {
  original_source_name: string | null; hot_topic_snapshot_id: number | null;
}): Promise<string[]> {
  const names = new Set<string>();
  if (family.original_source_name) names.add(family.original_source_name);
  if (family.hot_topic_snapshot_id) {
    const snap = await prisma.aihotHotTopicSnapshot.findUnique({
      where: { id: family.hot_topic_snapshot_id },
      select: { source_names_json: true, source_name: true },
    });
    if (snap?.source_name) names.add(snap.source_name);
    const list = Array.isArray(snap?.source_names_json) ? (snap!.source_names_json as string[]) : [];
    for (const n of list) if (n) names.add(n);
  }
  return [...names];
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
  const mode = (await resolveAttributionMode()).mode;
  const attribution = buildPublicAttribution({
    mode,
    providerUrl: family.attribution_url,
    originalSourceUrl: family.original_source_url,
  });
  // AI HOT 链接不合法 → 没有合法出处可声明，这一页不该对外呈现
  if (!attribution) return null;

  const ctx: RedactionContext = {
    sourceNames: await redactionNames(family),
    title: family.slug.replace(/-/g, " "),
    providerName: family.attribution_name,
    // 中性替换词跟着页面语言走，否则日语正文里会嵌进英文
    locale,
  };
  // 标题里的实体是事件主体，用真实标题做豁免依据
  ctx.title = `${revision.headline} ${ctx.title}`;

  const headline = redactAttribution(revision.headline, ctx);
  const summary = redactAttribution(revision.summary, ctx);
  const body = redactAttribution(revision.body, ctx);

  const { alternates, xDefault } = await buildAlternates(family.id);

  return {
    locale, path,
    canonical: absoluteUrl(path),
    headline, summary, body,
    sections: deriveSections(body),
    contentForm: family.content_form,
    categorySlug: family.category_slug,
    hotTopicMode: family.hot_topic_mode,
    sourcePublishedAt: family.source_published_at,
    sitePublishedAt: pub.published_at,
    attribution,
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

// ── 列表页 ────────────────────────────────────────────────────────────────

/**
 * 列表卡片的公开投影。
 *
 * 与详情页同一套纪律：**没有** originalSourceName / originalSourceUrl /
 * attributionName。返回了就会进 RSC payload，靠组件不渲染是拦不住的。
 */
export type PublishedCard = {
  /** 仅用于 React key 与跳转 */
  path: string;
  headline: string;
  summary: string;
  categorySlug: string | null;
  hotTopicMode: HotTopicBriefMode | null;
  sourcePublishedAt: Date | null;
  sitePublishedAt: Date;
};

async function listPublished(
  locale: DraftLanguage, contentForm: string, limit: number
): Promise<PublishedCard[]> {
  const pubs = await prisma.articlePublication.findMany({
    where: { status: "PUBLISHED", locale, translation: { family: { content_form: contentForm as never } } },
    orderBy: { published_at: "desc" },
    take: limit,
    include: { translation: { include: { family: true } } },
  });

  const cards: PublishedCard[] = [];
  for (const pub of pubs) {
    const revision = await prisma.articleRevision.findUnique({
      where: { id: pub.revision_id }, select: { headline: true, summary: true },
    });
    if (!revision) continue;
    const family = pub.translation.family;
    /*
     * 标题与摘要同样过一遍剔除。
     * 早期生成的稿子里带过发布者名，列表页也是公开面 ——
     * 只在详情页剔除，等于把同一个名字换个地方展示出去。
     */
    const ctx: RedactionContext = {
      sourceNames: await redactionNames(family),
      title: `${revision.headline} ${family.slug.replace(/-/g, " ")}`,
      providerName: family.attribution_name,
      locale,
    };
    cards.push({
      path: pub.path,
      headline: redactAttribution(revision.headline, ctx),
      summary: redactAttribution(revision.summary, ctx),
      categorySlug: family.category_slug,
      hotTopicMode: family.hot_topic_mode,
      sourcePublishedAt: family.source_published_at,
      sitePublishedAt: pub.published_at,
    });
  }
  return cards;
}

/** 精选资讯列表 */
export function listUpdates(locale: DraftLanguage, limit = 50) {
  return listPublished(locale, "MULTILINGUAL_NEWS_BRIEF", limit);
}

/** 日报列表。路径里带日期，卡片按发布时间倒序 */
export function listDailyBriefings(locale: DraftLanguage, limit = 60) {
  return listPublished(locale, "DAILY_BRIEF", limit);
}

/** 列表页底部的统一归因。与详情页同一处声明，不逐条挂来源 */
export async function listingAttribution(providerUrl: string): Promise<PublicAttribution | null> {
  const mode = (await resolveAttributionMode()).mode;
  return buildPublicAttribution({ mode, providerUrl, originalSourceUrl: null });
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
