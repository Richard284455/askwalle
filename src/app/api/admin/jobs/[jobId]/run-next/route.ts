import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { runNextChunk } from "@/lib/website/bulk-job";

// POST /api/admin/jobs/[jobId]/run-next
// 分块执行：每次最多处理 CHUNK_SIZE 条并更新进度（避免单请求超时）。
// 前端任务详情页循环调用直至 completed。每条服务端重新校验资格，不降低 guard。
export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const jobId = parseInt((await params).jobId);
  if (Number.isNaN(jobId)) {
    return NextResponse.json(AjaxResponse.fail("无效的任务 ID"), { status: 400 });
  }
  try {
    const outcome = await runNextChunk(jobId);
    if (!outcome.ok) {
      return NextResponse.json(AjaxResponse.fail(outcome.message), { status: 400 });
    }
    return NextResponse.json(
      AjaxResponse.ok({ job: outcome.job, processedNow: outcome.processedNow })
    );
  } catch (error) {
    console.error("Failed to run bulk job chunk:", error);
    return NextResponse.json(AjaxResponse.fail("执行任务分块失败"), { status: 500 });
  }
}
