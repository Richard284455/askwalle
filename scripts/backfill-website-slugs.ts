/**
 * Backfill / optimize Website.slug.
 *
 * Usage:
 *   npm run backfill:slugs -- --dry-run   # 只打印将要生成的 slug，不写数据库
 *   npm run backfill:slugs                # 为缺 slug 的 approved 工具回填
 *   npm run backfill:slugs -- --optimize  # 重写低质量 slug（tool-{id} 兜底格式或过短），
 *                                         # 用官网域名生成更有意义的 slug
 *
 * 安全约束：
 * - 回填只处理 status=approved 且 slug 为空的记录。
 * - 不覆盖正常 slug（--optimize 只碰 tool-{id}/过短的），不修改 status，不删除数据。
 * - 旧 slug 中 tool-{id} 格式的链接仍可通过详情页 legacy id 回退访问。
 */
import { PrismaClient } from "@prisma/client";
import { bestToolSlug, isLowQualitySlug } from "../src/lib/website/slug-utils";

const dryRun = process.argv.includes("--dry-run");
const optimize = process.argv.includes("--optimize");
const prisma = new PrismaClient();

function redactPotentialSecrets(message: string) {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(DATABASE_URL|DIRECT_URL|JWT_SECRET|ADMIN_PASSWORD)=\S+/gi, "$1=[redacted]");
}

function uniqueSlug(base: string, usedSlugs: Set<string>): string {
  if (!usedSlugs.has(base)) return base;
  let n = 2;
  while (usedSlugs.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

async function main() {
  const existing = await prisma.website.findMany({
    where: { slug: { not: null } },
    select: { slug: true },
  });
  const usedSlugs = new Set(
    existing.map((row) => row.slug).filter((slug): slug is string => Boolean(slug))
  );

  let updated = 0;

  if (optimize) {
    const all = await prisma.website.findMany({
      where: { slug: { not: null } },
      select: { id: true, title: true, url: true, slug: true },
      orderBy: { id: "asc" },
    });
    const candidates = all.filter(
      (website) => website.slug && isLowQualitySlug(website.slug)
    );
    console.log(`低质量 slug 待优化: ${candidates.length}`);

    for (const website of candidates) {
      const base = bestToolSlug(website.title, website.url, website.id);
      if (base === website.slug || isLowQualitySlug(base)) {
        console.log(`  #${website.id} ${website.slug} 保留（无更优候选）`);
        continue;
      }
      usedSlugs.delete(website.slug as string);
      const slug = uniqueSlug(base, usedSlugs);
      usedSlugs.add(slug);

      console.log(`  #${website.id} ${website.title}: ${website.slug} -> ${slug}`);
      if (!dryRun) {
        await prisma.website.update({
          where: { id: website.id },
          data: { slug },
        });
        updated++;
      }
    }

    console.log(
      dryRun ? `--dry-run：未写入数据库。` : `优化完成：${updated} 条。`
    );
    return;
  }

  const missing = await prisma.website.findMany({
    where: { status: "approved", slug: null },
    select: { id: true, title: true, url: true },
    orderBy: { id: "asc" },
  });

  console.log(`待回填 approved 工具: ${missing.length}（已有 slug: ${usedSlugs.size}）`);

  for (const website of missing) {
    const slug = uniqueSlug(
      bestToolSlug(website.title, website.url, website.id),
      usedSlugs
    );
    usedSlugs.add(slug);

    console.log(`  #${website.id} ${website.title} -> ${slug}`);
    if (!dryRun) {
      await prisma.website.update({
        where: { id: website.id },
        data: { slug },
      });
      updated++;
    }
  }

  console.log(
    dryRun
      ? `--dry-run：未写入数据库（预计回填 ${missing.length} 条）。`
      : `回填完成：${updated} 条。`
  );
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Slug 回填失败: ${redactPotentialSecrets(message)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
