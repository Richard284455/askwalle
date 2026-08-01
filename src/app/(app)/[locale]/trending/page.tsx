import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TrendingList } from "@/components/publishing/trending-list";
import { listTrendingCards } from "@/lib/content/publishing/trending";
import {
  absoluteUrl, localeFromSegment, LOCALES, LOCALE_HREFLANG, LOCALE_SEGMENT,
} from "@/lib/content/publishing/types";

/** 榜单是实时的，不做静态化 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ locale: string }> };

const TITLE: Record<string, string> = {
  EN_US: "Trending on AI HOT", ES_ES: "Tendencias en AI HOT",
  PT_BR: "Em alta no AI HOT", JA_JP: "AI HOT トレンド",
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const l = localeFromSegment(locale);
  if (!l) return { title: "Not found", robots: { index: false, follow: false } };
  const path = `/${LOCALE_SEGMENT[l]}/trending`;
  const languages: Record<string, string> = {};
  // 榜单四种语言恒定存在，互链可以全给
  for (const x of LOCALES) languages[LOCALE_HREFLANG[x]] = absoluteUrl(`/${LOCALE_SEGMENT[x]}/trending`);
  languages["x-default"] = absoluteUrl("/en/trending");
  return {
    title: TITLE[l] ?? TITLE.EN_US,
    alternates: { canonical: absoluteUrl(path), languages },
    robots: { index: true, follow: true },
  };
}

export default async function TrendingPage({ params }: Props) {
  const { locale } = await params;
  const l = localeFromSegment(locale);
  if (!l) notFound();
  const cards = await listTrendingCards(l);
  return <TrendingList cards={cards} locale={l} />;
}
