/**
 * 工具 slug 生成的共享逻辑。
 * 规则：标题 slug 足够有意义(≥3 字符)则用标题；
 * 否则(纯中文/符号标题)回退到官网域名首段；
 * 两者都不可用时才用 tool-{id} 兜底。
 */

export function slugifyText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function hostnameSlug(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return slugifyText(hostname.split(".")[0] ?? "");
  } catch {
    return "";
  }
}

export function bestToolSlug(
  title: string,
  url: string,
  fallbackId: number | string
): string {
  const titleSlug = slugifyText(title);
  if (titleSlug.length >= 3) return titleSlug;

  const hostSlug = hostnameSlug(url);
  if (hostSlug.length >= 3) return hostSlug;

  return titleSlug || `tool-${fallbackId}`;
}

// 需要被 --optimize 重写的低质量 slug：tool-{id} 兜底格式或过短
export function isLowQualitySlug(slug: string): boolean {
  return /^tool-\d+$/.test(slug) || slug.length < 3;
}
