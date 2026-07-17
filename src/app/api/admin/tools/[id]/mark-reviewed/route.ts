import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import {
  getAdminToolById,
  markToolReviewed,
} from "@/lib/website/tool-admin";

// POST /api/admin/tools/[id]/mark-reviewed
// 标记人工审核完成（human_reviewed + reviewed_at + review_notes）
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const id = parseInt((await params).id);
  if (Number.isNaN(id)) {
    return NextResponse.json(AjaxResponse.fail("无效的工具 ID"), {
      status: 400,
    });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const reviewNotes =
      typeof body?.reviewNotes === "string" ? body.reviewNotes : "";
    if (reviewNotes.includes("<")) {
      return NextResponse.json(
        AjaxResponse.fail("review_notes 不允许包含 HTML 标签"),
        { status: 400 }
      );
    }

    const result = await markToolReviewed(id, reviewNotes);
    if (!result.ok) {
      return NextResponse.json(AjaxResponse.fail(result.message), {
        status: 400,
      });
    }
    const tool = await getAdminToolById(id);
    return NextResponse.json(AjaxResponse.ok(tool?.rewrite ?? null));
  } catch (error) {
    console.error("Failed to mark tool reviewed:", error);
    return NextResponse.json(AjaxResponse.fail("标记审核失败"), {
      status: 500,
    });
  }
}
