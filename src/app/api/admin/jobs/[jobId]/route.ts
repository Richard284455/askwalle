import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { getBulkJob } from "@/lib/website/bulk-job";

// GET /api/admin/jobs/[jobId] — 任务详情（前端轮询）
export async function GET(
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
    const job = await getBulkJob(jobId);
    if (!job) {
      return NextResponse.json(AjaxResponse.fail("任务不存在"), { status: 404 });
    }
    return NextResponse.json(AjaxResponse.ok(job));
  } catch (error) {
    console.error("Failed to get bulk job:", error);
    return NextResponse.json(AjaxResponse.fail("获取任务失败"), { status: 500 });
  }
}
