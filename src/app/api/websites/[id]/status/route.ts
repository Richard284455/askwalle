import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { assertPublishAllowed } from "@/lib/website/tool-admin";
import { ensureMediaLocalizedBeforePublish } from "@/lib/website/tool-media-cache";
// 共享连接池（与其它 admin 路由一致，避免每路由独立 PrismaClient）
import { prisma } from "@/lib/prisma";

export async function PUT(request: Request, props: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const params = await props.params;
  try {
    const { status } = await request.json();
    const websiteId = parseInt(params.id);

    if (isNaN(websiteId)) {
      return NextResponse.json(AjaxResponse.fail("Invalid website ID"), {
        status: 400,
      });
    }

    const website = await prisma.website.findUnique({
      where: { id: websiteId },
    });

    if (!website) {
      return NextResponse.json(AjaxResponse.fail("Website not found"), {
        status: 404,
      });
    }

    // 发布守卫：含来源内容的工具必须人工审核后才能发布
    if (status === "approved" && website.status !== "approved") {
      const allowed = await assertPublishAllowed(websiteId, status);
      if (!allowed.ok) {
        return NextResponse.json(AjaxResponse.fail(allowed.message), {
          status: 400,
        });
      }
      // 媒体本地化 guard：外链缓存失败则不发布
      const media = await ensureMediaLocalizedBeforePublish(prisma, websiteId);
      if (!media.ok) {
        return NextResponse.json(AjaxResponse.fail(media.message), {
          status: 400,
        });
      }
    }

    await prisma.website.update({
      where: { id: websiteId },
      data: { status },
    });

    return NextResponse.json(AjaxResponse.ok("Status updated"));
  } catch (error) {
    console.error("Failed to update website status:", error);
    return NextResponse.json(AjaxResponse.fail("Failed to update status"), {
      status: 500,
    });
  }
}
