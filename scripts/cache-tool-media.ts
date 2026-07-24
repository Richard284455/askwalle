/**
 * ToolMedia 热链本地化 CLI（辅助补历史数据；发布路径已有常态化 guard，
 * 本脚本不替代 publish guard）。
 *
 * 与发布流程共用 src/lib/website/tool-media-cache 同一实现：
 * 下载外部图片到 public/tool-media/{websiteId}/{sha256}.{ext}，
 * 只写 local_url/original_url/cache_status，不改动原 url。幂等：
 * cached 的不重复下载。
 *
 * Usage:
 *   npm run cache:tool-media -- --status approved --limit 20 --dry-run
 *   npm run cache:tool-media -- --status approved --limit 20 --apply
 */
import { PrismaClient } from "@prisma/client";
import {
  cacheToolMediaForWebsite,
  isExternalHotlink,
} from "../src/lib/website/tool-media-cache";

const prisma = new PrismaClient();

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dryRun = !process.argv.includes("--apply");
const status = argValue("status") ?? "approved";
const limit = Math.min(parseInt(argValue("limit") ?? "20") || 20, 200);

function redactPotentialSecrets(message: string) {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(DATABASE_URL|DIRECT_URL|JWT_SECRET|ADMIN_PASSWORD)=\S+/gi, "$1=[redacted]");
}

async function main() {
  // 只挑还有外链媒体的工具（按 status 过滤，limit 控制批量）
  const websites = await prisma.website.findMany({
    where: {
      status,
      toolMedia: { some: { url: { startsWith: "http" } } },
    },
    orderBy: { id: "asc" },
    take: limit,
    select: {
      id: true,
      title: true,
      toolMedia: { select: { url: true, local_url: true, cache_status: true } },
    },
  });

  const pending = websites.filter((w) =>
    w.toolMedia.some(
      (m) => isExternalHotlink(m.url) && !(m.local_url && m.cache_status === "cached")
    )
  );
  console.log(
    `status=${status} 含外链媒体的工具: ${websites.length}，其中待本地化: ${pending.length}` +
      `（limit=${limit}，${dryRun ? "dry-run" : "apply"}）`
  );

  let cached = 0;
  let failed = 0;
  for (const website of pending) {
    const result = await cacheToolMediaForWebsite(prisma, website.id, { dryRun });
    cached += result.cached;
    failed += result.failed;
    const todo = result.external - result.alreadyCached;
    console.log(
      `  W#${website.id} ${website.title.slice(0, 30)}: 外链 ${result.external}` +
        (dryRun
          ? ` → 将下载 ${todo}`
          : ` → 新缓存 ${result.cached}，已缓存 ${result.alreadyCached}，失败 ${result.failed}` +
            (result.errors.length
              ? ` [${result.errors.map((e) => e.reason).join("; ")}]`
              : ""))
    );
  }

  console.log(
    dryRun
      ? "dry-run 完成：未下载、未写数据库。加 --apply 执行。"
      : `完成：本地化 ${cached} 张，失败 ${failed} 张（失败可重跑，publish 时也会重试）。`
  );
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
