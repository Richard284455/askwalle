import { NextResponse } from "next/server";

import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { approveArticle, publishArticle, rejectArticle } from "@/lib/content/article-gen/review";

/**
 * POST /api/admin/content/articles/[id] — 审核动作
 *
 * approve / reject / publish 三个动作。**没有自动发布路径** ——
 * publish 必须发生在 approve 之后，由人显式触发。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json(AjaxResponse.fail("无效的草稿 id"), { status: 400 });
  }

  let body: { action?: string; notes?: string; category?: string; tags?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(AjaxResponse.fail("请求体不是合法 JSON"), { status: 400 });
  }

  const reviewer = "admin";
  try {
    if (body.action === "approve") {
      const r = await approveArticle(id, reviewer, body.notes);
      return r.ok ? NextResponse.json(AjaxResponse.ok(r)) : NextResponse.json(AjaxResponse.fail(r.message), { status: 400 });
    }
    if (body.action === "reject") {
      const r = await rejectArticle(id, reviewer, body.notes);
      return r.ok ? NextResponse.json(AjaxResponse.ok(r)) : NextResponse.json(AjaxResponse.fail(r.message), { status: 400 });
    }
    if (body.action === "publish") {
      const r = await publishArticle(id, reviewer, { category: body.category, tags: body.tags });
      return r.ok ? NextResponse.json(AjaxResponse.ok(r)) : NextResponse.json(AjaxResponse.fail(r.message), { status: 400 });
    }
    return NextResponse.json(AjaxResponse.fail("action 必须是 approve / reject / publish"), { status: 400 });
  } catch (error) {
    console.error("Article review action failed:", error);
    return NextResponse.json(AjaxResponse.fail("操作失败"), { status: 500 });
  }
}
