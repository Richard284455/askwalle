import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { bulkSetStatus } from "@/lib/website/tool-review";

// POST /api/admin/tools/review/archive
// body: { websiteIds: number[], status?: "archived" | "rejected" } —— 前端二次确认弹窗，无确认词
// 仅改状态，不物理删除
export async function POST(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json().catch(() => ({}));
    const status = body?.status === "rejected" ? "rejected" : "archived";
    const websiteIds = Array.isArray(body?.websiteIds)
      ? body.websiteIds.filter((id: unknown) => typeof id === "number")
      : [];

    const result = await bulkSetStatus(websiteIds, status);
    if (!result.ok) {
      return NextResponse.json(AjaxResponse.fail(result.message), {
        status: 400,
      });
    }
    return NextResponse.json(AjaxResponse.ok(result.result));
  } catch (error) {
    console.error("Failed to bulk archive:", error);
    return NextResponse.json(AjaxResponse.fail("批量归档失败"), {
      status: 500,
    });
  }
}
