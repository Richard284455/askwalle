import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { listBulkJobs } from "@/lib/website/bulk-job";

// GET /api/admin/jobs — 最近批量任务列表
export async function GET() {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const jobs = await listBulkJobs();
    return NextResponse.json(AjaxResponse.ok(jobs));
  } catch (error) {
    console.error("Failed to list bulk jobs:", error);
    return NextResponse.json(AjaxResponse.fail("获取任务列表失败"), { status: 500 });
  }
}
