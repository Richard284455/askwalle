import type { Website } from "@/lib/types";

export const TOOL_INDEX_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export function getToolIndexLetter(title: string) {
  const firstCharacter = title.trim().charAt(0).toUpperCase();

  return /^[A-Z]$/.test(firstCharacter) ? firstCharacter : "#";
}

export function groupToolsByLetter(websites: Website[]) {
  const groups = new Map<string, Website[]>();

  for (const letter of TOOL_INDEX_LETTERS) {
    groups.set(letter, []);
  }

  groups.set("#", []);

  for (const website of websites) {
    const letter = getToolIndexLetter(website.title);
    groups.get(letter)?.push(website);
  }

  return groups;
}

export function createToolSlug(website: Pick<Website, "id" | "title">) {
  const titleSlug = website.title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${titleSlug || "tool"}-${website.id}`;
}

export function getToolIdFromSlug(slug: string) {
  const match = slug.match(/(?:^|-)(\d+)$/);

  return match ? Number(match[1]) : null;
}

// 详情页链接：优先使用数据库持久化 slug，缺失时回退到 title-id 兼容格式
export function getToolHref(
  website: Pick<Website, "id" | "title"> & { slug?: string | null }
) {
  return `/tools/${website.slug || createToolSlug(website)}`;
}
