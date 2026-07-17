import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { bulkMarkReviewed } from "@/lib/website/tool-review";

// POST /api/admin/tools/review/mark-reviewed
// body: { websiteIds: number[], confirm: "REVIEWED", reviewNotes?: string }
export async function POST(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json().catch(() => ({}));
    if (body?.confirm !== "REVIEWED") {
      return NextResponse.json(
        AjaxResponse.fail("请输入确认词 REVIEWED 以确认批量标记审核"),
        { status: 400 }
      );
    }
    const reviewNotes =
      typeof body?.reviewNotes === "string" ? body.reviewNotes : "";
    if (reviewNotes.includes("<")) {
      return NextResponse.json(
        AjaxResponse.fail("review notes 不允许包含 HTML 标签"),
        { status: 400 }
      );
    }
    const websiteIds = Array.isArray(body?.websiteIds)
      ? body.websiteIds.filter((id: unknown) => typeof id === "number")
      : [];

    const result = await bulkMarkReviewed(websiteIds, reviewNotes);
    if (!result.ok) {
      return NextResponse.json(AjaxResponse.fail(result.message), {
        status: 400,
      });
    }
    return NextResponse.json(AjaxResponse.ok(result.result));
  } catch (error) {
    console.error("Failed to bulk mark reviewed:", error);
    return NextResponse.json(AjaxResponse.fail("批量标记审核失败"), {
      status: 500,
    });
  }
}
