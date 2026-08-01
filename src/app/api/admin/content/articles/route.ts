import { NextResponse } from "next/server";
import type { ArticleStatus } from "@prisma/client";

import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { listArticlesForReview } from "@/lib/content/article-gen/review";

// GET /api/admin/content/articles — 待审核与已处理的资讯草稿
export async function GET(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const url = new URL(request.url);
    const raw = url.searchParams.get("status");
    const status = raw ? (raw.split(",").filter(Boolean) as ArticleStatus[]) : undefined;
    const items = await listArticlesForReview({ status });
    return NextResponse.json(AjaxResponse.ok(items));
  } catch (error) {
    console.error("Failed to list generated articles:", error);
    return NextResponse.json(AjaxResponse.fail("获取草稿列表失败"), { status: 500 });
  }
}
