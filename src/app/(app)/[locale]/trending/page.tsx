import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TrendingList } from "@/components/publishing/trending-list";
import { listTrending } from "@/lib/content/publishing/trending";
import {
  absoluteUrl, localeFromSegment, LOCALES, LOCALE_HREFLANG, LOCALE_SEGMENT,
} from "@/lib/content/publishing/types";

/** 榜单是实时的，不做静态化 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ locale: string }> };

// 标题里不带品牌名 —— 出处只在底部声明
const TITLE: Record<string, string> = {
  EN_US: "Trending now", ES_ES: "Tendencias ahora",
  PT_BR: "Em alta agora", JA_JP: "現在のトレンド",
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
  const listing = await listTrending(l);
  // 归因不可用（AI HOT 链接非法）时不呈现榜单：没有合法出处就不该对外发
  if (!listing) notFound();
  return <TrendingList listing={listing} locale={l} />;
}
