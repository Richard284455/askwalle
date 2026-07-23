import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import {
  estimateRewriteSelection,
  parseCreateBatchBody,
} from "@/lib/website/tool-rewrite-batch";

// POST /api/admin/tools/rewrite/estimate
// 复用 create 的筛选逻辑预估处理/跳过数量；只读，绝不写数据库
export async function POST(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json().catch(() => ({}));
    const estimate = await estimateRewriteSelection(parseCreateBatchBody(body));
    return NextResponse.json(AjaxResponse.ok(estimate));
  } catch (error) {
    console.error("Failed to estimate rewrite selection:", error);
    return NextResponse.json(AjaxResponse.fail("预估失败"), { status: 500 });
  }
}
