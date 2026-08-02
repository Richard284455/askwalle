import { createHash } from "crypto";

import type { DraftLanguage, HotTopicBriefMode } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { AIHOT_BASE_URL } from "../aihot/types";

import { redactAttribution, resolveAttributionMode, buildPublicAttribution, type PublicAttribution } from "./attribution";
import { loadAllLatestMaterial, hotTopicUnitKey } from "./eligibility";
import { publicPath } from "./types";

/**
 * 实时热点榜单卡片的**公开投影**。
 *
 * 卡片上不出现实际来源名称、来源徽标，也不逐条链到 AI HOT ——
 * 出处由页面底部一处统一声明。
 *
 * 这里刻意不返回 topicId、来源名单与 AI HOT 条目地址：
 * 返回了就会进 RSC payload 与序列化 props，靠组件不渲染是拦不住的。
 */

export type TrendingCard = {
  /** 仅用于 React key。由 topic id 派生的不可逆短哈希，不暴露 provider id */
  key: string;
  /** 已发布语言用本站标题；未发布时退回话题名（话题名是内容，不是来源名） */
  headline: string;
  rank: number | null;
  sourceCount: number | null;
  signalCount: number | null;
  capturedAt: Date;
  mode: HotTopicBriefMode;
  /** 简报入口。该语言没有已发布简报的话题根本不进榜单，所以这里恒非空 */
  briefHref: string;
};

export type TrendingListing = {
  cards: TrendingCard[];
  /** 榜单页底部的统一归因 */
  attribution: PublicAttribution;
};

function cardKey(topicId: string): string {
  return createHash("sha256").update(`trending-card:${topicId}`).digest("hex").slice(0, 12);
}

export async function listTrending(locale: DraftLanguage): Promise<TrendingListing | null> {
  const mode = (await resolveAttributionMode()).mode;
  /*
   * 榜单页对应的是 AI HOT 的热点feed 整体，而不是某一条目，
   * 所以这里用 AI HOT 站点地址作为出处链接。
   */
  const attribution = buildPublicAttribution({
    mode, providerUrl: AIHOT_BASE_URL, originalSourceUrl: null,
  });
  if (!attribution) return null;

  const material = await loadAllLatestMaterial();
  if (!material.length) return { cards: [], attribution };

  const unitKeys = material.map((m) => hotTopicUnitKey(m.topicId));
  const families = await prisma.articleFamily.findMany({
    where: { unit_key: { in: unitKeys } },
    include: {
      translations: {
        where: { locale },
        /*
         * 只取**已发布**的记录，并按发布时间倒序。
         *
         * 一个译本可以有多条发布记录（内容更新过、每一版各发一次）。
         * 不排序就是拿数据库返回的任意一条 —— 榜单会随机指向某个旧版本。
         *
         * 最新 revision 尚未发布时，这里自然还是上一版：
         * 卡片继续展示实时榜单数据，链接则指向最近**已发布**的那一版，
         * 草稿绝不出现在公开面上。
         */
        include: { publications: { where: { status: "PUBLISHED" }, orderBy: { published_at: "desc" } } },
      },
    },
  });
  const byKey = new Map(families.map((f) => [f.unit_key, f]));

  const cards: TrendingCard[] = [];
  for (const m of material) {
    const fam = byKey.get(hotTopicUnitKey(m.topicId));
    const pub = fam?.translations[0]?.publications[0];
    /*
     * **该语言没有已发布简报的话题不上榜。**
     *
     * 以前这里会退回热点本身的标题，而那是 AI HOT 给的原语言（中文）标题 ——
     * 英文榜单上于是混进中文卡片，点进去还没有页面。
     * 公开面上的每一行文字都该是我们自己产出的、这一语言的内容；
     * 拿不到就先不上榜，而不是把信源的原文标题当占位符印出去。
     *
     * 这不影响「最新 revision 未发布时卡片仍显示实时数据」：
     * 那种话题有已发布的旧版，照常上榜，名次与计数取当前快照。
     */
    if (!pub) continue;

    const rev = await prisma.articleRevision.findUnique({
      where: { id: pub.revision_id }, select: { headline: true },
    });
    if (!rev?.headline) continue;
    // 标题同样过一遍剔除：早期标题里带过品牌名
    const headline = redactAttribution(rev.headline, {
      sourceNames: m.sourceNames, title: rev.headline, providerName: "AI HOT", locale,
    });

    cards.push({
      key: cardKey(m.topicId),
      headline,
      // 掉出当前榜单的话题 rank 为 null —— 不显示名次徽标，而不是挂着上次的名次
      rank: m.rank,
      sourceCount: m.sourceCount,
      signalCount: m.signalCount,
      capturedAt: m.capturedAt,
      mode: m.mode,
      briefHref: pub.path,
    });
  }
  /*
   * 当前在榜的按名次排，掉出榜单的排在后面、按最近抓取时间倒序。
   * 把无名次的当成 999 混排会让它们和真实名次交错，看不出哪些是「现在的榜」。
   */
  cards.sort((a, b) => {
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    return b.capturedAt.getTime() - a.capturedAt.getTime();
  });
  return { cards, attribution };
}

/** 简报详情路径（供卡片与 sitemap 复用） */
export function trendingBriefPath(locale: DraftLanguage, slug: string): string {
  return publicPath({ locale, contentForm: "HOT_TOPIC_BRIEF", slug });
}
