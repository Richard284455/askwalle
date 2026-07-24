import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { retryFailedBatch } from "@/lib/website/tool-rewrite-batch";

// POST /api/admin/tools/rewrite/[batchId]/retry
// 为该批次的 failed / parse_failed / qc_failed 条目新建一个改写批次（不复用旧批次，
// 历史失败记录保留作审计）。服务端重新校验资格：仍 pending、未 human_reviewed、
// 未 reviewed、raw 存在、无已有草稿。只创建，不自动运行 AI。
export async function POST(
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

  try {
    const result = await retryFailedBatch(batchId);
    if (!result.ok) {
      return NextResponse.json(AjaxResponse.fail(result.message), {
        status: 400,
      });
    }
    return NextResponse.json(AjaxResponse.ok(result));
  } catch (error) {
    console.error("Failed to retry rewrite batch:", error);
    return NextResponse.json(AjaxResponse.fail("重试创建批次失败"), {
      status: 500,
    });
  }
}
