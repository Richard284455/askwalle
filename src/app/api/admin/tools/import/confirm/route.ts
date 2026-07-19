import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { prisma } from "@/lib/prisma";
import { runImport } from "@/lib/website/tool-import";
import { clearUpload, listUpload } from "@/lib/website/import-upload";

export const runtime = "nodejs";

// POST /api/admin/tools/import/confirm
// body: { previewToken, overwrite?, batchName? }
// 用 preview 阶段暂存的文件正式导入 → 建批次 → 清理临时文件
export async function POST(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const body = await request.json().catch(() => ({}));
  const previewToken =
    typeof body?.previewToken === "string" ? body.previewToken : "";
  const overwrite = body?.overwrite === true;
  const batchName =
    typeof body?.batchName === "string" && body.batchName.trim()
      ? body.batchName.trim()
      : null;

  const upload = listUpload(previewToken);
  if (!upload) {
    return NextResponse.json(
      AjaxResponse.fail("上传已过期或无效，请重新上传预检"),
      { status: 400 }
    );
  }

  try {
    const result = await runImport({
      files: upload.files,
      dryRun: false,
      overwrite,
      batchName,
      sourceDir: "admin-upload",
      prisma,
    });
    return NextResponse.json(
      AjaxResponse.ok({
        batchId: result.batchId,
        fileCount: result.fileResults.length,
        imported: result.totals.imported,
        skipped: result.totals.skipped,
        errors: result.totals.errors,
      })
    );
  } catch (error) {
    console.error("Import confirm failed:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json(AjaxResponse.fail("导入失败"), { status: 500 });
  } finally {
    // 无论成功失败都清理临时上传文件
    clearUpload(previewToken);
  }
}
