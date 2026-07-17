import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { getReviewList, getReviewPreview } from "@/lib/website/tool-review";

// GET /api/admin/tools/review
//   ?websiteId=123           → 单条预览（raw + draft + 公开当前字段）
//   其它参数                  → 列表筛选
export async function GET(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const previewId = searchParams.get("websiteId");
  if (previewId) {
    const websiteId = parseInt(previewId);
    if (Number.isNaN(websiteId)) {
      return NextResponse.json(AjaxResponse.fail("无效的 websiteId"), {
        status: 400,
      });
    }
    const preview = await getReviewPreview(websiteId);
    if (!preview) {
      return NextResponse.json(AjaxResponse.fail("工具不存在或无 ToolDetail"), {
        status: 404,
      });
    }
    return NextResponse.json(AjaxResponse.ok(preview));
  }

  const num = (key: string) => {
    const value = searchParams.get(key);
    if (!value) return undefined;
    const parsed = parseInt(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  };
  const str = (key: string) => searchParams.get(key) || undefined;

  try {
    const items = await getReviewList({
      rewriteBatchId: num("rewriteBatchId"),
      categoryId: num("categoryId"),
      provider: str("provider"),
      model: str("model"),
      websiteStatus: str("websiteStatus"),
      rewriteStatus: str("rewriteStatus"),
      qcStatus: str("qcStatus"),
      search: str("search"),
    });
    return NextResponse.json(AjaxResponse.ok(items));
  } catch (error) {
    console.error("Failed to load review list:", error);
    return NextResponse.json(AjaxResponse.fail("获取审核列表失败"), {
      status: 500,
    });
  }
}
