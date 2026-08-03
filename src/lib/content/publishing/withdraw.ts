import type { DraftLanguage, ReviewIssueCategory } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { recordReview, reviewerIdentityIssue, type Reviewer } from "./review";
import { LOCALES, REVIEW_CHECKLIST, type ChecklistResult } from "./types";

/**
 * 取消上线。
 *
 * 内容策略改成「AI 自动审核并发布，人工事后复核」之后，这里是**人**在这条
 * 链路上唯一的实权：模型放行的东西，人可以把它撤回来。
 *
 * 三条设计决定：
 *
 * 1. **以 family 为单位，不能只撤一种语言。** 四种语言互为 hreflang，
 *    撤掉其中一种，剩下三种的语言互链就指向 404，等于用一个问题换三个问题。
 *
 * 2. **撤下 ≠ 删除。** 发布记录留着，只是状态变成 WITHDRAWN 并记下时间、
 *    执行人、理由。这页曾经对外存在过，删掉记录不会让那件事没发生过，
 *    只会让事后没人查得到。
 *
 * 3. **撤下之后不能被自动链路重新发出去。** 顺手把译本的 approved_revision_id
 *    清掉、状态打成 REJECTED —— preflight 的 NOT_APPROVED 会自然挡住重发。
 *    只有产生新版本（重新生成）或有人重新批准，它才可能再上线。
 */

export type WithdrawOutcome = {
  locale: DraftLanguage;
  publicationId: number;
  path: string;
  publishedAt: Date;
};

export type WithdrawResult =
  | {
      ok: true;
      familyId: number;
      unitKey: string;
      withdrawn: WithdrawOutcome[];
      /** 逐语言的复核记录 id。写失败的语言在 reviewErrors 里 */
      reviewIds: number[];
      reviewErrors: string[];
      dryRun: boolean;
    }
  | { ok: false; reason: string };

export type WithdrawInput = {
  familyId: number;
  /** 撤下理由。**必填** —— 没有理由的撤下，事后等于没有记录 */
  reason: string;
  reviewer: Reviewer;
  issueCategories?: ReviewIssueCategory[];
  dryRun?: boolean;
};

/** 撤下时的清单：一项都不算通过 —— 这条记录表达的就是「没过」 */
const ALL_CHECKS_FAIL: ChecklistResult = Object.fromEntries(
  REVIEW_CHECKLIST.map((c) => [c.key, false])
) as ChecklistResult;

export async function withdrawFamily(input: WithdrawInput): Promise<WithdrawResult> {
  const reason = input.reason?.trim();
  if (!reason) return { ok: false, reason: "必须填写撤下理由" };

  const identityIssue = reviewerIdentityIssue(input.reviewer);
  if (identityIssue) return { ok: false, reason: identityIssue };

  const family = await prisma.articleFamily.findUnique({
    where: { id: input.familyId },
    include: {
      translations: {
        include: {
          publications: { where: { status: "PUBLISHED" }, orderBy: { published_at: "desc" } },
        },
      },
    },
  });
  if (!family) return { ok: false, reason: `family #${input.familyId} 不存在` };

  const live = family.translations.flatMap((t) =>
    t.publications.map((p) => ({
      translationId: t.id, locale: t.locale, publicationId: p.id,
      path: p.path, publishedAt: p.published_at,
    }))
  );
  if (!live.length) {
    return { ok: false, reason: "该内容当前没有公开中的页面，无需撤下" };
  }

  const withdrawn: WithdrawOutcome[] = live.map((p) => ({
    locale: p.locale, publicationId: p.publicationId, path: p.path, publishedAt: p.publishedAt,
  }));

  if (input.dryRun) {
    return { ok: true, familyId: family.id, unitKey: family.unit_key, withdrawn,
      reviewIds: [], reviewErrors: [], dryRun: true };
  }

  const by = `${input.reviewer.type}:${input.reviewer.id.trim()}`;

  /*
   * 先下线，后补记录。
   *
   * 顺序不是随手定的：这两步之间如果崩了，
   *   「页面已下线、复核记录还没写」→ 重跑一次补上就好；
   *   「记录写了、页面还挂在外面」→ 台账说已撤下，实际还能访问。
   * 后者更糟，所以下线走在前面。
   */
  await prisma.$transaction(async (tx) => {
    await tx.articlePublication.updateMany({
      where: { id: { in: live.map((p) => p.publicationId) } },
      data: {
        status: "WITHDRAWN", unpublished_at: new Date(),
        withdrawn_by: by, withdrawn_reason: reason.slice(0, 1000),
      },
    });
    await tx.articleTranslation.updateMany({
      where: { family_id: family.id },
      // 清掉批准指针：不清的话，自动链路下一轮 preflight 会认为它仍然可发
      data: { status: "REJECTED", approved_revision_id: null, published_revision_id: null },
    });
    await tx.articleFamily.update({ where: { id: family.id }, data: { status: "REJECTED" } });
  });

  // ── 逐语言留下人工复核记录 ──
  const reviewIds: number[] = [];
  const reviewErrors: string[] = [];
  const categories = input.issueCategories?.length ? input.issueCategories : (["TRUE_FACT_DRIFT"] as ReviewIssueCategory[]);

  for (const locale of LOCALES) {
    const t = family.translations.find((x) => x.locale === locale);
    if (!t?.current_revision_id) continue;
    const r = await recordReview({
      translationId: t.id,
      revisionId: t.current_revision_id,
      reviewer: input.reviewer,
      decision: "REJECTED",
      checklist: ALL_CHECKS_FAIL,
      issueCategories: categories,
      notes: `人工复核撤下：${reason}`,
    });
    if (r.ok) reviewIds.push(r.reviewId);
    else reviewErrors.push(`${locale}：${r.reason}`);
  }

  return { ok: true, familyId: family.id, unitKey: family.unit_key, withdrawn, reviewIds, reviewErrors, dryRun: false };
}

/** 已撤下的记录，供后台查看「什么被撤过、谁撤的、为什么」 */
export async function listWithdrawn(limit = 100) {
  return prisma.articlePublication.findMany({
    where: { status: "WITHDRAWN" },
    orderBy: { unpublished_at: "desc" },
    take: limit,
    select: {
      id: true, locale: true, path: true, published_at: true, unpublished_at: true,
      withdrawn_by: true, withdrawn_reason: true,
      translation: { select: { family_id: true, family: { select: { unit_key: true, slug: true } } } },
    },
  });
}
