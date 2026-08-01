import type { MetadataRoute } from "next";

import { listPublishedPaths } from "@/lib/content/publishing/query";
import { absoluteUrl, LOCALES, LOCALE_SEGMENT } from "@/lib/content/publishing/types";

/**
 * sitemap 只收**已发布**的页面。
 *
 * 草稿与退回稿不进 sitemap，也不可公开访问 —— 两道都要有：
 * 只靠不列进 sitemap，页面照样能被直接访问到。
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages = await listPublishedPaths().catch(() => []);
  const articles = pages.map((p) => ({
    url: absoluteUrl(p.path),
    lastModified: p.lastModified,
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }));
  /*
   * 热点榜单是常驻页面，四种语言恒定存在，与「有没有发布过简报」无关 ——
   * 它展示的是 AI HOT 榜单的实时投影，不是本站的编辑内容。
   */
  const trending = LOCALES.map((l) => ({
    url: absoluteUrl(`/${LOCALE_SEGMENT[l]}/trending`),
    lastModified: new Date(),
    changeFrequency: "hourly" as const,
    priority: 0.6,
  }));
  return [...trending, ...articles];
}
