import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { bulkPublish } from "@/lib/website/tool-review";

// POST /api/admin/tools/review/publish
// body: { websiteIds: number[] } —— 前端二次确认弹窗，无确认词
// 只发布 pending + human_reviewed（复用现有发布守卫）
export async function POST(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json().catch(() => ({}));
    const websiteIds = Array.isArray(body?.websiteIds)
      ? body.websiteIds.filter((id: unknown) => typeof id === "number")
      : [];

    const result = await bulkPublish(websiteIds);
    if (!result.ok) {
      return NextResponse.json(AjaxResponse.fail(result.message), {
        status: 400,
      });
    }
    return NextResponse.json(AjaxResponse.ok(result.result));
  } catch (error) {
    console.error("Failed to bulk publish:", error);
    return NextResponse.json(AjaxResponse.fail("批量发布失败"), {
      status: 500,
    });
  }
}
