import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublishedArticle } from "@/components/publishing/published-article";
import { notPublishedMetadata, publishedMetadata } from "@/lib/content/publishing/metadata";
import { getUpdatePage } from "@/lib/content/publishing/query";
import { localeFromSegment } from "@/lib/content/publishing/types";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; slug: string }> };

async function load(params: Props["params"]) {
  const { locale, slug } = await params;
  const l = localeFromSegment(locale);
  if (!l) return null;
  return getUpdatePage(l, slug);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await load(params);
  return page ? publishedMetadata(page) : notPublishedMetadata;
}

export default async function UpdatePage({ params }: Props) {
  const page = await load(params);
  // 未发布的内容在这里就取不到 —— 公开可访问性由查询本身把住
  if (!page) notFound();
  return <PublishedArticle page={page} />;
}
