import type { DraftLanguage, HotTopicBriefMode } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { loadAllLatestMaterial, hotTopicUnitKey } from "./eligibility";
import { publicPath } from "./types";

/**
 * 实时热点榜单卡片。
 *
 * 卡片与简报是**两种内容**：
 *   - 卡片是 AI HOT 榜单的实时投影，字段全部来自 API，本站不加工；
 *   - 简报是本站原创的多语言文章，要经人工审核才发布。
 *
 * 所以卡片始终展示（哪怕简报还没发），而「阅读简报」入口只在该语言
 * **确实已发布**时才出现 —— 指向未发布页面的入口就是死链。
 */

export type TrendingCard = {
  topicId: string;
  /** AI HOT 给出的原始标题。卡片如实展示信源自己的措辞 */
  sourceTitle: string;
  /** 该语言已发布简报的标题；没发布则为 null */
  localizedHeadline: string | null;
  rank: number | null;
  sourceCount: number | null;
  signalCount: number | null;
  sourceNames: string[];
  capturedAt: Date;
  latestAt: Date | null;
  aihotUrl: string;
  mode: HotTopicBriefMode;
  /** 简报入口；该语言未发布时为 null */
  briefHref: string | null;
};

export async function listTrendingCards(locale: DraftLanguage): Promise<TrendingCard[]> {
  const material = await loadAllLatestMaterial();
  if (!material.length) return [];

  const unitKeys = material.map((m) => hotTopicUnitKey(m.topicId));
  const families = await prisma.articleFamily.findMany({
    where: { unit_key: { in: unitKeys } },
    include: {
      translations: {
        where: { locale },
        include: {
          publications: { where: { status: "PUBLISHED" } },
        },
      },
    },
  });
  const byKey = new Map(families.map((f) => [f.unit_key, f]));

  const cards: TrendingCard[] = [];
  for (const m of material) {
    const fam = byKey.get(hotTopicUnitKey(m.topicId));
    const translation = fam?.translations[0];
    const pub = translation?.publications[0];
    let localizedHeadline: string | null = null;
    if (pub) {
      const rev = await prisma.articleRevision.findUnique({
        where: { id: pub.revision_id }, select: { headline: true },
      });
      localizedHeadline = rev?.headline ?? null;
    }
    cards.push({
      topicId: m.topicId,
      sourceTitle: m.title,
      localizedHeadline,
      rank: m.rank,
      sourceCount: m.sourceCount,
      signalCount: m.signalCount,
      sourceNames: m.sourceNames,
      capturedAt: m.capturedAt,
      latestAt: m.latestAt,
      aihotUrl: m.aihotUrl,
      mode: m.mode,
      briefHref: pub
        ? pub.path
        : fam
          ? null
          : null,
    });
  }
  // 名次升序；没有名次的排在最后
  return cards.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
}

/** 简报详情路径（供卡片与 sitemap 复用） */
export function trendingBriefPath(locale: DraftLanguage, slug: string): string {
  return publicPath({ locale, contentForm: "HOT_TOPIC_BRIEF", slug });
}
