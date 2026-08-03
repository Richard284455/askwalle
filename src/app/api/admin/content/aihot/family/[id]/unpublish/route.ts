import { NextResponse } from "next/server";

import type { ReviewIssueCategory } from "@prisma/client";

import { requireAdmin } from "@/lib/auth/admin-auth";
import { withdrawFamily } from "@/lib/content/publishing/withdraw";
import { AjaxResponse } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * 人工复核不通过 → 取消上线。
 *
 * **审核主体类型由服务端决定，不读请求体。** 这条路由只挂在管理员会话后面，
 * 所以恒为 HUMAN。这一点在自动审核上线之后比以前更要紧：
 * 页面基本都是模型放行的，「有人看过并且撤了」是审计里唯一的人类痕迹，
 * 让请求体自己声明身份，这个痕迹就不可信了。
 *
 * 公开页全部是 force-dynamic，撤下即时生效，没有需要额外失效的缓存。
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const { id } = await ctx.params;
  const familyId = Number(id);
  if (!Number.isInteger(familyId)) {
    return NextResponse.json(AjaxResponse.fail("非法的 family id"), { status: 400 });
  }

  let body: {
    reason?: string; reviewerName?: string;
    issueCategories?: string[]; dryRun?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(AjaxResponse.fail("请求体不是合法 JSON"), { status: 400 });
  }

  const reviewerName = body.reviewerName?.trim();
  if (!reviewerName) {
    return NextResponse.json(AjaxResponse.fail("必须填写复核人姓名"), { status: 400 });
  }
  const reason = body.reason?.trim();
  if (!reason) {
    return NextResponse.json(AjaxResponse.fail("必须填写撤下理由"), { status: 400 });
  }

  const result = await withdrawFamily({
    familyId,
    reason,
    reviewer: {
      type: "HUMAN",
      id: `admin:${reviewerName.toLowerCase().replace(/\s+/g, "-").slice(0, 40)}`,
      name: reviewerName,
    },
    issueCategories: (Array.isArray(body.issueCategories) ? body.issueCategories : []) as ReviewIssueCategory[],
    dryRun: Boolean(body.dryRun),
  });

  if (!result.ok) return NextResponse.json(AjaxResponse.fail(result.reason), { status: 409 });
  return NextResponse.json(AjaxResponse.ok(result));
}
