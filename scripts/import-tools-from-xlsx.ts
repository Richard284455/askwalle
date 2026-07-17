/**
 * Import AI tools from Toolify-style xlsx exports into Website/Category/Tool* tables.
 *
 * Usage:
 *   npm run import:tools -- --file <path.xlsx>            # 单文件导入
 *   npm run import:tools -- --dir 数据源                   # 目录递归批量导入(.xlsx)
 *   npm run import:tools -- --dir 数据源 --dry-run          # 全目录清洗统计，不写数据库
 *   npm run import:tools -- --dir 数据源 --limit-files 2    # 只处理前 N 个文件
 *   npm run import:tools -- --limit-rows 20               # 每个文件最多导入 N 行
 *   npm run import:tools -- --batch-name "first-batch"    # 批次名称
 *   npm run import:tools -- --overwrite                   # 显式允许覆盖已存在记录
 *
 * 正式导入会写入 ToolImportBatch / ToolImportFile 批次记录。
 * 导入的工具默认 status=pending，需人工审核后发布。
 * 来源文本(what/how/features/cases/faq)作为内部底稿导入，不直接作为公开原创内容。
 * 已 human_reviewed 的工具不会被 --overwrite 覆盖。
 */
import { inflateRawSync } from "zlib";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import {
  Prisma,
  PrismaClient,
  RewriteStatus,
  ToolLinkKind,
  ToolTagKind,
} from "@prisma/client";
import { bestToolSlug } from "./lib/slug-utils";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const overwrite = argv.includes("--overwrite");

function argValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function intArg(flag: string): number | undefined {
  const raw = argValue(flag);
  if (raw === undefined) {
    if (argv.includes(flag)) {
      console.error(`${flag} 需要一个正整数参数`);
      process.exit(1);
    }
    return undefined;
  }
  const value = parseInt(raw, 10);
  if (Number.isNaN(value) || value <= 0) {
    console.error(`${flag} 需要一个正整数参数`);
    process.exit(1);
  }
  return value;
}

const limitFiles = intArg("--limit-files");
// --limit 为旧用法别名，等价于 --limit-rows（每个文件的行数上限）
const limitRows = intArg("--limit-rows") ?? intArg("--limit");
const batchName = argValue("--batch-name");
const singleFile = argValue("--file");
const sourceDir = argValue("--dir");

if (singleFile && sourceDir) {
  console.error("--file 与 --dir 不能同时使用");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Minimal xlsx (zip + xml) reader — 零依赖，仅覆盖本数据源需要的特性
// ---------------------------------------------------------------------------

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  // 定位 End of Central Directory (PK\x05\x06)
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是合法的 xlsx/zip 文件");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();

  for (let n = 0; n < entryCount; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");

    // 本地文件头: PK\x03\x04
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siMatches = xml.match(/<si>[\s\S]*?<\/si>/g) ?? [];
  for (const si of siMatches) {
    let text = "";
    const tMatches = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [];
    for (const t of tMatches) {
      text += unescapeXml(t.replace(/<t[^>]*>/, "").replace(/<\/t>$/, ""));
    }
    strings.push(text);
  }
  return strings;
}

function columnIndex(cellRef: string): number {
  const letters = cellRef.replace(/\d+$/, "");
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function parseSheetRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const rowMatches = xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? [];
  for (const rowXml of rowMatches) {
    const cells: string[] = [];
    const cellMatches =
      rowXml.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? [];
    for (const cellXml of cellMatches) {
      const refMatch = cellXml.match(/r="([A-Z]+\d+)"/);
      if (!refMatch) continue;
      const col = columnIndex(refMatch[1]);
      const typeMatch = cellXml.match(/t="(\w+)"/);
      const type = typeMatch?.[1];
      let value = "";
      if (type === "inlineStr") {
        const t = cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        value = t ? unescapeXml(t[1]) : "";
      } else {
        const v = cellXml.match(/<v>([\s\S]*?)<\/v>/);
        if (v) {
          value =
            type === "s"
              ? shared[parseInt(v[1], 10)] ?? ""
              : unescapeXml(v[1]);
        }
      }
      cells[col] = value;
    }
    rows.push(cells);
  }
  return rows;
}

function readXlsx(filePath: string): Record<string, string>[] {
  const entries = readZipEntries(readFileSync(filePath));
  const sheetEntry =
    entries.get("xl/worksheets/sheet1.xml") ??
    [...entries.keys()]
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort()
      .map((k) => entries.get(k))[0];
  if (!sheetEntry) throw new Error("xlsx 中找不到工作表");
  const shared = entries.has("xl/sharedStrings.xml")
    ? parseSharedStrings(entries.get("xl/sharedStrings.xml")!.toString("utf8"))
    : [];
  const rows = parseSheetRows(
    Buffer.isBuffer(sheetEntry) ? sheetEntry.toString("utf8") : "",
    shared
  );
  if (rows.length < 2) return [];
  // 表头小写归一化：容忍个别文件的大小写差异（如 Introduction vs introduction）
  const header = rows[0].map((h) => (h ?? "").trim().toLowerCase());
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    header.forEach((name, i) => {
      if (name) record[name] = (row[i] ?? "").trim();
    });
    return record;
  });
}

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

type ToolRecord = {
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

type Stats = {
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

function buildRecords(
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
        reason: !name ? "缺少 name" : !introduction ? "缺少 introduction" : "site URL 无效或缺失",
      });
      return;
    }
    if ((row.site ?? "").length !== site.length) stats.siteCleaned++;

    // 同一 URL 的已有记录沿用其现有 slug，保证重复导入幂等；否则生成并消歧
    // （标题无法生成有意义 slug 时回退到官网域名，见 lib/slug-utils）
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

const IMPORT_SOURCE = "toolify-xlsx-import";

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

async function importRecords(
  prisma: PrismaClient,
  records: ToolRecord[],
  categoryCache: Map<string, number>,
  tagCache: Map<string, number>
) {
  let inserted = 0;
  let skippedExisting = 0;
  let updated = 0;

  {
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
        toolDetail: { select: { rewrite_status: true } },
      },
    });
    const existingBySlug = new Map(
      existingWebsites.filter((w) => w.slug).map((w) => [w.slug as string, w])
    );
    const existingByUrl = new Map(existingWebsites.map((w) => [w.url, w]));

    for (const record of records) {
      const parentId = await ensureCategory(
        prisma,
        categoryCache,
        record.level1,
        null
      );
      const categoryId = await ensureCategory(
        prisma,
        categoryCache,
        record.level2,
        parentId
      );

      const existing =
        existingBySlug.get(record.slug) ?? existingByUrl.get(record.site);
      if (existing && !overwrite) {
        skippedExisting++;
        continue;
      }
      // 已人工审核的工具不允许被覆盖导入清掉编辑成果
      if (
        existing &&
        existing.toolDetail?.rewrite_status === RewriteStatus.human_reviewed
      ) {
        skippedExisting++;
        console.log(`  跳过(已人工审核): ${record.name}`);
        continue;
      }

      const websiteData = {
        title: record.name,
        url: record.site,
        description: record.introduction,
        slug: record.slug,
        category_id: categoryId,
        status: "pending",
      };

      let websiteId: number;
      let hasCachedMedia = false;
      if (existing) {
        await prisma.website.update({
          where: { id: existing.id },
          data: websiteData,
        });
        websiteId = existing.id;
        await prisma.websiteToolTag.deleteMany({ where: { website_id: websiteId } });
        await prisma.toolLink.deleteMany({ where: { website_id: websiteId } });
        // 已通过 cache:tool-media 本地化的媒体在覆盖导入时保留，
        // 只清除仍指向远程的媒体行，避免缓存被重置回远程 URL
        hasCachedMedia =
          (await prisma.toolMedia.count({
            where: {
              website_id: websiteId,
              url: { startsWith: "/cached-tool-media/" },
            },
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
        // 原始导入底稿快照 + 审核流起点状态
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
          data: tagIds.map((tagId) => ({
            website_id: websiteId,
            tag_id: tagId,
          })),
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

      // 已有本地缓存媒体时跳过重建；新导入的远程 URL 可随后用 npm run cache:tool-media 本地化
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

      console.log(
        `    [${inserted + updated + skippedExisting}/${records.length}] ${existing ? "更新" : "新增"}: ${record.name}`
      );
    }
  }

  return { inserted, skippedExisting, updated };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function redactPotentialSecrets(message: string) {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(DATABASE_URL|DIRECT_URL|JWT_SECRET|ADMIN_PASSWORD)=\S+/gi, "$1=[redacted]");
}

function printStats(stats: Stats, records: ToolRecord[]) {
  console.log("== 清洗统计 ==");
  console.log(`总数据行: ${stats.totalRows}`);
  console.log(`有效记录: ${stats.valid}`);
  console.log(`跳过行数: ${stats.skippedRows.length}`);
  for (const skip of stats.skippedRows.slice(0, 10)) {
    console.log(`  - 第 ${skip.row} 行 (${skip.name}): ${skip.reason}`);
  }
  console.log(`site 清除追踪参数: ${stats.siteCleaned}`);
  console.log(`slug 重名消歧: ${stats.slugDisambiguated.length} ${JSON.stringify(stats.slugDisambiguated)}`);
  console.log(`monthly_visitors 可解析: ${stats.monthlyParsed}（其余为 "--"/空 → null）`);
  console.log(`标签数(按类): ${JSON.stringify(stats.tagCounts)}`);
  console.log(`唯一 topic 标签数: ${stats.uniqueTopicTags.size}`);
  console.log(`链接数(按类): ${JSON.stringify(stats.linkCounts)}`);
  console.log(`媒体图片总数: ${stats.mediaTotal}`);
  console.log(`FAQ 问题总数: ${stats.faqQuestions}（answer 一律 null）; 污染被剔除行: ${stats.faqFlagged}`);
  console.log(`features 可拆数组: ${stats.featuresSplit}/${stats.valid}（其余仅存 features_text）`);
  console.log(`cases 按 #N 拆分: ${stats.casesSplit}/${stats.valid}`);
  if (records.length) {
    const sample = records[0];
    console.log("== 首条清洗样例 ==");
    console.log(
      JSON.stringify(
        {
          name: sample.name,
          slug: sample.slug,
          site: sample.site,
          rating: sample.rating,
          monthlyVisitors: sample.monthlyVisitors,
          tags: sample.tags.slice(0, 6),
          links: sample.links.slice(0, 4),
          media: sample.media,
          faqCount: sample.faq.length,
          useCaseCount: sample.useCases.length,
          featuresIsArray: Array.isArray(sample.features),
        },
        null,
        2
      )
    );
  }
}

function emptyStats(totalRows = 0): Stats {
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

function mergeStats(target: Stats, source: Stats): void {
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

// 递归收集目录下所有 .xlsx（忽略 Office 临时文件），按路径排序
function findXlsxFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("~$") || entry.startsWith(".")) continue;
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...findXlsxFiles(fullPath));
    } else if (entry.toLowerCase().endsWith(".xlsx")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

type FileResult = {
  filePath: string;
  fileName: string;
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  errorLog: string | null;
  level1: string | null;
  level2: string | null;
};

const ERROR_LOG_LIMIT = 4000;

async function main() {
  // 解析文件清单
  let files: string[];
  if (sourceDir) {
    files = findXlsxFiles(sourceDir);
    if (!files.length) {
      console.error(`目录中没有找到 .xlsx 文件: ${sourceDir}`);
      process.exit(1);
    }
  } else {
    files = [
      singleFile ?? path.join(process.cwd(), "数据源", "AI Creative Writing.xlsx"),
    ];
  }
  const totalFound = files.length;
  if (limitFiles) files = files.slice(0, limitFiles);

  console.log(
    `数据源: ${sourceDir ?? files[0]}（发现 ${totalFound} 个文件，处理 ${files.length} 个）` +
      (dryRun ? " [dry-run]" : "") +
      (limitRows ? ` [每文件最多 ${limitRows} 行]` : "")
  );

  const prisma = dryRun ? null : new PrismaClient();
  const usedSlugs = new Set<string>();
  const urlToExistingSlug = new Map<string, string>();
  const categoryCache = new Map<string, number>();
  const tagCache = new Map<string, number>();
  const aggregate = emptyStats();
  const fileResults: FileResult[] = [];
  let batchId: number | null = null;

  try {
    if (prisma) {
      const existingWebsites = await prisma.website.findMany({
        where: { slug: { not: null } },
        select: { slug: true, url: true },
      });
      for (const row of existingWebsites) {
        if (row.slug) {
          usedSlugs.add(row.slug);
          urlToExistingSlug.set(row.url, row.slug);
        }
      }

      const batch = await prisma.toolImportBatch.create({
        data: {
          name: batchName ?? null,
          source_dir: sourceDir ?? null,
        },
      });
      batchId = batch.id;
      console.log(`批次 #${batchId}${batchName ? ` (${batchName})` : ""} 开始`);
    }

    for (const [index, filePath] of files.entries()) {
      const fileName = path.basename(filePath);
      const fileStats = emptyStats();
      let importedCount = 0;
      let skippedCount = 0;
      let thrownError: string | null = null;
      let level1: string | null = null;
      let level2: string | null = null;

      try {
        const rows = readXlsx(filePath);
        fileStats.totalRows = rows.length;
        let records = buildRecords(rows, usedSlugs, urlToExistingSlug, fileStats);
        if (limitRows) records = records.slice(0, limitRows);
        level1 = records[0]?.level1 ?? null;
        level2 = records[0]?.level2 ?? null;

        if (prisma) {
          const result = await importRecords(
            prisma,
            records,
            categoryCache,
            tagCache
          );
          importedCount = result.inserted + result.updated;
          skippedCount = result.skippedExisting;
        }
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
      const errorLog = rowErrors.length
        ? rowErrors.join("\n").slice(0, ERROR_LOG_LIMIT)
        : null;

      const result: FileResult = {
        filePath,
        fileName,
        rowCount: fileStats.totalRows,
        importedCount,
        skippedCount,
        errorCount,
        errorLog,
        level1,
        level2,
      };
      fileResults.push(result);
      // 汇总时给跳过行带上文件名，方便定位
      fileStats.skippedRows = fileStats.skippedRows.map((skip) => ({
        ...skip,
        name: `${fileName} · ${skip.name}`,
      }));
      mergeStats(aggregate, fileStats);

      console.log(
        `[${index + 1}/${files.length}] ${fileName} — 行:${result.rowCount} 有效:${fileStats.valid} ` +
          (dryRun
            ? `(dry-run 未写入) `
            : `导入:${importedCount} 跳过:${skippedCount} `) +
          `错误:${errorCount}` +
          (thrownError ? `  !! ${thrownError.slice(0, 80)}` : "")
      );

      if (prisma && batchId !== null) {
        await prisma.toolImportFile.create({
          data: {
            batch_id: batchId,
            file_path: filePath,
            file_name: fileName,
            row_count: result.rowCount,
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

    if (prisma && batchId !== null) {
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

    console.log("");
    printStats(aggregate, []);
    console.log("\n== 批次汇总 ==");
    console.log(
      `文件: ${fileResults.length}  总行: ${totals.rows}  导入: ${totals.imported}  跳过: ${totals.skipped}  错误: ${totals.errors}`
    );
    if (dryRun) {
      console.log("--dry-run：未写入数据库，未创建批次记录。");
    } else {
      console.log(
        `批次记录: ToolImportBatch #${batchId}（含 ${fileResults.length} 条 ToolImportFile）。导入工具均为 status=pending。`
      );
      if (!overwrite && totals.skipped > 0) {
        console.log("提示：默认跳过已存在记录；使用 --overwrite 显式覆盖（human_reviewed 除外）。");
      }
    }
  } finally {
    if (prisma) await prisma.$disconnect();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`工具导入失败: ${redactPotentialSecrets(message)}`);
  process.exitCode = 1;
});
