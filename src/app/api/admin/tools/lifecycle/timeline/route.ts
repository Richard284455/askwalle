import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { getLifecycleTimeline } from "@/lib/website/tool-lifecycle";

// GET /api/admin/tools/lifecycle/timeline?websiteId= — 只读：探测事件时间线 + 证据
export async function GET(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const url = new URL(request.url);
    const websiteId = parseInt(url.searchParams.get("websiteId") ?? "", 10);
    if (!Number.isFinite(websiteId)) {
      return NextResponse.json(AjaxResponse.fail("缺少 websiteId"), { status: 400 });
    }
    const events = await getLifecycleTimeline(websiteId);
    return NextResponse.json(AjaxResponse.ok(events));
  } catch (error) {
    console.error("Failed to load lifecycle timeline:", error);
    return NextResponse.json(AjaxResponse.fail("获取事件时间线失败"), { status: 500 });
  }
}
