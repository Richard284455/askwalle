import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { getRewriteBatch } from "@/lib/website/tool-rewrite-batch";

// GET /api/admin/tools/rewrite/[batchId] — 批次详情（含条目）
export async function GET(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const batchId = parseInt((await params).batchId);
  if (Number.isNaN(batchId)) {
    return NextResponse.json(AjaxResponse.fail("无效的批次 ID"), {
      status: 400,
    });
  }

  const batch = await getRewriteBatch(batchId);
  if (!batch) {
    return NextResponse.json(AjaxResponse.fail("批次不存在"), { status: 404 });
  }
  return NextResponse.json(AjaxResponse.ok(batch));
}
