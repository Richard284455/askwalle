import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { submitRewriteBatch } from "@/lib/website/tool-rewrite-batch";

// POST /api/admin/tools/rewrite/[batchId]/submit
// openai: 提交到 Batch API（异步）；其它 provider: 直连模式同步执行完毕
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
    const result = await submitRewriteBatch(batchId);
    if (!result.ok) {
      return NextResponse.json(AjaxResponse.fail(result.message), {
        status: 400,
      });
    }
    return NextResponse.json(
      AjaxResponse.ok(
        result.mode === "batch"
          ? { mode: "batch", openaiBatchId: result.openaiBatchId }
          : {
              mode: "direct",
              saved: result.saved,
              qcFailed: result.qcFailed,
              failed: result.failed,
            }
      )
    );
  } catch (error) {
    console.error("Failed to submit rewrite batch:", error);
    return NextResponse.json(AjaxResponse.fail("提交批次失败"), {
      status: 500,
    });
  }
}
