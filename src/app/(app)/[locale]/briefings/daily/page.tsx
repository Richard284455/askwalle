import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ArticleList } from "@/components/publishing/article-list";
import { AIHOT_BASE_URL } from "@/lib/content/aihot/types";
import { listDailyBriefings, listingAttribution } from "@/lib/content/publishing/query";
import {
  absoluteUrl, localeFromSegment, LOCALES, LOCALE_HREFLANG, LOCALE_SEGMENT,
} from "@/lib/content/publishing/types";

/** 列表随发布变化，不做静态化 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ locale: string }> };

// 标题里不带品牌名 —— 出处只在底部声明
const TITLE: Record<string, string> = {
  EN_US: "Daily briefings", ES_ES: "Informes diarios",
  PT_BR: "Boletins diários", JA_JP: "デイリーブリーフィング",
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const l = localeFromSegment(locale);
  if (!l) return { title: "Not found", robots: { index: false, follow: false } };
  const languages: Record<string, string> = {};
  for (const x of LOCALES) languages[LOCALE_HREFLANG[x]] = absoluteUrl(`/${LOCALE_SEGMENT[x]}/briefings/daily`);
  languages["x-default"] = absoluteUrl("/en/briefings/daily");
  return {
    title: TITLE[l] ?? TITLE.EN_US,
    alternates: { canonical: absoluteUrl(`/${LOCALE_SEGMENT[l]}/briefings/daily`), languages },
    robots: { index: true, follow: true },
  };
}

export default async function DailyIndexPage({ params }: Props) {
  const { locale } = await params;
  const l = localeFromSegment(locale);
  if (!l) notFound();

  const attribution = await listingAttribution(AIHOT_BASE_URL);
  if (!attribution) notFound();

  return <ArticleList cards={await listDailyBriefings(l)} attribution={attribution} locale={l} variant="DAILY" />;
}
