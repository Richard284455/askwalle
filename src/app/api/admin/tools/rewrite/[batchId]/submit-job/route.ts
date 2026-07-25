import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { createRewriteJob } from "@/lib/website/bulk-job";

export const runtime = "nodejs";

// POST /api/admin/tools/rewrite/[batchId]/submit-job
// 直连 provider 的异步执行入口：只创建后台任务并返回 jobId，
// 真正的 AI 调用由任务页循环调用 run-next 分块完成（每块 1 条）。
export async function POST(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const batchId = parseInt((await params).batchId);
  if (Number.isNaN(batchId)) {
    return NextResponse.json(AjaxResponse.fail("无效的批次 ID"), { status: 400 });
  }

  try {
    const created = await createRewriteJob(batchId);
    if (!created.ok) {
      return NextResponse.json(AjaxResponse.fail(created.message), { status: 400 });
    }
    return NextResponse.json(
      AjaxResponse.ok({ ...created, jobUrl: `/admin/jobs/${created.jobId}` })
    );
  } catch (error) {
    console.error(
      "Failed to create rewrite job:",
      error instanceof Error ? error.message : "unknown"
    );
    return NextResponse.json(AjaxResponse.fail("创建改写任务失败"), { status: 500 });
  }
}
