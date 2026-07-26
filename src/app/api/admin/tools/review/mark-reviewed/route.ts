import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { bulkMarkReviewed } from "@/lib/website/tool-review";

// POST /api/admin/tools/review/mark-reviewed
// body: { websiteIds: number[], reviewNotes? } —— 前端二次确认弹窗，无确认词
// 服务端仍：先自动 apply 草稿再 mark reviewed；qc_failed / raw_imported 一律拒绝
export async function POST(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json().catch(() => ({}));
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

    // recheckQc 缺省为 false：qc_status 在回溯复检之后是准的，逐条重跑闸门只在
    // 怀疑它漂移时才需要
    const result = await bulkMarkReviewed(websiteIds, reviewNotes, {
      recheckQc: body?.recheckQc === true,
    });
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
