/**
 * Cache remote ToolMedia images into public/cached-tool-media and
 * rewrite ToolMedia.url to the local path, removing the long-term
 * dependency on external CDNs.
 *
 * Usage:
 *   npm run cache:tool-media -- --dry-run   # 只列出将要下载的图片
 *   npm run cache:tool-media                # 下载并把 url 重写为本地路径
 *
 * 行为：
 * - 只处理 url 为 http(s) 的记录；已是本地路径(/cached-tool-media/…)的跳过，天然幂等。
 * - 下载失败的记录保留原 URL 并记入统计，不中断整体执行。
 * - 不删除任何数据库记录。
 */
import { mkdirSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";

const dryRun = process.argv.includes("--dry-run");
const prisma = new PrismaClient();

const OUTPUT_DIR = path.join(process.cwd(), "public", "cached-tool-media");
const PUBLIC_PREFIX = "/cached-tool-media";
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024; // 单张图片上限 8MB

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

function redactPotentialSecrets(message: string) {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(DATABASE_URL|DIRECT_URL|JWT_SECRET|ADMIN_PASSWORD)=\S+/gi, "$1=[redacted]");
}

async function downloadImage(
  url: string
): Promise<{ buffer: Buffer; extension: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "AskWalleMediaCache/1.0" },
    });
    if (!response.ok) return null;

    const contentType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const extension = EXTENSION_BY_CONTENT_TYPE[contentType];
    if (!extension) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_BYTES) return null;

    return { buffer, extension };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const remoteMedia = await prisma.toolMedia.findMany({
    where: { url: { startsWith: "http" } },
    select: { id: true, website_id: true, url: true },
    orderBy: { id: "asc" },
  });

  const localCount = await prisma.toolMedia.count({
    where: { url: { startsWith: PUBLIC_PREFIX } },
  });
  console.log(`远程图片: ${remoteMedia.length}，已本地化: ${localCount}`);

  if (dryRun) {
    for (const media of remoteMedia.slice(0, 30)) {
      console.log(`  media#${media.id} <- ${media.url.slice(0, 90)}`);
    }
    console.log("--dry-run：未下载、未写数据库。");
    return;
  }

  if (remoteMedia.length && !existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  let cached = 0;
  let failed = 0;

  for (const media of remoteMedia) {
    const result = await downloadImage(media.url);
    if (!result) {
      failed++;
      console.warn(`  media#${media.id} 下载失败，保留原 URL`);
      continue;
    }

    const fileName = `tool-${media.website_id}-media-${media.id}.${result.extension}`;
    writeFileSync(path.join(OUTPUT_DIR, fileName), result.buffer);

    await prisma.toolMedia.update({
      where: { id: media.id },
      data: { url: `${PUBLIC_PREFIX}/${fileName}` },
    });
    cached++;
    console.log(`  media#${media.id} -> ${PUBLIC_PREFIX}/${fileName}`);
  }

  console.log(`完成：本地化 ${cached} 张，失败 ${failed} 张（失败的保留原 URL，可重跑）。`);
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`工具媒体缓存失败: ${redactPotentialSecrets(message)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
