import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { importOpenAIBatchResults } from "@/lib/website/tool-rewrite-batch";

// POST /api/admin/tools/rewrite/[batchId]/import-results
// 下载结果并做 QC；通过项写入 ToolDetail.ai_rewrite_draft（draft_generated），
// 绝不设置 human_reviewed / approved
export async function POST(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const batchId = parseInt((await params).batchId);
  if (Number.isNaN(batchId)) {
    return NextResponse.json(AjaxResponse.fail("无效的批次 ID"), {
      status: 400,
    });
  }

  try {
    const result = await importOpenAIBatchResults(batchId);
    if (!result.ok) {
      return NextResponse.json(AjaxResponse.fail(result.message), {
        status: 400,
      });
    }
    return NextResponse.json(
      AjaxResponse.ok({
        saved: result.saved,
        qcFailed: result.qcFailed,
        failed: result.failed,
      })
    );
  } catch (error) {
    console.error("Failed to import rewrite results:", error);
    return NextResponse.json(AjaxResponse.fail("导入结果失败"), {
      status: 500,
    });
  }
}
