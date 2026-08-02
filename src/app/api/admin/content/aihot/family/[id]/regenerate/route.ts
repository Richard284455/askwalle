import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/admin-auth";
import { generateUnit } from "@/lib/content/multilingual/generate";
import { freezeUnit } from "@/lib/content/publishing/freeze";
import { prisma } from "@/lib/prisma";
import { AjaxResponse } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * 重新生成并冻结出**新的** revision。
 *
 * 不覆盖旧 revision，也不改已发布的那一版 —— freezeUnit 会 +1 出新版本，
 * 并清掉 approved_revision_id：上一版的批准不能替这一版背书。
 *
 * 会花 provider 调用，所以要显式点，不做「打开页面就重跑」。
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const { id } = await ctx.params;
  const familyId = Number(id);
  if (!Number.isInteger(familyId)) {
    return NextResponse.json(AjaxResponse.fail("非法的 family id"), { status: 400 });
  }

  const family = await prisma.articleFamily.findUnique({
    where: { id: familyId },
    select: {
      unit_key: true, content_kind: true,
      selected_item_id: true, hot_topic_snapshot_id: true, daily_report_id: true,
    },
  });
  if (!family) return NextResponse.json(AjaxResponse.fail("family 不存在"), { status: 404 });

  const sourceId = family.selected_item_id ?? family.hot_topic_snapshot_id ?? family.daily_report_id;
  if (!sourceId) {
    return NextResponse.json(AjaxResponse.fail("该 family 未关联 AI HOT 来源记录，无法重新生成"), { status: 409 });
  }

  try {
    const kind = family.content_kind === "SELECTED" ? "SELECTED"
      : family.content_kind === "HOT_TOPIC" ? "HOT_TOPIC" : "DAILY";
    // force：审核者点重生成就是要一份新的，不该被幂等挡回去
    const generated = await generateUnit({ kind, id: sourceId, force: true });
    const frozen = generated.status === "OK" || generated.status === "EXISTING"
      ? await freezeUnit(family.unit_key)
      : null;
    return NextResponse.json(AjaxResponse.ok({ generated, frozen }));
  } catch (error) {
    console.error("Failed to regenerate AI HOT family:", error);
    return NextResponse.json(AjaxResponse.fail("重新生成失败"), { status: 500 });
  }
}
