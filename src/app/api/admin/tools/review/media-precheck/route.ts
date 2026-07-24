import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { prisma } from "@/lib/prisma";
import { precheckMediaForWebsites } from "@/lib/website/tool-media-cache";

// POST /api/admin/tools/review/media-precheck
// body: { websiteIds: number[] } — Publish 确认弹窗的媒体预检（只读，不下载不写库）
export async function POST(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json().catch(() => ({}));
    const websiteIds = Array.isArray(body?.websiteIds)
      ? body.websiteIds.filter((id: unknown) => typeof id === "number")
      : [];
    if (!websiteIds.length) {
      return NextResponse.json(AjaxResponse.fail("未选择任何工具"), { status: 400 });
    }
    const precheck = await precheckMediaForWebsites(prisma, websiteIds);
    return NextResponse.json(AjaxResponse.ok(precheck));
  } catch (error) {
    console.error("Failed to precheck media:", error);
    return NextResponse.json(AjaxResponse.fail("媒体预检失败"), { status: 500 });
  }
}
