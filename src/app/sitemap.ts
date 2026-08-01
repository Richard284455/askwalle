import type { MetadataRoute } from "next";

import { listPublishedPaths } from "@/lib/content/publishing/query";
import { absoluteUrl } from "@/lib/content/publishing/types";

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
  return pages.map((p) => ({
    url: absoluteUrl(p.path),
    lastModified: p.lastModified,
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }));
}
