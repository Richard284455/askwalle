import {
  Prisma,
  PrismaClient,
  RewriteStatus,
  ToolLinkKind,
  ToolTagKind,
} from "@prisma/client";
import { basename } from "path";

import { bestToolSlug } from "./slug-utils";
import { readXlsx } from "./xlsx-reader";

/**
 * 共享 AI 工具导入逻辑 —— CLI (scripts/import-tools-from-xlsx.ts) 与
 * 后台 (/api/admin/tools/import) 共用同一条解析/清洗/统计/落库路径，避免逻辑分叉。
 *
 * 安全不变量：
 * - 导入工具 status=pending，rewrite_status=raw_imported。
 * - raw_imported_content 必含 description（供后续安全回滚）。
 * - 覆盖导入永不覆盖 approved 或 human_reviewed 工具（即使 overwrite=true）。
 * - 默认不覆盖已存在工具（overwrite=false）。
 */

export const IMPORT_SOURCE = "toolify-xlsx-import";
export const ERROR_LOG_LIMIT = 4000;

// ---------------------------------------------------------------------------
// 清洗规则
// ---------------------------------------------------------------------------

const TRACKING_PARAMS = /^(via|ref)$|^utm_/i;

function cleanSiteUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".")) {
      return null;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    let result = url.toString();
    if (result.endsWith("?")) result = result.slice(0, -1);
    return result;
  } catch {
    return null;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parseMonthlyVisitors(raw: string): number | null {
  const value = raw.trim();
  const match = value.match(/^([\d.]+)([KMB])?$/i);
  if (!match) return null; // 覆盖 "--"、空串与其它占位符
  const base = parseFloat(match[1]);
  if (Number.isNaN(base)) return null;
  const factor =
    { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[
      (match[2] ?? "").toUpperCase() as "K" | "M" | "B"
    ] ?? 1;
  return Math.round(base * factor);
}

function parseListedAt(raw: string): Date | null {
  if (!raw.trim()) return null;
  const date = new Date(raw.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

const PLATFORM_TAGS = new Set([
  "Website",
  "Browser Extension",
  "App",
  "Mobile App",
  "Open Source",
]);
const PRICING_TAGS = new Set([
  "Free",
  "Freemium",
  "Paid",
  "Free Trial",
  "Contact for Pricing",
]);

type ParsedTag = { kind: ToolTagKind; name: string };

function splitTopicBlob(blob: string): string[] {
  // 主题标签在源数据中无分隔符拼接（"…AssistantsAI Creative Writing…"），
  // 在「小写字母/数字/右括号 后紧跟 大写字母」的边界处切分；全大写词(NSFW/LLMs)不受影响
  return blob
    .split(/(?<=[a-z0-9)])(?=[A-Z])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1 && part.length < 80);
}

function parseTags(raw: string): ParsedTag[] {
  const tags: ParsedTag[] = [];
  const seen = new Set<string>();
  const push = (kind: ToolTagKind, name: string) => {
    const key = `${kind}:${name}`;
    if (!seen.has(key)) {
      seen.add(key);
      tags.push({ kind, name });
    }
  };
  const tokens = raw
    .split(/\n+|\s{2,}/)
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of tokens) {
    if (PLATFORM_TAGS.has(token)) push(ToolTagKind.platform, token);
    else if (PRICING_TAGS.has(token)) push(ToolTagKind.pricing, token);
    else for (const topic of splitTopicBlob(token)) push(ToolTagKind.topic, topic);
  }
  return tags;
}

type ParsedLink = { kind: ToolLinkKind; url: string; label?: string };

const SOCIAL_HOST_MAP: [RegExp, ToolLinkKind][] = [
  [/(^|\.)twitter\.com$|(^|\.)x\.com$/, ToolLinkKind.twitter],
  [/(^|\.)facebook\.com$/, ToolLinkKind.facebook],
  [/(^|\.)instagram\.com$/, ToolLinkKind.instagram],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, ToolLinkKind.youtube],
  [/(^|\.)linkedin\.com$/, ToolLinkKind.linkedin],
  [/(^|\.)tiktok\.com$/, ToolLinkKind.tiktok],
  [/(^|\.)github\.com$/, ToolLinkKind.github],
  [/(^|\.)discord\.(gg|com)$/, ToolLinkKind.discord],
  [/(^|\.)reddit\.com$/, ToolLinkKind.reddit],
  [/(^|\.)pinterest\.[a-z.]+$/, ToolLinkKind.pinterest],
];

const EMAIL_PATTERN = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;

function classifySocial(raw: string): ParsedLink | null {
  let value = raw.trim();
  if (!value || value === "null") return null;
  if (value.startsWith("mailto:")) value = value.slice(7);
  if (!value.startsWith("http")) {
    return EMAIL_PATTERN.test(value)
      ? { kind: ToolLinkKind.email, url: value }
      : null;
  }
  try {
    const url = new URL(value);
    if (!url.hostname.includes(".")) return null;
    const host = url.hostname.replace(/^www\./, "");
    for (const [pattern, kind] of SOCIAL_HOST_MAP) {
      if (pattern.test(host)) return { kind, url: value };
    }
    return { kind: ToolLinkKind.other, url: value };
  } catch {
    return null;
  }
}

function trimUrl(raw: string): string {
  return raw.replace(/[).,;]+$/, "");
}

function parseExternalLinks(raw: string): ParsedLink[] {
  if (!raw.trim()) return [];
  const links: ParsedLink[] = [];
  const patterns: [ToolLinkKind, RegExp][] = [
    [ToolLinkKind.pricing, /Pricing Link:\s*(https?:\/\/\S+)/i],
    [ToolLinkKind.login, /Login Link:\s*(https?:\/\/\S+)/i],
    [ToolLinkKind.signup, /Sign up Link:\s*(https?:\/\/\S+)/i],
    [ToolLinkKind.about, /about us page\((https?:\/\/[^)\s]+)\)/i],
    [ToolLinkKind.contact, /contact us page\((https?:\/\/[^)\s]+)\)/i],
    [ToolLinkKind.discord, /(https?:\/\/discord\.(?:gg|com)\/[\w-]+)/i],
  ];
  for (const [kind, pattern] of patterns) {
    const match = raw.match(pattern);
    if (match) {
      const cleaned = cleanSiteUrl(trimUrl(match[1]));
      if (cleaned) links.push({ kind, url: cleaned });
    }
  }
  const email = raw.match(
    /support email[^:]*:\s*([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i
  );
  if (email) links.push({ kind: ToolLinkKind.email, url: email[1] });
  return links;
}

type ParsedMedia = { url: string; alt?: string };

function parseImages(raw: string): ParsedMedia[] {
  // 只提取 <img src>，原始 HTML 一律不入库
  const media: ParsedMedia[] = [];
  const imgTags = raw.match(/<img[^>]+>/g) ?? [];
  for (const tag of imgTags) {
    const src = tag.match(/src="([^"]+)"/);
    if (!src) continue;
    const alt = tag.match(/alt="([^"]*)"/);
    media.push({ url: src[1], alt: alt?.[1] || undefined });
  }
  return media;
}

function stripHeading(raw: string): string {
  // what/how/features/cases 首行是 "What is X?" 之类的标题，去掉后取正文
  const text = raw.trim();
  const newline = text.indexOf("\n");
  if (newline < 0) return text;
  const firstLine = text.slice(0, newline).trim();
  if (firstLine.length <= 120) return text.slice(newline + 1).trim();
  return text;
}

function parseFaq(raw: string): string[] {
  const body = stripHeading(raw);
  // 数据质量守卫：个别行被 external 类内容污染
  if (!body.includes("?") || body.includes("Company address")) return [];
  return (body.match(/[^?]+\?/g) ?? [])
    .map((question) => question.replace(/\s+/g, " ").trim())
    .filter((question) => question.length > 8 && question.length < 300);
}

function parseCases(raw: string): string[] {
  const body = stripHeading(raw);
  if (!body) return [];
  if (/#\d+/.test(body)) {
    return body
      .split(/#\d+\s*/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [body];
}

function parseFeatures(raw: string): { text: string; items: string[] | null } {
  const body = stripHeading(raw);
  if (!body) return { text: "", items: null };
  // 数据源 features 为单行无分隔文本；仅在 "(Word) " 边界启发式产出可信结果时才拆数组
  const parts = body
    .split(/(?<=\))\s+(?=[A-Z])/)
    .map((part) => part.trim())
    .filter(Boolean);
  const reliable =
    parts.length >= 3 &&
    parts.every((part) => part.length < 250) &&
    parts.slice(0, -1).every((part) => part.endsWith(")"));
  return { text: body, items: reliable ? parts : null };
}

// ---------------------------------------------------------------------------
// 行 → 导入记录
// ---------------------------------------------------------------------------

export type ToolRecord = {
  level1: string;
  level2: string;
  name: string;
  slug: string;
  introduction: string;
  site: string;
  rating: number | null;
  reviewCount: number;
  savedCount: number;
  monthlyVisitors: number | null;
  listedAt: Date | null;
  tags: ParsedTag[];
  links: ParsedLink[];
  media: ParsedMedia[];
  faq: string[];
  what: string;
  how: string;
  featuresText: string;
  features: string[] | null;
  useCases: string[];
  externalRaw: string;
};

export type Stats = {
  totalRows: number;
  valid: number;
  skippedRows: { row: number; name: string; reason: string }[];
  slugDisambiguated: string[];
  siteCleaned: number;
  monthlyParsed: number;
  tagCounts: Record<string, number>;
  uniqueTopicTags: Set<string>;
  linkCounts: Record<string, number>;
  mediaTotal: number;
  faqQuestions: number;
  faqFlagged: number;
  featuresSplit: number;
  casesSplit: number;
};

export function emptyStats(totalRows = 0): Stats {
  return {
    totalRows,
    valid: 0,
    skippedRows: [],
    slugDisambiguated: [],
    siteCleaned: 0,
    monthlyParsed: 0,
    tagCounts: {},
    uniqueTopicTags: new Set(),
    linkCounts: {},
    mediaTotal: 0,
    faqQuestions: 0,
    faqFlagged: 0,
    featuresSplit: 0,
    casesSplit: 0,
  };
}

export function mergeStats(target: Stats, source: Stats): void {
  target.totalRows += source.totalRows;
  target.valid += source.valid;
  target.skippedRows.push(...source.skippedRows);
  target.slugDisambiguated.push(...source.slugDisambiguated);
  target.siteCleaned += source.siteCleaned;
  target.monthlyParsed += source.monthlyParsed;
  for (const [key, count] of Object.entries(source.tagCounts)) {
    target.tagCounts[key] = (target.tagCounts[key] ?? 0) + count;
  }
  for (const tag of source.uniqueTopicTags) target.uniqueTopicTags.add(tag);
  for (const [key, count] of Object.entries(source.linkCounts)) {
    target.linkCounts[key] = (target.linkCounts[key] ?? 0) + count;
  }
  target.mediaTotal += source.mediaTotal;
  target.faqQuestions += source.faqQuestions;
  target.faqFlagged += source.faqFlagged;
  target.featuresSplit += source.featuresSplit;
  target.casesSplit += source.casesSplit;
}

export function buildRecords(
  rows: Record<string, string>[],
  usedSlugs: Set<string>,
  urlToExistingSlug: Map<string, string>,
  stats: Stats
): ToolRecord[] {
  const records: ToolRecord[] = [];
  rows.forEach((row, index) => {
    const name = (row.name ?? "").trim();
    const introduction = (row.introduction ?? "").trim();
    const site = cleanSiteUrl(row.site ?? "");
    if (!name || !introduction || !site) {
      stats.skippedRows.push({
        row: index + 2,
        name: name || "<无名>",
        reason: !name
          ? "缺少 name"
          : !introduction
          ? "缺少 introduction"
          : "site URL 无效或缺失",
      });
      return;
    }
    if ((row.site ?? "").length !== site.length) stats.siteCleaned++;

    // 同一 URL 的已有记录沿用其现有 slug，保证重复导入幂等；否则生成并消歧
    let slug = urlToExistingSlug.get(site) ?? "";
    if (!slug) {
      slug = bestToolSlug(name, site, index + 2);
      if (usedSlugs.has(slug)) {
        let n = 2;
        while (usedSlugs.has(`${slug}-${n}`)) n++;
        slug = `${slug}-${n}`;
        stats.slugDisambiguated.push(slug);
      }
    }
    usedSlugs.add(slug);

    const monthlyVisitors = parseMonthlyVisitors(row.monthly_visitors ?? "");
    if (monthlyVisitors !== null) stats.monthlyParsed++;

    const tags = parseTags(row.tags ?? "");
    for (const tag of tags) {
      stats.tagCounts[tag.kind] = (stats.tagCounts[tag.kind] ?? 0) + 1;
      if (tag.kind === ToolTagKind.topic) stats.uniqueTopicTags.add(tag.name);
    }

    const links: ParsedLink[] = [];
    const linkKeys = new Set<string>();
    const pushLink = (link: ParsedLink | null) => {
      if (!link) return;
      const key = `${link.kind}:${link.url}`;
      if (!linkKeys.has(key)) {
        linkKeys.add(key);
        links.push(link);
      }
    };
    for (let i = 1; i <= 6; i++) pushLink(classifySocial(row[`social_${i}`] ?? ""));
    for (const link of parseExternalLinks(row.external ?? "")) pushLink(link);
    for (const link of links) {
      stats.linkCounts[link.kind] = (stats.linkCounts[link.kind] ?? 0) + 1;
    }

    const media = parseImages(row.images ?? "");
    stats.mediaTotal += media.length;

    const faq = parseFaq(row.faq ?? "");
    if ((row.faq ?? "").trim() && faq.length === 0) stats.faqFlagged++;
    stats.faqQuestions += faq.length;

    const features = parseFeatures(row.features ?? "");
    if (features.items) stats.featuresSplit++;

    const useCases = parseCases(row.cases ?? "");
    if (useCases.length > 1) stats.casesSplit++;

    records.push({
      level1: (row.level1_category ?? "").trim() || "Uncategorized",
      level2: (row.level2_category ?? "").trim() || "General",
      name,
      slug,
      introduction,
      site,
      rating: row.rating?.trim() ? parseFloat(row.rating) || null : null,
      reviewCount: parseInt(row.reviews ?? "0", 10) || 0,
      savedCount: parseInt(row.saved ?? "0", 10) || 0,
      monthlyVisitors,
      listedAt: parseListedAt(row.add_on ?? ""),
      tags,
      links,
      media,
      faq,
      what: stripHeading(row.what ?? ""),
      how: stripHeading(row.how ?? ""),
      featuresText: features.text,
      features: features.items,
      useCases,
      externalRaw: (row.external ?? "").trim(),
    });
    stats.valid++;
  });
  return records;
}

// ---------------------------------------------------------------------------
// 数据库写入
// ---------------------------------------------------------------------------

async function ensureCategory(
  prisma: PrismaClient,
  cache: Map<string, number>,
  name: string,
  parentId: number | null
): Promise<number> {
  const slug = slugify(name);
  const cacheKey = `${parentId ?? "root"}:${slug}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const existing = await prisma.category.findUnique({ where: { slug } });
  if (existing) {
    if (parentId && existing.parent_id !== parentId) {
      await prisma.category.update({
        where: { id: existing.id },
        data: { parent_id: parentId },
      });
    }
    cache.set(cacheKey, existing.id);
    return existing.id;
  }
  const created = await prisma.category.create({
    data: { name, slug, parent_id: parentId },
  });
  cache.set(cacheKey, created.id);
  return created.id;
}

function tagSlug(tag: ParsedTag): string {
  return `${tag.kind}-${slugify(tag.name)}`;
}

// 批量补建缺失标签并合并进共享的 slug → id 缓存，避免逐条 upsert 的网络往返
async function ensureTags(
  prisma: PrismaClient,
  records: ToolRecord[],
  tagCache: Map<string, number>
): Promise<void> {
  const missing = new Map<string, ParsedTag>();
  for (const record of records) {
    for (const tag of record.tags) {
      const slug = tagSlug(tag);
      if (!tagCache.has(slug) && !missing.has(slug)) missing.set(slug, tag);
    }
  }
  if (!missing.size) return;
  await prisma.toolTag.createMany({
    data: [...missing.entries()].map(([slug, tag]) => ({
      name: tag.name,
      slug,
      kind: tag.kind,
    })),
    skipDuplicates: true,
  });
  const created = await prisma.toolTag.findMany({
    where: { slug: { in: [...missing.keys()] } },
    select: { id: true, slug: true },
  });
  for (const tag of created) tagCache.set(tag.slug, tag.id);
}

export type ImportRecordsOptions = {
  overwrite: boolean;
  importBatchId?: number | null;
  log?: (message: string) => void;
};

export async function importRecords(
  prisma: PrismaClient,
  records: ToolRecord[],
  categoryCache: Map<string, number>,
  tagCache: Map<string, number>,
  options: ImportRecordsOptions
): Promise<{ inserted: number; skippedExisting: number; updated: number }> {
  const { overwrite, importBatchId = null, log } = options;
  let inserted = 0;
  let skippedExisting = 0;
  let updated = 0;

  await ensureTags(prisma, records, tagCache);

  // 一次性预取本批可能已存在的记录
  const existingWebsites = await prisma.website.findMany({
    where: {
      OR: [
        { slug: { in: records.map((record) => record.slug) } },
        { url: { in: records.map((record) => record.site) } },
      ],
    },
    select: {
      id: true,
      slug: true,
      url: true,
      status: true,
      toolDetail: { select: { rewrite_status: true } },
    },
  });
  const existingBySlug = new Map(
    existingWebsites.filter((w) => w.slug).map((w) => [w.slug as string, w])
  );
  const existingByUrl = new Map(existingWebsites.map((w) => [w.url, w]));

  for (const record of records) {
    const parentId = await ensureCategory(prisma, categoryCache, record.level1, null);
    const categoryId = await ensureCategory(prisma, categoryCache, record.level2, parentId);

    const existing =
      existingBySlug.get(record.slug) ?? existingByUrl.get(record.site);

    // 覆盖保护：approved 与 human_reviewed 工具永不被覆盖（即使 overwrite=true）
    if (
      existing &&
      (existing.status === "approved" ||
        existing.toolDetail?.rewrite_status === RewriteStatus.human_reviewed)
    ) {
      skippedExisting++;
      log?.(`  跳过(已发布/已人工审核): ${record.name}`);
      continue;
    }
    if (existing && !overwrite) {
      skippedExisting++;
      continue;
    }

    const websiteData = {
      title: record.name,
      url: record.site,
      description: record.introduction,
      slug: record.slug,
      category_id: categoryId,
      status: "pending",
      import_batch_id: importBatchId,
    };

    let websiteId: number;
    let hasCachedMedia = false;
    if (existing) {
      await prisma.website.update({ where: { id: existing.id }, data: websiteData });
      websiteId = existing.id;
      await prisma.websiteToolTag.deleteMany({ where: { website_id: websiteId } });
      await prisma.toolLink.deleteMany({ where: { website_id: websiteId } });
      // 已通过 cache:tool-media 本地化的媒体在覆盖导入时保留
      hasCachedMedia =
        (await prisma.toolMedia.count({
          where: { website_id: websiteId, url: { startsWith: "/cached-tool-media/" } },
        })) > 0;
      await prisma.toolMedia.deleteMany({
        where: {
          website_id: websiteId,
          url: { not: { startsWith: "/cached-tool-media/" } },
        },
      });
      await prisma.toolFAQ.deleteMany({ where: { website_id: websiteId } });
      updated++;
    } else {
      const created = await prisma.website.create({ data: websiteData });
      websiteId = created.id;
      inserted++;
    }

    const detailData = {
      what: record.what || null,
      how: record.how || null,
      features_text: record.featuresText || null,
      features: record.features
        ? (record.features as Prisma.InputJsonValue)
        : Prisma.DbNull,
      use_cases: record.useCases.length
        ? (record.useCases as Prisma.InputJsonValue)
        : Prisma.DbNull,
      rating: record.rating,
      review_count: record.reviewCount,
      saved_count: record.savedCount,
      monthly_visitors: record.monthlyVisitors,
      listed_at: record.listedAt,
      source: IMPORT_SOURCE,
      external_raw: record.externalRaw || null,
      // 原始导入底稿快照 + 审核流起点状态（description 必含，供安全回滚）
      raw_imported_content: {
        description: record.introduction,
        what: record.what,
        how: record.how,
        featuresText: record.featuresText,
        useCases: record.useCases,
        faqs: record.faq.map((question) => ({ question, answer: null })),
      } as unknown as Prisma.InputJsonValue,
      rewrite_status: RewriteStatus.raw_imported,
    };
    await prisma.toolDetail.upsert({
      where: { website_id: websiteId },
      update: detailData,
      create: { website_id: websiteId, ...detailData },
    });

    const tagIds = record.tags
      .map((tag) => tagCache.get(tagSlug(tag)))
      .filter((id): id is number => typeof id === "number");
    if (tagIds.length) {
      await prisma.websiteToolTag.createMany({
        data: tagIds.map((tagId) => ({ website_id: websiteId, tag_id: tagId })),
        skipDuplicates: true,
      });
    }

    if (record.links.length) {
      await prisma.toolLink.createMany({
        data: record.links.map((link) => ({
          website_id: websiteId,
          kind: link.kind,
          url: link.url,
          label: link.label ?? null,
        })),
        skipDuplicates: true,
      });
    }

    if (record.media.length && !hasCachedMedia) {
      await prisma.toolMedia.createMany({
        data: record.media.map((item, position) => ({
          website_id: websiteId,
          kind: "screenshot",
          url: item.url,
          alt: item.alt ?? null,
          position,
        })),
      });
    }

    if (record.faq.length) {
      await prisma.toolFAQ.createMany({
        data: record.faq.map((question, position) => ({
          website_id: websiteId,
          question,
          answer: null,
          position,
        })),
      });
    }

    log?.(
      `    [${inserted + updated + skippedExisting}/${records.length}] ${existing ? "更新" : "新增"}: ${record.name}`
    );
  }

  return { inserted, skippedExisting, updated };
}

// ---------------------------------------------------------------------------
// 编排：多文件导入（CLI 与后台共用）
// ---------------------------------------------------------------------------

export function redactPotentialSecrets(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(DATABASE_URL|DIRECT_URL|JWT_SECRET|ADMIN_PASSWORD)=\S+/gi, "$1=[redacted]");
}

export type ImportFileInput = { filePath: string; fileName?: string };

export type PerFileResult = {
  filePath: string;
  fileName: string;
  rowCount: number;
  validCount: number;
  importableCount: number;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  errorLog: string | null;
  duplicateCount: number;
  invalidUrlCount: number;
  level1: string | null;
  level2: string | null;
  skippedRows: { row: number; name: string; reason: string }[];
};

export type RunImportOptions = {
  files: ImportFileInput[];
  dryRun: boolean;
  overwrite: boolean;
  limitRows?: number;
  batchName?: string | null;
  sourceDir?: string | null;
  // dryRun 时可传 prisma 做只读存在性检查（后台 preview）；CLI dry-run 不传（保持无 DB 行为）
  prisma?: PrismaClient | null;
  log?: (message: string) => void;
};

export type RunImportResult = {
  batchId: number | null;
  fileResults: PerFileResult[];
  aggregate: Stats;
  totals: { rows: number; imported: number; skipped: number; errors: number };
  totalImportable: number;
  totalDuplicate: number;
  totalInvalidUrl: number;
};

// ---------------------------------------------------------------------------
// 分块导入（后台任务用）：把「解析 + slug 消歧」抽成可重复执行的 plan。
//
// buildRecords 对已存在 URL 会沿用其现有 slug（urlToExistingSlug 优先），
// 因此同一批文件在多次调用间 records 顺序与长度稳定 —— 后台任务的每个分块
// 都重新构建 plan，再按 offset 取本块要处理的记录，无需把记录落库。
// ---------------------------------------------------------------------------

export type ImportPlanFile = {
  filePath: string;
  fileName: string;
  rowCount: number;
  validCount: number;
  errorCount: number;
  errorLog: string | null;
  level1: string | null;
  level2: string | null;
  recordStart: number; // 该文件记录在 plan.records 中的起始下标
  recordCount: number;
};

export type ImportPlan = {
  records: ToolRecord[];
  files: ImportPlanFile[];
  totalRows: number;
  totalValid: number;
  totalErrors: number;
};

export async function buildImportPlan(
  prisma: PrismaClient,
  files: ImportFileInput[]
): Promise<ImportPlan> {
  const usedSlugs = new Set<string>();
  const urlToExistingSlug = new Map<string, string>();

  const existing = await prisma.website.findMany({
    where: { slug: { not: null } },
    select: { slug: true, url: true },
  });
  for (const row of existing) {
    if (row.slug) {
      usedSlugs.add(row.slug);
      urlToExistingSlug.set(row.url, row.slug);
    }
  }

  const records: ToolRecord[] = [];
  const planFiles: ImportPlanFile[] = [];
  let totalRows = 0;
  let totalErrors = 0;

  for (const file of files) {
    const fileName = file.fileName ?? basename(file.filePath);
    const fileStats = emptyStats();
    const recordStart = records.length;
    let thrownError: string | null = null;

    try {
      const rows = readXlsx(file.filePath);
      fileStats.totalRows = rows.length;
      const built = buildRecords(rows, usedSlugs, urlToExistingSlug, fileStats);
      records.push(...built);
    } catch (error) {
      thrownError = redactPotentialSecrets(
        error instanceof Error ? error.message : "Unknown error"
      );
    }

    const rowErrors = fileStats.skippedRows.map(
      (skip) => `第 ${skip.row} 行 (${skip.name}): ${skip.reason}`
    );
    if (thrownError) rowErrors.unshift(`文件级错误: ${thrownError}`);
    const errorCount = fileStats.skippedRows.length + (thrownError ? 1 : 0);

    planFiles.push({
      filePath: file.filePath,
      fileName,
      rowCount: fileStats.totalRows,
      validCount: fileStats.valid,
      errorCount,
      errorLog: rowErrors.length ? rowErrors.join("\n").slice(0, ERROR_LOG_LIMIT) : null,
      level1: records[recordStart]?.level1 ?? null,
      level2: records[recordStart]?.level2 ?? null,
      recordStart,
      recordCount: records.length - recordStart,
    });
    totalRows += fileStats.totalRows;
    totalErrors += errorCount;
  }

  return { records, files: planFiles, totalRows, totalValid: records.length, totalErrors };
}

// 导入单条记录（分块任务用）：复用 importRecords 的全部保护逻辑
// （approved / human_reviewed 永不覆盖、overwrite 语义、分类与标签缓存）
export async function importSingleRecord(
  prisma: PrismaClient,
  record: ToolRecord,
  options: ImportRecordsOptions
): Promise<{ outcome: "imported" | "skipped" }> {
  const result = await importRecords(
    prisma,
    [record],
    new Map<string, number>(),
    new Map<string, number>(),
    options
  );
  return {
    outcome: result.inserted + result.updated > 0 ? "imported" : "skipped",
  };
}

export async function runImport(
  options: RunImportOptions
): Promise<RunImportResult> {
  const { files, dryRun, overwrite, limitRows, batchName, sourceDir, prisma, log } =
    options;

  const usedSlugs = new Set<string>();
  const urlToExistingSlug = new Map<string, string>();
  const categoryCache = new Map<string, number>();
  const tagCache = new Map<string, number>();
  const aggregate = emptyStats();
  const fileResults: PerFileResult[] = [];
  let batchId: number | null = null;

  // 预取现有工具（用于 slug 幂等 + preview 的 duplicate 判定）
  const existingByUrl = new Map<
    string,
    { status: string; rewriteStatus: RewriteStatus | null }
  >();
  if (prisma) {
    const rows = await prisma.website.findMany({
      where: { slug: { not: null } },
      select: {
        slug: true,
        url: true,
        status: true,
        toolDetail: { select: { rewrite_status: true } },
      },
    });
    for (const row of rows) {
      if (row.slug) {
        usedSlugs.add(row.slug);
        urlToExistingSlug.set(row.url, row.slug);
      }
      existingByUrl.set(row.url, {
        status: row.status,
        rewriteStatus: row.toolDetail?.rewrite_status ?? null,
      });
    }

    if (!dryRun) {
      const batch = await prisma.toolImportBatch.create({
        data: { name: batchName ?? null, source_dir: sourceDir ?? null },
      });
      batchId = batch.id;
    }
  }

  for (const file of files) {
    const fileName = file.fileName ?? basename(file.filePath);
    const fileStats = emptyStats();
    let importedCount = 0;
    let skippedCount = 0;
    let importableCount = 0;
    let duplicateCount = 0;
    let thrownError: string | null = null;
    let level1: string | null = null;
    let level2: string | null = null;

    try {
      const rows = readXlsx(file.filePath);
      fileStats.totalRows = rows.length;
      let records = buildRecords(rows, usedSlugs, urlToExistingSlug, fileStats);
      if (limitRows) records = records.slice(0, limitRows);
      level1 = records[0]?.level1 ?? null;
      level2 = records[0]?.level2 ?? null;

      // 计算 preview 用的 importable / duplicate（需要现有数据）
      for (const record of records) {
        const existing = existingByUrl.get(record.site);
        if (existing) {
          duplicateCount++;
          const blocked =
            existing.status === "approved" ||
            existing.rewriteStatus === RewriteStatus.human_reviewed;
          if (blocked || !overwrite) continue; // 会被跳过
        }
        importableCount++;
      }

      if (prisma && !dryRun) {
        const result = await importRecords(prisma, records, categoryCache, tagCache, {
          overwrite,
          importBatchId: batchId,
          log,
        });
        importedCount = result.inserted + result.updated;
        skippedCount = result.skippedExisting;
      }
    } catch (error) {
      thrownError = redactPotentialSecrets(
        error instanceof Error ? error.message : "Unknown error"
      );
    }

    const invalidUrlCount = fileStats.skippedRows.filter(
      (s) => s.reason === "site URL 无效或缺失"
    ).length;
    const rowErrors = fileStats.skippedRows.map(
      (skip) => `第 ${skip.row} 行 (${skip.name}): ${skip.reason}`
    );
    if (thrownError) rowErrors.unshift(`文件级错误: ${thrownError}`);
    const errorCount = fileStats.skippedRows.length + (thrownError ? 1 : 0);
    const errorLog = rowErrors.length
      ? rowErrors.join("\n").slice(0, ERROR_LOG_LIMIT)
      : null;

    fileResults.push({
      filePath: file.filePath,
      fileName,
      rowCount: fileStats.totalRows,
      validCount: fileStats.valid,
      importableCount,
      importedCount,
      skippedCount,
      errorCount,
      errorLog,
      duplicateCount,
      invalidUrlCount,
      level1,
      level2,
      skippedRows: [...fileStats.skippedRows],
    });

    // 汇总时给跳过行带上文件名，方便定位
    fileStats.skippedRows = fileStats.skippedRows.map((skip) => ({
      ...skip,
      name: `${fileName} · ${skip.name}`,
    }));
    mergeStats(aggregate, fileStats);

    if (prisma && !dryRun && batchId !== null) {
      await prisma.toolImportFile.create({
        data: {
          batch_id: batchId,
          file_path: file.filePath,
          file_name: fileName,
          row_count: fileStats.totalRows,
          imported_count: importedCount,
          skipped_count: skippedCount,
          error_count: errorCount,
          error_log: errorLog,
          level1_category: level1,
          level2_category: level2,
        },
      });
    }
  }

  const totals = fileResults.reduce(
    (acc, file) => ({
      rows: acc.rows + file.rowCount,
      imported: acc.imported + file.importedCount,
      skipped: acc.skipped + file.skippedCount,
      errors: acc.errors + file.errorCount,
    }),
    { rows: 0, imported: 0, skipped: 0, errors: 0 }
  );
  const totalImportable = fileResults.reduce((n, f) => n + f.importableCount, 0);
  const totalDuplicate = fileResults.reduce((n, f) => n + f.duplicateCount, 0);
  const totalInvalidUrl = fileResults.reduce((n, f) => n + f.invalidUrlCount, 0);

  if (prisma && !dryRun && batchId !== null) {
    await prisma.toolImportBatch.update({
      where: { id: batchId },
      data: {
        file_count: fileResults.length,
        row_count: totals.rows,
        imported_count: totals.imported,
        skipped_count: totals.skipped,
        error_count: totals.errors,
        finished_at: new Date(),
      },
    });
  }

  return {
    batchId,
    fileResults,
    aggregate,
    totals,
    totalImportable,
    totalDuplicate,
    totalInvalidUrl,
  };
}
