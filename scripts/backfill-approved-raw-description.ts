/**
 * 一次性、幂等的数据卫生修复（approved 工具版）。
 *
 * 背景：早期导入的工具在导入脚本加入 description 快照之前入库，
 * raw_imported_content 缺 description。这些工具随后经过 AI 改写 → apply →
 * 审核 → 发布，Website.description 已被改写覆盖，因此**不能**用 Website.description
 * 作为 raw 快照的 description（那会把改写文本写进原始底稿，破坏回滚语义）。
 * 正确来源是源 xlsx 的原始 introduction（按工具 title 匹配）。
 *
 * 安全范围（全部满足才处理）：
 * - Website.status = approved
 * - ToolDetail.rewrite_status = human_reviewed
 * - raw_imported_content 存在（对象）且 description 缺失/为空
 * - 源 xlsx 中能按 title 匹配到非空 introduction
 *
 * 只写 raw_imported_content.description（= xlsx 原始 introduction）。
 * 不改 Website.description / status / rewrite_status / what/how/features/use_cases/
 * faqs / ai_rewrite_draft / reviewed_at / review_notes。不删任何数据。不调用 AI。
 *
 * Usage:
 *   npm run backfill:approved-raw-description                 # dry-run（默认）
 *   npm run backfill:approved-raw-description -- --apply      # 正式执行
 *   npm run backfill:approved-raw-description -- --dir 数据源  # 指定源目录（默认 数据源）
 */
import { readdirSync, statSync } from "fs";
import path from "path";
import { PrismaClient, Prisma, RewriteStatus } from "@prisma/client";
import { readXlsx } from "../src/lib/website/xlsx-reader";

const apply = process.argv.includes("--apply");
const dirIndex = process.argv.indexOf("--dir");
const sourceDir =
  dirIndex >= 0 ? process.argv[dirIndex + 1] : path.join(process.cwd(), "数据源");

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

// 递归收集目录下所有 .xlsx，构建 name → 原始 introduction 映射
function findXlsxFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("~$") || entry.startsWith(".")) continue;
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) files.push(...findXlsxFiles(fullPath));
    else if (entry.toLowerCase().endsWith(".xlsx")) files.push(fullPath);
  }
  return files;
}

function buildIntroductionMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of findXlsxFiles(sourceDir)) {
    let rows: Record<string, string>[] = [];
    try {
      rows = readXlsx(file);
    } catch {
      continue; // 单个文件读取失败不影响整体
    }
    for (const row of rows) {
      const name = (row.name ?? "").trim();
      const intro = (row.introduction ?? "").trim();
      if (name && intro && !map.has(name)) map.set(name, intro);
    }
  }
  return map;
}

async function main() {
  const introMap = buildIntroductionMap();
  console.log(`源目录: ${sourceDir}  |  xlsx name→introduction 映射: ${introMap.size}`);

  const candidates = await prisma.website.findMany({
    where: {
      status: "approved",
      toolDetail: { rewrite_status: RewriteStatus.human_reviewed },
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      title: true,
      slug: true,
      toolDetail: { select: { raw_imported_content: true } },
    },
  });

  type Target = { id: number; title: string; slug: string | null; intro: string };
  const targets: Target[] = [];
  let noIntroMatch = 0;

  for (const website of candidates) {
    const raw = asObject(website.toolDetail?.raw_imported_content);
    if (!raw) continue;
    const existing =
      typeof raw.description === "string" ? raw.description.trim() : "";
    if (existing) continue; // 已有 description → 跳过
    const intro = introMap.get(website.title);
    if (!intro) {
      noIntroMatch++;
      continue; // 源 xlsx 无匹配 → 跳过（不猜测）
    }
    targets.push({
      id: website.id,
      title: website.title,
      slug: website.slug,
      intro,
    });
  }

  console.log(`扫描 approved/human_reviewed 工具: ${candidates.length}`);
  console.log(`需要补齐 description 的记录 (wouldUpdate): ${targets.length}`);
  console.log(`raw 缺 description 但源 xlsx 无匹配 (skipped): ${noIntroMatch}`);
  for (const target of targets.slice(0, 10)) {
    console.log(`  #${target.id} ${target.title} (${target.slug ?? "no-slug"})`);
  }
  if (targets.length > 10) console.log(`  … 其余 ${targets.length - 10} 条`);

  if (!apply) {
    console.log("\n--dry-run（默认）：未写入数据库。加 --apply 正式执行。");
    return;
  }

  let updated = 0;
  for (const target of targets) {
    const detail = await prisma.toolDetail.findUnique({
      where: { website_id: target.id },
      select: { raw_imported_content: true },
    });
    const raw = asObject(detail?.raw_imported_content);
    if (!raw) continue;
    const existing =
      typeof raw.description === "string" ? raw.description.trim() : "";
    if (existing) continue; // 幂等二次确认

    await prisma.toolDetail.update({
      where: { website_id: target.id },
      data: {
        raw_imported_content: {
          ...raw,
          description: target.intro,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    updated++;
  }

  console.log(`\n补齐完成：${updated} 条 approved 工具的 raw_imported_content.description 已回填（来源: xlsx 原始 introduction）。`);
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
