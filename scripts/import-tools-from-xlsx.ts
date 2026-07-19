/**
 * Import AI tools from Toolify-style xlsx exports into Website/Category/Tool* tables.
 *
 * 薄壳：解析 CLI 参数 → 调用共享导入逻辑 src/lib/website/tool-import.ts。
 * 后台 (/api/admin/tools/import) 与本 CLI 共用同一条解析/清洗/统计/落库路径。
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
 * 正式导入写入 ToolImportBatch / ToolImportFile 批次记录。导入工具默认
 * status=pending / rewrite_status=raw_imported。approved / human_reviewed
 * 工具永不被覆盖。
 */
import { readdirSync, statSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import {
  emptyStats,
  mergeStats,
  redactPotentialSecrets,
  runImport,
  type ImportFileInput,
  type Stats,
} from "../src/lib/website/tool-import";

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

function printStats(stats: Stats) {
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
}

async function main() {
  let filePaths: string[];
  if (sourceDir) {
    filePaths = findXlsxFiles(sourceDir);
    if (!filePaths.length) {
      console.error(`目录中没有找到 .xlsx 文件: ${sourceDir}`);
      process.exit(1);
    }
  } else {
    filePaths = [
      singleFile ?? path.join(process.cwd(), "数据源", "AI Creative Writing.xlsx"),
    ];
  }
  const totalFound = filePaths.length;
  if (limitFiles) filePaths = filePaths.slice(0, limitFiles);

  console.log(
    `数据源: ${sourceDir ?? filePaths[0]}（发现 ${totalFound} 个文件，处理 ${filePaths.length} 个）` +
      (dryRun ? " [dry-run]" : "") +
      (limitRows ? ` [每文件最多 ${limitRows} 行]` : "")
  );

  const prisma = dryRun ? null : new PrismaClient();
  const files: ImportFileInput[] = filePaths.map((filePath) => ({ filePath }));

  try {
    if (prisma && !dryRun) {
      console.log(`批次${batchName ? ` (${batchName})` : ""} 开始`);
    }

    const result = await runImport({
      files,
      dryRun,
      overwrite,
      limitRows,
      batchName,
      sourceDir,
      prisma,
      log: (message) => console.log(message),
    });

    // 逐文件行（与旧版一致的展示）
    result.fileResults.forEach((file, index) => {
      console.log(
        `[${index + 1}/${result.fileResults.length}] ${file.fileName} — 行:${file.rowCount} 有效:${file.validCount} ` +
          (dryRun
            ? `(dry-run 未写入) `
            : `导入:${file.importedCount} 跳过:${file.skippedCount} `) +
          `错误:${file.errorCount}`
      );
    });

    // 汇总统计（skippedRows 已在 aggregate 中带文件名）
    const printable = emptyStats();
    mergeStats(printable, result.aggregate);
    console.log("");
    printStats(printable);
    console.log("\n== 批次汇总 ==");
    console.log(
      `文件: ${result.fileResults.length}  总行: ${result.totals.rows}  导入: ${result.totals.imported}  跳过: ${result.totals.skipped}  错误: ${result.totals.errors}`
    );
    if (dryRun) {
      console.log("--dry-run：未写入数据库，未创建批次记录。");
    } else {
      console.log(
        `批次记录: ToolImportBatch #${result.batchId}（含 ${result.fileResults.length} 条 ToolImportFile）。导入工具均为 status=pending。`
      );
      if (!overwrite && result.totals.skipped > 0) {
        console.log("提示：默认跳过已存在记录；使用 --overwrite 显式覆盖（human_reviewed / approved 除外）。");
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
