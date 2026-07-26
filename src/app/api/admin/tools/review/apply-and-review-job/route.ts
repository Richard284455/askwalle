import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { createBulkJob } from "@/lib/website/bulk-job";

// POST /api/admin/tools/review/apply-and-review-job
// body: { websiteIds: number[], reviewNotes? }
// 只创建 BulkJob（不同步执行）；每条执行时仍复用 bulkMarkReviewed 全部 guard
export async function POST(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json().catch(() => ({}));
    const websiteIds = Array.isArray(body?.websiteIds)
      ? body.websiteIds.filter((id: unknown) => typeof id === "number")
      : [];
    const reviewNotes =
      typeof body?.reviewNotes === "string" ? body.reviewNotes : "";
    if (reviewNotes.includes("<")) {
      return NextResponse.json(
        AjaxResponse.fail("review notes 不允许包含 HTML 标签"),
        { status: 400 }
      );
    }
    const created = await createBulkJob("apply_and_review", websiteIds, {
      reviewNotes,
      // 随任务存进 params，执行每一条时沿用同一个开关
      recheckQc: body?.recheckQc === true,
    });
    if (!created.ok) {
      return NextResponse.json(AjaxResponse.fail(created.message), { status: 400 });
    }
    // skipped：当前 QC 复检未通过、未入队的工具（历史 qc_status 可能仍是 passed）
    return NextResponse.json(
      AjaxResponse.ok({
        ...created,
        skippedCount: created.skipped.length,
      })
    );
  } catch (error) {
    console.error("Failed to create apply-and-review job:", error);
    return NextResponse.json(AjaxResponse.fail("创建审核任务失败"), { status: 500 });
  }
}
