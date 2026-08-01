import type { Metadata } from "next";

import type { PublishedPage } from "./query";
import { LOCALE_HTML_LANG } from "./types";

/**
 * 公开页的 SEO 头。
 *
 * 三件事必须成立，否则多语言站点会被判成互相重复的内容：
 *   - 每个语言页 self-canonical（指向自己，不指向英文）
 *   - 四种语言互设 hreflang
 *   - x-default 指向 en-US
 *
 * 只把**已发布**的语言写进 hreflang —— 指向未发布页面的互链就是死链。
 */
export function publishedMetadata(page: PublishedPage): Metadata {
  const languages: Record<string, string> = {};
  for (const a of page.alternates) languages[a.hreflang] = a.href;
  if (page.xDefault) languages["x-default"] = page.xDefault;

  return {
    title: page.headline,
    description: page.summary,
    alternates: { canonical: page.canonical, languages },
    openGraph: {
      title: page.headline,
      description: page.summary,
      url: page.canonical,
      type: "article",
      locale: LOCALE_HTML_LANG[page.locale],
      publishedTime: page.sitePublishedAt.toISOString(),
    },
    robots: { index: true, follow: true },
  };
}

/** 未发布/找不到时：明确 noindex，不让搜索引擎收录一个 404 或草稿位 */
export const notPublishedMetadata: Metadata = {
  title: "Not found",
  robots: { index: false, follow: false },
};
