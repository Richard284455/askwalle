import { NextResponse } from "next/server";
import { updateWebsiteThumbnails } from "@/lib/utils/update-thumbnails";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";

export async function POST() {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    console.log("手动触发缩略图更新任务");
    await updateWebsiteThumbnails();
    return NextResponse.json(AjaxResponse.ok("缩略图更新完成"));
  } catch (error) {
    console.error("手动更新缩略图失败:", error);
    return NextResponse.json(AjaxResponse.fail("更新失败，请查看服务器日志"), {
      status: 500,
    });
  }
}
