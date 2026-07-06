import { prisma } from "@/lib/db/db";
import { WebsiteSettings } from "@/lib/constraint";
import FooterContent from "./footer-content";
import type { FooterSettings } from "@/lib/types";
import { cachedPrismaQuery } from "@/lib/db/cache";

export async function Footer() {
  let footerLinks: { title: string; url: string }[] = [];
  let settings: { key: string; value: string }[] = [];

  try {
    // 在服务端获取数据
    [footerLinks, settings] = await Promise.all([
      cachedPrismaQuery(
        "footer-links",
        () =>
          prisma.footerLink.findMany({
            select: {
              title: true,
              url: true,
            },
            orderBy: {
              created_at: "asc",
            },
          }),
        { ttl: 86400 } // 1天缓存
      ),
      cachedPrismaQuery(
        "footer-settings",
        () =>
          prisma.setting.findMany({
            where: {
              key: {
                in: [
                  WebsiteSettings.siteIcp,
                  WebsiteSettings.customHtml,
                  WebsiteSettings.siteCopyright,
                ],
              },
            },
          }),
        { ttl: 2592000 } // 1个月缓存
      ),
    ]);
  } catch (error) {
    console.warn("[Footer] Footer data unavailable; rendering fallback content.");
  }

  // 转换设置数据为对象格式
  const settingsMap = settings.reduce((acc, setting) => {
    acc[setting.key] = setting.value;
    return acc;
  }, {} as Record<string, string>);

  const footerSettings: FooterSettings = {
    links: footerLinks,
    copyright: settingsMap[WebsiteSettings.siteCopyright] || "© 2024 AI导航",
    icpBeian: settingsMap[WebsiteSettings.siteIcp] || "",
    customHtml: settingsMap[WebsiteSettings.customHtml] || "",
  };

  return <FooterContent initialSettings={footerSettings} />;
}

export default Footer;
