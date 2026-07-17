import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { refreshOpenAIBatchStatus } from "@/lib/website/tool-rewrite-batch";

// POST /api/admin/tools/rewrite/[batchId]/refresh — 刷新 OpenAI batch 状态
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
    const result = await refreshOpenAIBatchStatus(batchId);
    if (!result.ok) {
      return NextResponse.json(AjaxResponse.fail(result.message), {
        status: 400,
      });
    }
    return NextResponse.json(AjaxResponse.ok({ status: result.status }));
  } catch (error) {
    console.error("Failed to refresh rewrite batch:", error);
    return NextResponse.json(AjaxResponse.fail("刷新状态失败"), {
      status: 500,
    });
  }
}
