import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { createImportJob } from "@/lib/website/bulk-job";
import { claimUpload, clearClaimedUpload } from "@/lib/website/import-upload";

export const runtime = "nodejs";

// POST /api/admin/tools/import/confirm-job
// body: { previewToken, overwrite?, batchName? }
// 创建后台导入任务（不在本请求内导入）：原子占用上传 → 解析建 plan →
// 建 ToolImportBatch + BulkJob(items 按行) → 返回 jobId，由任务页分块执行。
// 临时上传文件保留到任务收尾时再清理（分块执行需要重复读取）。
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

  // 原子占用：重复/并发 confirm 只有第一个成功
  const upload = claimUpload(previewToken);
  if (!upload) {
    return NextResponse.json(
      AjaxResponse.fail("预检已使用或已过期，请重新上传预检"),
      { status: 409 }
    );
  }

  try {
    const created = await createImportJob({
      files: upload.files,
      overwrite,
      batchName,
      previewToken,
    });
    if (!created.ok) {
      // 创建失败即释放占用的上传文件，避免残留
      clearClaimedUpload(previewToken);
      return NextResponse.json(AjaxResponse.fail(created.message), { status: 400 });
    }
    return NextResponse.json(
      AjaxResponse.ok({
        ...created,
        jobUrl: `/admin/jobs/${created.jobId}`,
        detailUrl: `/admin/tools/import/${created.batchId}`,
      })
    );
  } catch (error) {
    console.error(
      "Failed to create import job:",
      error instanceof Error ? error.message : "unknown"
    );
    try {
      clearClaimedUpload(previewToken);
    } catch {
      // 清理失败不影响错误响应
    }
    return NextResponse.json(
      AjaxResponse.fail("创建导入任务失败，请重新预检后重试"),
      { status: 500 }
    );
  }
}
