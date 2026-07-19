import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { prisma } from "@/lib/prisma";
import { runImport } from "@/lib/website/tool-import";
import {
  saveUploads,
  validateUploads,
  type IncomingFile,
} from "@/lib/website/import-upload";

export const runtime = "nodejs";

// POST /api/admin/tools/import/preview (multipart)
// 上传 .xlsx → 只读解析（dry-run，不写库）→ 返回预检统计 + previewToken
export async function POST(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(AjaxResponse.fail("请以 multipart 表单上传文件"), {
      status: 400,
    });
  }

  const incoming: IncomingFile[] = [];
  for (const value of form.getAll("files")) {
    if (typeof value === "string") continue;
    const bytes = Buffer.from(await value.arrayBuffer());
    incoming.push({ name: value.name, size: value.size, bytes });
  }

  const valid = validateUploads(incoming);
  if (!valid.ok) {
    return NextResponse.json(
      AjaxResponse.fail(valid.errors.map((e) => `${e.fileName}: ${e.reason}`).join("; ")),
      { status: 400 }
    );
  }

  try {
    const saved = saveUploads(incoming);
    const overwrite = form.get("overwrite") === "true";
    const result = await runImport({
      files: saved.files,
      dryRun: true,
      overwrite,
      prisma, // 只读存在性检查（duplicate / importable），不写库
    });

    const preview = {
      previewToken: saved.token,
      overwrite,
      fileCount: result.fileResults.length,
      totalRows: result.aggregate.totalRows,
      validRows: result.aggregate.valid,
      skippedRows: result.aggregate.skippedRows.length,
      errorRows: result.aggregate.skippedRows.length,
      importableCount: result.totalImportable,
      duplicateCount: result.totalDuplicate,
      invalidUrlCount: result.totalInvalidUrl,
      categorySummary: summarizeCategories(result.fileResults),
      files: result.fileResults.map((f) => ({
        fileName: f.fileName,
        rowCount: f.rowCount,
        validCount: f.validCount,
        importableCount: f.importableCount,
        skippedCount: f.skippedRows.length,
        errorCount: f.errorCount,
        duplicateCount: f.duplicateCount,
      })),
      errors: result.aggregate.skippedRows
        .slice(0, 20)
        .map((s) => ({ row: s.row, name: s.name, reason: s.reason })),
    };
    return NextResponse.json(AjaxResponse.ok(preview));
  } catch (error) {
    console.error("Import preview failed:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json(AjaxResponse.fail("预检失败，请检查文件格式"), {
      status: 500,
    });
  }
}

function summarizeCategories(
  files: { level1: string | null; level2: string | null }[]
): { label: string; fileCount: number }[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const label = f.level1
      ? f.level2
        ? `${f.level1} / ${f.level2}`
        : f.level1
      : "(未知)";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, fileCount]) => ({ label, fileCount }));
}
