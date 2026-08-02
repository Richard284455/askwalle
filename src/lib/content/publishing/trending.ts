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
  /** 简报入口；该语言未发布时为 null */
  briefHref: string | null;
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
        include: { publications: { where: { status: "PUBLISHED" } } },
      },
    },
  });
  const byKey = new Map(families.map((f) => [f.unit_key, f]));

  const cards: TrendingCard[] = [];
  for (const m of material) {
    const fam = byKey.get(hotTopicUnitKey(m.topicId));
    const pub = fam?.translations[0]?.publications[0];
    let headline = m.title;
    if (pub) {
      const rev = await prisma.articleRevision.findUnique({
        where: { id: pub.revision_id }, select: { headline: true },
      });
      if (rev?.headline) {
        // 标题同样过一遍剔除：早期标题里带过品牌名
        headline = redactAttribution(rev.headline, {
          sourceNames: m.sourceNames, title: rev.headline, providerName: "AI HOT",
        });
      }
    }
    cards.push({
      key: cardKey(m.topicId),
      headline,
      rank: m.rank,
      sourceCount: m.sourceCount,
      signalCount: m.signalCount,
      capturedAt: m.capturedAt,
      mode: m.mode,
      briefHref: pub ? pub.path : null,
    });
  }
  cards.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
  return { cards, attribution };
}

/** 简报详情路径（供卡片与 sitemap 复用） */
export function trendingBriefPath(locale: DraftLanguage, slug: string): string {
  return publicPath({ locale, contentForm: "HOT_TOPIC_BRIEF", slug });
}
