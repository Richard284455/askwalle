import { NextResponse } from "next/server";

import type { DraftLanguage, ReviewDecision, ReviewIssueCategory } from "@prisma/client";

import { requireAdmin } from "@/lib/auth/admin-auth";
import { recordReview } from "@/lib/content/publishing/review";
import { ALL_CHECKS_PASS, LOCALES, REVIEW_CHECKLIST, type ChecklistResult } from "@/lib/content/publishing/types";
import { prisma } from "@/lib/prisma";
import { AjaxResponse } from "@/lib/utils";

export const dynamic = "force-dynamic";

const DECISIONS: ReviewDecision[] = ["APPROVED", "REJECTED", "NEEDS_REVISION"];

/**
 * 逐语言审核。
 *
 * **审核主体类型由服务端决定，不读请求体。** 这条路由只挂在管理员会话后面，
 * 所以类型恒为 HUMAN；让请求体自己声明身份，等于把这道闸门交给调用方。
 * 脚本/agent 要留审核记录，走 recordReview 并显式传 AGENT，不走这里。
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
    locale?: string; decision?: string; reviewerName?: string;
    checklist?: Record<string, boolean>; issueCategories?: string[]; notes?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(AjaxResponse.fail("请求体不是合法 JSON"), { status: 400 });
  }

  const locale = body.locale as DraftLanguage | undefined;
  if (!locale || !LOCALES.includes(locale)) {
    return NextResponse.json(AjaxResponse.fail(`locale 必须是 ${LOCALES.join(" / ")}`), { status: 400 });
  }
  const decision = body.decision as ReviewDecision | undefined;
  if (!decision || !DECISIONS.includes(decision)) {
    return NextResponse.json(AjaxResponse.fail(`decision 必须是 ${DECISIONS.join(" / ")}`), { status: 400 });
  }
  const reviewerName = body.reviewerName?.trim();
  if (!reviewerName) {
    return NextResponse.json(AjaxResponse.fail("必须填写审核人姓名"), { status: 400 });
  }

  const translation = await prisma.articleTranslation.findFirst({
    where: { family_id: familyId, locale },
    select: { id: true, current_revision_id: true },
  });
  if (!translation) return NextResponse.json(AjaxResponse.fail("该语言版本不存在"), { status: 404 });
  if (!translation.current_revision_id) {
    return NextResponse.json(AjaxResponse.fail("该语言尚无可审核的 revision"), { status: 409 });
  }

  // 未逐项勾选时按「全未通过」处理，绝不默认全过 ——
  // 默认全过会让一次误点击变成一份「十项全通过」的记录
  const checklist: ChecklistResult = decision === "APPROVED" && !body.checklist
    ? ALL_CHECKS_PASS
    : (Object.fromEntries(
        REVIEW_CHECKLIST.map((c) => [c.key, Boolean(body.checklist?.[c.key])])
      ) as ChecklistResult);

  const issueCategories = (Array.isArray(body.issueCategories) ? body.issueCategories : []) as ReviewIssueCategory[];

  const result = await recordReview({
    translationId: translation.id,
    revisionId: translation.current_revision_id,
    reviewer: {
      type: "HUMAN",
      id: `admin:${reviewerName.toLowerCase().replace(/\s+/g, "-").slice(0, 40)}`,
      name: reviewerName,
    },
    decision,
    checklist,
    issueCategories,
    notes: body.notes,
  });

  if (!result.ok) return NextResponse.json(AjaxResponse.fail(result.reason), { status: 409 });
  return NextResponse.json(AjaxResponse.ok(result));
}
