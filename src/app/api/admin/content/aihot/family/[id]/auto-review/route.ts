import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/admin-auth";
import { autoReviewFamily } from "@/lib/content/publishing/auto-review";
import { publishFamily } from "@/lib/content/publishing/publish";
import { AjaxResponse } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * 手工触发一次自动审核（可选择顺带发布）。
 *
 * 定时链路本来就会自己走这一步；这个入口是给后台用的：
 * 补跑积压的、重新生成之后立刻看结论、或者只想看看闸门会不会拦。
 *
 * `dryRun` 只算不写 —— 不留审核记录、不改译本状态，用来预览结论。
 * `publish` 默认 true：审核通过就发。传 false 只审不发。
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const { id } = await ctx.params;
  const familyId = Number(id);
  if (!Number.isInteger(familyId)) {
    return NextResponse.json(AjaxResponse.fail("非法的 family id"), { status: 400 });
  }

  let body: { dryRun?: boolean; publish?: boolean; llm?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    // 空请求体按默认参数处理
  }

  try {
    const review = await autoReviewFamily(familyId, {
      dryRun: Boolean(body.dryRun),
      llm: body.llm !== false,
    });

    // dry-run 没有留下批准记录，接着发只会被 preflight 以 NOT_APPROVED 拦下 ——
    // 与其让调用方收到一条看不懂的失败，不如在这里就说清楚
    const shouldPublish = body.publish !== false && !body.dryRun && review.status === "APPROVED";
    const publication = shouldPublish ? await publishFamily({ familyId }) : null;

    return NextResponse.json(AjaxResponse.ok({ review, publication }));
  } catch (error) {
    console.error("Failed to auto-review AI HOT family:", error);
    return NextResponse.json(AjaxResponse.fail("自动审核失败"), { status: 500 });
  }
}
