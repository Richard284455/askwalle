import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { prisma } from "@/lib/prisma";
import { runImport } from "@/lib/website/tool-import";
import { claimUpload, clearClaimedUpload } from "@/lib/website/import-upload";

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

  // 原子占用 token：重复/并发 confirm 只有第一个成功，避免同一预检被重复导入
  const upload = claimUpload(previewToken);
  if (!upload) {
    return NextResponse.json(
      AjaxResponse.fail("预检已使用或已过期，请重新上传预检"),
      { status: 409 }
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
        detailUrl: `/admin/tools/import/${result.batchId}`,
      })
    );
  } catch (error) {
    console.error("Import confirm failed:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json(AjaxResponse.fail("导入失败，请稍后重试或查看导入批次列表"), {
      status: 500,
    });
  } finally {
    // 清理临时上传文件；清理失败不影响已返回的响应
    try {
      clearClaimedUpload(previewToken);
    } catch (cleanupError) {
      console.error(
        "Cleanup after import failed:",
        cleanupError instanceof Error ? cleanupError.message : "unknown"
      );
    }
  }
}
