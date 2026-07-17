import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import {
  applyRewriteDraft,
  getAdminToolById,
} from "@/lib/website/tool-admin";

// POST /api/admin/tools/[id]/apply-rewrite
// 把 ai_rewrite_draft 应用到 ToolDetail(what/how/features/use_cases) 与 ToolFAQ
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
    const result = await applyRewriteDraft(id);
    if (!result.ok) {
      return NextResponse.json(AjaxResponse.fail(result.message), {
        status: 400,
      });
    }
    const tool = await getAdminToolById(id);
    return NextResponse.json(AjaxResponse.ok(tool));
  } catch (error) {
    console.error("Failed to apply rewrite draft:", error);
    return NextResponse.json(AjaxResponse.fail("应用草稿失败"), {
      status: 500,
    });
  }
}
