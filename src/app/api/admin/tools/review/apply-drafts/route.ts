import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { bulkApplyDrafts } from "@/lib/website/tool-review";

// POST /api/admin/tools/review/apply-drafts
// body: { websiteIds: number[] } —— 前端二次确认弹窗，无确认词；服务端仍逐条重校验
export async function POST(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json().catch(() => ({}));
    const websiteIds = Array.isArray(body?.websiteIds)
      ? body.websiteIds.filter((id: unknown) => typeof id === "number")
      : [];

    const result = await bulkApplyDrafts(websiteIds, {
      recheckQc: body?.recheckQc === true,
    });
    if (!result.ok) {
      return NextResponse.json(AjaxResponse.fail(result.message), {
        status: 400,
      });
    }
    return NextResponse.json(AjaxResponse.ok(result.result));
  } catch (error) {
    console.error("Failed to bulk apply drafts:", error);
    return NextResponse.json(AjaxResponse.fail("批量应用草稿失败"), {
      status: 500,
    });
  }
}
