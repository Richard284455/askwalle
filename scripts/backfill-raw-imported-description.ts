/**
 * 一次性、幂等的数据卫生修复：为早期导入工具补齐 raw_imported_content.description。
 *
 * 背景：早期导入（在导入脚本加入 description 快照之前）的工具，其
 * raw_imported_content 缺少 description 字段。复原/回滚到 raw 快照时会把
 * Website.description 清空。本脚本把当前 Website.description 写回快照，供后续
 * 安全复原使用。
 *
 * 安全范围（全部条件同时满足才处理）：
 * - ToolDetail.rewrite_status = raw_imported
 * - Website.status = pending
 * - raw_imported_content 存在（对象）
 * - raw_imported_content.description 缺失或为空
 * - Website.description 非空
 *
 * 只写 raw_imported_content.description，其余字段（Website.description、status、
 * rewrite_status、what/how/features/use_cases/faqs、ai_rewrite_draft、
 * reviewed_at、review_notes）一律不动。不处理 human_reviewed / approved。
 *
 * Usage:
 *   npm run backfill:raw-description              # dry-run（默认，不写库）
 *   npm run backfill:raw-description -- --apply   # 正式执行
 */
import { PrismaClient, Prisma, RewriteStatus } from "@prisma/client";

const apply = process.argv.includes("--apply");
const prisma = new PrismaClient();

function redactPotentialSecrets(message: string) {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(DATABASE_URL|DIRECT_URL|JWT_SECRET|ADMIN_PASSWORD)=\S+/gi, "$1=[redacted]");
}

function asObject(
  value: Prisma.JsonValue | null | undefined
): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function main() {
  const candidates = await prisma.website.findMany({
    where: {
      status: "pending",
      toolDetail: { rewrite_status: RewriteStatus.raw_imported },
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      title: true,
      slug: true,
      description: true,
      toolDetail: { select: { raw_imported_content: true } },
    },
  });

  type Target = { id: number; title: string; slug: string | null };
  const targets: Target[] = [];

  for (const website of candidates) {
    const raw = asObject(website.toolDetail?.raw_imported_content);
    if (!raw) continue; // raw_imported_content 不存在或非对象 → 跳过
    const existing =
      typeof raw.description === "string" ? raw.description.trim() : "";
    if (existing) continue; // 已有 description → 跳过
    if (!website.description.trim()) continue; // Website.description 为空 → 无可回填
    targets.push({ id: website.id, title: website.title, slug: website.slug });
  }

  console.log(`扫描 pending/raw_imported 工具: ${candidates.length}`);
  console.log(`需要补齐 description 的记录 (wouldUpdate): ${targets.length}`);
  for (const target of targets.slice(0, 10)) {
    console.log(`  #${target.id} ${target.title} (${target.slug ?? "no-slug"})`);
  }
  if (targets.length > 10) {
    console.log(`  … 其余 ${targets.length - 10} 条`);
  }

  if (!apply) {
    console.log("\n--dry-run（默认）：未写入数据库。加 --apply 正式执行。");
    return;
  }

  let updated = 0;
  for (const target of targets) {
    // 逐条读取当前快照 → 只合并 description，其余字段原样保留
    const detail = await prisma.toolDetail.findUnique({
      where: { website_id: target.id },
      select: { raw_imported_content: true },
    });
    const raw = asObject(detail?.raw_imported_content);
    const website = await prisma.website.findUnique({
      where: { id: target.id },
      select: { description: true },
    });
    if (!raw || !website?.description?.trim()) continue;
    const existing =
      typeof raw.description === "string" ? raw.description.trim() : "";
    if (existing) continue; // 幂等：并发/重复执行时二次确认

    await prisma.toolDetail.update({
      where: { website_id: target.id },
      data: {
        raw_imported_content: {
          ...raw,
          description: website.description,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    updated++;
  }

  console.log(`\n补齐完成：${updated} 条 raw_imported_content.description 已回填。`);
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`回填失败: ${redactPotentialSecrets(message)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
