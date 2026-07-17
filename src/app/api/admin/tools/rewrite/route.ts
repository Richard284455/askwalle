import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import {
  createRewriteBatch,
  isRewriteProvider,
  listRewriteBatches,
} from "@/lib/website/tool-rewrite-batch";

// GET /api/admin/tools/rewrite — 历史批次列表
export async function GET() {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const batches = await listRewriteBatches();
    return NextResponse.json(AjaxResponse.ok(batches));
  } catch (error) {
    console.error("Failed to list rewrite batches:", error);
    return NextResponse.json(AjaxResponse.fail("获取批次列表失败"), {
      status: 500,
    });
  }
}

// POST /api/admin/tools/rewrite — 创建批量改写任务
export async function POST(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json().catch(() => ({}));
    const categoryId =
      typeof body?.categoryId === "number" && body.categoryId > 0
        ? body.categoryId
        : undefined;
    const limit =
      typeof body?.limit === "number" && body.limit > 0
        ? Math.floor(body.limit)
        : undefined;
    const rewriteStatuses = Array.isArray(body?.rewriteStatuses)
      ? body.rewriteStatuses.filter((s: unknown) =>
          ["raw_imported", "draft_generated"].includes(String(s))
        )
      : undefined;
    const name = typeof body?.name === "string" ? body.name : undefined;
    const provider =
      typeof body?.provider === "string" && isRewriteProvider(body.provider)
        ? body.provider
        : undefined;
    const model =
      typeof body?.model === "string" && body.model.trim()
        ? body.model.trim()
        : undefined;

    const result = await createRewriteBatch({
      name,
      categoryId,
      limit,
      rewriteStatuses,
      provider,
      model,
    });
    if (!result.ok) {
      return NextResponse.json(AjaxResponse.fail(result.message), {
        status: 400,
      });
    }
    return NextResponse.json(
      AjaxResponse.ok({ batchId: result.batchId, total: result.total })
    );
  } catch (error) {
    console.error("Failed to create rewrite batch:", error);
    return NextResponse.json(AjaxResponse.fail("创建批次失败"), {
      status: 500,
    });
  }
}
