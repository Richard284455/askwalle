import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/admin-auth";
import { familyDetail } from "@/lib/content/publishing/queue";
import { preflight } from "@/lib/content/publishing/publish";
import { AjaxResponse } from "@/lib/utils";

export const dynamic = "force-dynamic";

// GET /api/admin/content/aihot/family/:id — 四语言并排 + 来源事实 + 对照 + 只读预检
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const { id } = await ctx.params;
  const familyId = Number(id);
  if (!Number.isInteger(familyId)) {
    return NextResponse.json(AjaxResponse.fail("非法的 family id"), { status: 400 });
  }

  try {
    const detail = await familyDetail(familyId);
    if (!detail) return NextResponse.json(AjaxResponse.fail("family 不存在"), { status: 404 });
    // preflight 是只读的：进详情页顺手跑一次，审核者才能提前看到「为什么发不了」
    const pre = await preflight(familyId);
    return NextResponse.json(AjaxResponse.ok({ ...detail, preflight: pre }));
  } catch (error) {
    console.error("Failed to load AI HOT family detail:", error);
    return NextResponse.json(AjaxResponse.fail("获取内容详情失败"), { status: 500 });
  }
}
