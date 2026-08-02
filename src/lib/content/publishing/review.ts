import {
  Prisma,
  type DraftLanguage, type ReviewDecision, type ReviewIssueCategory, type ReviewerType,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { failedChecks, LOCALES, type ChecklistResult } from "./types";

/**
 * 人工审核。
 *
 * 批准以 family 为单位（四种语言要么一起放行，要么都不放行 ——
 * 少一种语言，hreflang 就会指向不存在的页面），但**逐语言留审核记录**：
 * 谁审的、以什么身份审的、审的哪一版、十项逐条结论、命中哪些问题分类。
 *
 * 刻意不提供「一键全批」：每种语言都要显式给出结论，
 * 否则这道人工闸门只是形式。
 */

/**
 * 审核主体。
 *
 * type 由**调用方所在的信任边界**决定，不由用户输入决定 ——
 * 后台 UI 传 HUMAN，脚本/agent 传 AGENT。
 * 让请求体自己声明 HUMAN，等于把这道闸门交给被审核的一方。
 */
export type Reviewer = {
  type: ReviewerType;
  /** 稳定标识（账号名 / agent 标识） */
  id: string;
  name?: string;
};

export type ReviewInput = {
  translationId: number;
  revisionId: number;
  reviewer: Reviewer;
  decision: ReviewDecision;
  checklist: ChecklistResult;
  issueCategories: ReviewIssueCategory[];
  notes?: string;
};

const AGENT_HINT = /(agent|claude|gpt|bot|llm|model)/i;

/**
 * AGENT 不得记成 HUMAN。
 *
 * 只能做到「标识看起来像 agent 却声明为 HUMAN 时拒绝」—— 这挡不住蓄意伪造，
 * 但能挡住真正会发生的那种情况：脚本复用了后台的调用路径，
 * 顺手把默认值带成了 HUMAN。
 */
export function reviewerIdentityIssue(reviewer: Reviewer): string | null {
  const id = reviewer.id?.trim();
  if (!id) return "必须记录审核人标识（reviewer.id）";
  if (reviewer.type === "HUMAN" && AGENT_HINT.test(`${id} ${reviewer.name ?? ""}`)) {
    return `标识「${id}」看起来是自动化主体，不能记为 HUMAN 审核`;
  }
  if (reviewer.type === "SYSTEM") {
    return "SYSTEM 只用于迁移回填等系统痕迹，不具备批准效力，不能用于审核";
  }
  return null;
}

export type ReviewResult =
  | { ok: true; reviewId: number; translationId: number; locale: DraftLanguage; decision: ReviewDecision }
  | { ok: false; reason: string };

export async function recordReview(input: ReviewInput): Promise<ReviewResult> {
  const translation = await prisma.articleTranslation.findUnique({
    where: { id: input.translationId },
    select: { id: true, locale: true, family_id: true },
  });
  if (!translation) return { ok: false, reason: `译本 #${input.translationId} 不存在` };

  const revision = await prisma.articleRevision.findUnique({
    where: { id: input.revisionId },
    select: { id: true, translation_id: true, revision_number: true },
  });
  if (!revision) return { ok: false, reason: `revision #${input.revisionId} 不存在` };
  if (revision.translation_id !== translation.id) {
    return { ok: false, reason: "revision 不属于该译本 —— 审核结论不能记到别人的稿子上" };
  }

  const identityIssue = reviewerIdentityIssue(input.reviewer);
  if (identityIssue) return { ok: false, reason: identityIssue };

  // 十项没全过却给 APPROVED，是自相矛盾的记录，直接拒绝
  const failed = failedChecks(input.checklist);
  if (input.decision === "APPROVED" && failed.length) {
    return { ok: false, reason: `以下检查项未通过，不能标记为 APPROVED：${failed.join("；")}` };
  }
  if (input.decision === "APPROVED" && input.issueCategories.some((c) => c !== "NO_ISSUE" && c !== "STYLE_ONLY")) {
    return { ok: false, reason: "存在实质问题分类时不能标记为 APPROVED" };
  }

  const review = await prisma.translationReview.create({
    data: {
      translation_id: translation.id,
      revision_id: revision.id,
      reviewer: input.reviewer.id.trim(),
      reviewer_type: input.reviewer.type,
      reviewer_id: input.reviewer.id.trim(),
      reviewer_name: input.reviewer.name?.trim() || null,
      decision: input.decision,
      // 批准时记住批准的是哪一版；译本上的字段会被后续审核覆盖，这里不会
      approved_revision_id: input.decision === "APPROVED" ? revision.id : null,
      notes: input.notes?.slice(0, 2000) ?? null,
      checklist_json: input.checklist as unknown as Prisma.InputJsonValue,
      issue_categories_json: input.issueCategories as unknown as Prisma.InputJsonValue,
    },
  });

  await prisma.articleTranslation.update({
    where: { id: translation.id },
    data: {
      status: input.decision === "APPROVED" ? "APPROVED"
        : input.decision === "REJECTED" ? "REJECTED" : "IN_REVIEW",
      // 只有批准才写 approved_revision_id；退回时清掉，避免旧批准继续生效
      approved_revision_id: input.decision === "APPROVED" ? revision.id : null,
    },
  });

  return { ok: true, reviewId: review.id, translationId: translation.id, locale: translation.locale, decision: input.decision };
}

export type FamilyReviewState = {
  familyId: number;
  unitKey: string;
  allApproved: boolean;
  locales: {
    locale: DraftLanguage;
    translationId: number;
    status: string;
    currentRevisionId: number | null;
    approvedRevisionId: number | null;
    /** 批准的是不是当前这一版。不是就说明批准之后又出了新稿 */
    approvedIsCurrent: boolean;
    lastReviewer: string | null;
    lastReviewerType: ReviewerType | null;
    lastReviewDecision: ReviewDecision | null;
    lastReviewNotes: string | null;
    lastReviewedAt: Date | null;
    reviewCount: number;
    issueCategories: ReviewIssueCategory[];
  }[];
};

export async function familyReviewState(familyId: number): Promise<FamilyReviewState | null> {
  const family = await prisma.articleFamily.findUnique({
    where: { id: familyId },
    include: {
      translations: {
        include: { reviews: { orderBy: { reviewed_at: "desc" } } },
      },
    },
  });
  if (!family) return null;

  const locales = LOCALES.map((locale) => {
    const t = family.translations.find((x) => x.locale === locale);
    if (!t) {
      return {
        locale, translationId: 0, status: "MISSING", currentRevisionId: null,
        approvedRevisionId: null, approvedIsCurrent: false,
        lastReviewer: null, lastReviewerType: null, lastReviewDecision: null,
        lastReviewNotes: null, lastReviewedAt: null, reviewCount: 0,
        issueCategories: [] as ReviewIssueCategory[],
      };
    }
    const last = t.reviews[0];
    return {
      locale, translationId: t.id, status: t.status,
      currentRevisionId: t.current_revision_id,
      approvedRevisionId: t.approved_revision_id,
      approvedIsCurrent: Boolean(t.approved_revision_id && t.approved_revision_id === t.current_revision_id),
      lastReviewer: last?.reviewer_name ?? last?.reviewer_id ?? last?.reviewer ?? null,
      lastReviewerType: last?.reviewer_type ?? null,
      lastReviewDecision: last?.decision ?? null,
      lastReviewNotes: last?.notes ?? null,
      lastReviewedAt: last?.reviewed_at ?? null,
      reviewCount: t.reviews.length,
      issueCategories: (Array.isArray(last?.issue_categories_json)
        ? (last!.issue_categories_json as ReviewIssueCategory[]) : []),
    };
  });

  return {
    familyId: family.id, unitKey: family.unit_key,
    allApproved: locales.every((l) => l.status === "APPROVED" && l.approvedIsCurrent),
    locales,
  };
}

/** 审核问题分类的统计，供 pilot 报告使用 */
export async function issueTally(): Promise<Record<string, number>> {
  const reviews = await prisma.translationReview.findMany({ select: { issue_categories_json: true } });
  const tally: Record<string, number> = {};
  for (const r of reviews) {
    const cats = Array.isArray(r.issue_categories_json) ? (r.issue_categories_json as string[]) : [];
    for (const c of cats) tally[c] = (tally[c] ?? 0) + 1;
  }
  return tally;
}
