import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublishedArticle } from "@/components/publishing/published-article";
import { notPublishedMetadata, publishedMetadata } from "@/lib/content/publishing/metadata";
import { getTrendingPage } from "@/lib/content/publishing/query";
import { localeFromSegment } from "@/lib/content/publishing/types";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; slug: string }> };

async function load(params: Props["params"]) {
  const { locale, slug } = await params;
  const l = localeFromSegment(locale);
  if (!l) return null;
  return getTrendingPage(l, slug);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await load(params);
  return page ? publishedMetadata(page) : notPublishedMetadata;
}

export default async function TrendingPage({ params }: Props) {
  const page = await load(params);
  if (!page) notFound();
  return <PublishedArticle page={page} />;
}
