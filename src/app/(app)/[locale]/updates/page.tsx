import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ArticleList } from "@/components/publishing/article-list";
import { AIHOT_BASE_URL } from "@/lib/content/aihot/types";
import { listingAttribution, listUpdates } from "@/lib/content/publishing/query";
import {
  absoluteUrl, localeFromSegment, LOCALES, LOCALE_HREFLANG, LOCALE_SEGMENT,
} from "@/lib/content/publishing/types";

/** 列表随发布变化，不做静态化 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ locale: string }> };

// 标题里不带品牌名 —— 出处只在底部声明
const TITLE: Record<string, string> = {
  EN_US: "AI updates", ES_ES: "Novedades de IA",
  PT_BR: "Novidades de IA", JA_JP: "AI アップデート",
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const l = localeFromSegment(locale);
  if (!l) return { title: "Not found", robots: { index: false, follow: false } };
  const languages: Record<string, string> = {};
  // 列表页四种语言恒定存在，互链可以全给
  for (const x of LOCALES) languages[LOCALE_HREFLANG[x]] = absoluteUrl(`/${LOCALE_SEGMENT[x]}/updates`);
  languages["x-default"] = absoluteUrl("/en/updates");
  return {
    title: TITLE[l] ?? TITLE.EN_US,
    alternates: { canonical: absoluteUrl(`/${LOCALE_SEGMENT[l]}/updates`), languages },
    robots: { index: true, follow: true },
  };
}

export default async function UpdatesIndexPage({ params }: Props) {
  const { locale } = await params;
  const l = localeFromSegment(locale);
  if (!l) notFound();

  const attribution = await listingAttribution(AIHOT_BASE_URL);
  // 归因不可用时不呈现列表：没有合法出处就不该对外发
  if (!attribution) notFound();

  return <ArticleList cards={await listUpdates(l)} attribution={attribution} locale={l} variant="UPDATES" />;
}
