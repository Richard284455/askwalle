import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/admin-auth";
import { publishFamily } from "@/lib/content/publishing/publish";
import { prisma } from "@/lib/prisma";
import { AjaxResponse } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * 手工发布已批准的 revision。
 *
 * 这是**唯一**的发布入口 —— 定时任务里没有任何路径能走到这儿。
 * preflight 不过就整单元不发：四种语言里少一种，hreflang 立刻指向 404。
 *
 * 每一次发布都要求 revision 已有审核记录（HUMAN 或明确记录的 AGENT），
 * 由 preflight 的 NOT_APPROVED / APPROVED_NOT_CURRENT 兜底。
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const { id } = await ctx.params;
  const familyId = Number(id);
  if (!Number.isInteger(familyId)) {
    return NextResponse.json(AjaxResponse.fail("非法的 family id"), { status: 400 });
  }

  let body: { masterOnly?: boolean; dryRun?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    // 空请求体按默认参数处理
  }

  try {
    // 每个待发布译本都必须真的被审过 —— preflight 只看 approved_revision_id，
    // 那个字段理论上可被别的路径写出来，这里再要一条审核记录当作独立证据
    const translations = await prisma.articleTranslation.findMany({
      where: { family_id: familyId },
      select: { id: true, locale: true, approved_revision_id: true, _count: { select: { reviews: true } } },
    });
    const unreviewed = translations.filter((t) => t.approved_revision_id && t._count.reviews === 0);
    if (unreviewed.length) {
      return NextResponse.json(
        AjaxResponse.fail(`以下语言标记为已批准却没有审核记录，拒绝发布：${unreviewed.map((t) => t.locale).join(", ")}`),
        { status: 409 }
      );
    }

    const result = await publishFamily({
      familyId, masterOnly: Boolean(body.masterOnly), dryRun: Boolean(body.dryRun),
    });
    return NextResponse.json(AjaxResponse.ok(result));
  } catch (error) {
    console.error("Failed to publish AI HOT family:", error);
    return NextResponse.json(AjaxResponse.fail("发布失败"), { status: 500 });
  }
}
