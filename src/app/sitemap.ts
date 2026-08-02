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
   * 三个列表页是常驻的，四种语言恒定存在，与「有没有发布过内容」无关 ——
   * 空列表页也该可被抓取，否则新内容上线后要等下一次抓取才被发现。
   *
   * 榜单变化最快（实时投影），列表页跟随发布节奏。
   */
  const listings = LOCALES.flatMap((l) => [
    {
      url: absoluteUrl(`/${LOCALE_SEGMENT[l]}/trending`),
      lastModified: new Date(),
      changeFrequency: "hourly" as const,
      priority: 0.6,
    },
    {
      url: absoluteUrl(`/${LOCALE_SEGMENT[l]}/updates`),
      lastModified: new Date(),
      changeFrequency: "daily" as const,
      priority: 0.6,
    },
    {
      url: absoluteUrl(`/${LOCALE_SEGMENT[l]}/briefings/daily`),
      lastModified: new Date(),
      changeFrequency: "daily" as const,
      priority: 0.6,
    },
  ]);
  return [...listings, ...articles];
}
