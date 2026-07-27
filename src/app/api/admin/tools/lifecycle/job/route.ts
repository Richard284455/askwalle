import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { createHealthCheckJob } from "@/lib/website/bulk-job";

// POST /api/admin/tools/lifecycle/job — 建一个可达性探测任务
// 全局同时只允许一个未终结的 health_check 任务（服务层强制）
export async function POST(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json().catch(() => ({}));
    const limit = typeof body?.limit === "number" ? body.limit : undefined;
    const created = await createHealthCheckJob(limit);
    if (!created.ok) {
      return NextResponse.json(AjaxResponse.fail(created.message), { status: 400 });
    }
    return NextResponse.json(AjaxResponse.ok(created));
  } catch (error) {
    console.error("Failed to create health check job:", error);
    return NextResponse.json(AjaxResponse.fail("创建探测任务失败"), { status: 500 });
  }
}
