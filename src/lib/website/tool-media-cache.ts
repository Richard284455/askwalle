import { createHash } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import type { PrismaClient } from "@prisma/client";

/**
 * ToolMedia 热链本地化：发布前常态化 guard。
 *
 * - 只处理即将发布的工具，不主动扫描全库。
 * - 下载外部图片到 public/tool-media/{websiteId}/{sha256}.{ext}（运行时缓存，
 *   已 gitignore，不提交）。
 * - 只写 local_url / original_url / cache_status / cache_error / cached_at，
 *   永不覆盖原有 url。公开页优先 local_url。
 * - 本文件不依赖 "@/" 别名、prisma 由调用方传入 —— CLI（ts-node）与
 *   Next 路由可共用同一实现。
 * - 存储抽象为 storage helper，后续可换 Supabase Storage / Vercel Blob。
 */

const PUBLIC_PREFIX = "/tool-media";
const OUTPUT_ROOT = () => path.join(process.cwd(), "public", "tool-media");
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024; // 单张 8MB

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

// 外部热链 = 绝对 http(s) URL。本站资源一律用相对路径
//（/tool-media/…、/cached-tool-media/…），因此凡绝对 URL 均视为第三方。
export function isExternalHotlink(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

export type MediaCacheRow = {
  id: number;
  url: string;
  local_url: string | null;
  cache_status: string | null;
};

export function shouldCacheToolMedia(media: MediaCacheRow): boolean {
  if (!isExternalHotlink(media.url)) return false;
  if (media.local_url && media.cache_status === "cached") return false;
  return true;
}

// ---------------------------------------------------------------------------
// 存储抽象（第一版：本地文件系统；将来可替换为对象存储实现）
// ---------------------------------------------------------------------------

type MediaStorage = {
  save(websiteId: number, fileName: string, buffer: Buffer): Promise<string>;
};

const localFsStorage: MediaStorage = {
  async save(websiteId, fileName, buffer) {
    const dir = path.join(OUTPUT_ROOT(), String(websiteId));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, fileName), buffer);
    return `${PUBLIC_PREFIX}/${websiteId}/${fileName}`;
  },
};

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

async function downloadImage(
  url: string
): Promise<
  | { ok: true; buffer: Buffer; extension: string }
  | { ok: false; reason: string }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "AskWalleMediaCache/1.0" },
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };

    const contentType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const extension = EXTENSION_BY_CONTENT_TYPE[contentType];
    if (!extension) {
      return { ok: false, reason: `非图片 content-type: ${contentType || "unknown"}` };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) return { ok: false, reason: "空响应" };
    if (buffer.length > MAX_BYTES) {
      return { ok: false, reason: `超过 ${MAX_BYTES / 1024 / 1024}MB 上限` };
    }
    return { ok: true, buffer, extension };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return { ok: false, reason: aborted ? "下载超时" : "网络错误" };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// 核心：按工具本地化
// ---------------------------------------------------------------------------

export type WebsiteMediaCacheResult = {
  websiteId: number;
  total: number;
  external: number;
  cached: number; // 本次新缓存成功
  alreadyCached: number; // 之前已缓存（幂等跳过，不重复下载）
  localSkipped: number; // 本来就是本地/相对 URL
  failed: number;
  errors: { mediaId: number; reason: string }[];
};

export async function cacheToolMediaForWebsite(
  prisma: PrismaClient,
  websiteId: number,
  options: { dryRun?: boolean; storage?: MediaStorage } = {}
): Promise<WebsiteMediaCacheResult> {
  const storage = options.storage ?? localFsStorage;
  const mediaRows = await prisma.toolMedia.findMany({
    where: { website_id: websiteId },
    orderBy: { id: "asc" },
    select: { id: true, url: true, local_url: true, cache_status: true },
  });

  const result: WebsiteMediaCacheResult = {
    websiteId,
    total: mediaRows.length,
    external: 0,
    cached: 0,
    alreadyCached: 0,
    localSkipped: 0,
    failed: 0,
    errors: [],
  };

  for (const media of mediaRows) {
    if (!isExternalHotlink(media.url)) {
      result.localSkipped++;
      continue;
    }
    result.external++;
    if (!shouldCacheToolMedia(media)) {
      result.alreadyCached++;
      continue;
    }
    if (options.dryRun) continue;

    const download = await downloadImage(media.url);
    if (!download.ok) {
      result.failed++;
      result.errors.push({ mediaId: media.id, reason: download.reason });
      await prisma.toolMedia.update({
        where: { id: media.id },
        data: {
          original_url: media.url,
          cache_status: "failed",
          cache_error: download.reason.slice(0, 300),
        },
      });
      continue;
    }

    const hash = createHash("sha256").update(download.buffer).digest("hex").slice(0, 32);
    const fileName = `${hash}.${download.extension}`;
    const localUrl = await storage.save(websiteId, fileName, download.buffer);
    await prisma.toolMedia.update({
      where: { id: media.id },
      data: {
        original_url: media.url,
        local_url: localUrl,
        cache_status: "cached",
        cache_error: null,
        cached_at: new Date(),
      },
    });
    result.cached++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// 发布前 guard
// ---------------------------------------------------------------------------

export type MediaPublishGate =
  | { ok: true; stats: WebsiteMediaCacheResult }
  | { ok: false; message: string; stats: WebsiteMediaCacheResult };

// 单工具发布前：无媒体/全本地/外链全部缓存成功 → 通过；有缓存失败 → 拦截
export async function ensureMediaLocalizedBeforePublish(
  prisma: PrismaClient,
  websiteId: number
): Promise<MediaPublishGate> {
  const stats = await cacheToolMediaForWebsite(prisma, websiteId);
  if (stats.failed > 0) {
    const reasons = stats.errors
      .map((e) => `media#${e.mediaId}: ${e.reason}`)
      .join("; ");
    return {
      ok: false,
      stats,
      message: `Media localization failed before publish: ${reasons}`,
    };
  }
  return { ok: true, stats };
}

// 批量发布前逐工具处理（供 CLI / 批量流程复用）
export async function ensureMediaLocalizedBeforeBulkPublish(
  prisma: PrismaClient,
  websiteIds: number[]
): Promise<Map<number, MediaPublishGate>> {
  const results = new Map<number, MediaPublishGate>();
  for (const websiteId of websiteIds) {
    results.set(websiteId, await ensureMediaLocalizedBeforePublish(prisma, websiteId));
  }
  return results;
}

// 只读预检（Publish 确认弹窗用，不下载不写库）
export type MediaPrecheck = {
  websites: number;
  totalMedia: number;
  externalMedia: number;
  alreadyCached: number;
  needsLocalize: number;
  previouslyFailed: number;
};

export async function precheckMediaForWebsites(
  prisma: PrismaClient,
  websiteIds: number[]
): Promise<MediaPrecheck> {
  const rows = await prisma.toolMedia.findMany({
    where: { website_id: { in: websiteIds } },
    select: { id: true, url: true, local_url: true, cache_status: true },
  });
  const precheck: MediaPrecheck = {
    websites: websiteIds.length,
    totalMedia: rows.length,
    externalMedia: 0,
    alreadyCached: 0,
    needsLocalize: 0,
    previouslyFailed: 0,
  };
  for (const media of rows) {
    if (!isExternalHotlink(media.url)) continue;
    precheck.externalMedia++;
    if (!shouldCacheToolMedia(media)) precheck.alreadyCached++;
    else {
      precheck.needsLocalize++;
      if (media.cache_status === "failed") precheck.previouslyFailed++;
    }
  }
  return precheck;
}
