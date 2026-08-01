import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublishedArticle } from "@/components/publishing/published-article";
import { notPublishedMetadata, publishedMetadata } from "@/lib/content/publishing/metadata";
import { getDailyPage } from "@/lib/content/publishing/query";
import { localeFromSegment } from "@/lib/content/publishing/types";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; date: string }> };

async function load(params: Props["params"]) {
  const { locale, date } = await params;
  const l = localeFromSegment(locale);
  if (!l) return null;
  return getDailyPage(l, date);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await load(params);
  return page ? publishedMetadata(page) : notPublishedMetadata;
}

export default async function DailyBriefingPage({ params }: Props) {
  const page = await load(params);
  if (!page) notFound();
  return <PublishedArticle page={page} />;
}
