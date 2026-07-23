import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { getReviewStats } from "@/lib/website/tool-review";

// GET /api/admin/tools/review/stats — 各业务状态统计（现有字段计算）
export async function GET() {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const stats = await getReviewStats();
    return NextResponse.json(AjaxResponse.ok(stats));
  } catch (error) {
    console.error("Failed to load review stats:", error);
    return NextResponse.json(AjaxResponse.fail("获取统计失败"), { status: 500 });
  }
}
