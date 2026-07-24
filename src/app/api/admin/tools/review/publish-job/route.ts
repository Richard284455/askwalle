import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { createBulkJob } from "@/lib/website/bulk-job";

// POST /api/admin/tools/review/publish-job
// body: { websiteIds: number[] }
// 只创建 BulkJob；每条执行时仍复用 bulkPublish（publish guard + 媒体本地化 guard）
export async function POST(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json().catch(() => ({}));
    const websiteIds = Array.isArray(body?.websiteIds)
      ? body.websiteIds.filter((id: unknown) => typeof id === "number")
      : [];
    const created = await createBulkJob("publish", websiteIds);
    if (!created.ok) {
      return NextResponse.json(AjaxResponse.fail(created.message), { status: 400 });
    }
    return NextResponse.json(AjaxResponse.ok(created));
  } catch (error) {
    console.error("Failed to create publish job:", error);
    return NextResponse.json(AjaxResponse.fail("创建发布任务失败"), { status: 500 });
  }
}
