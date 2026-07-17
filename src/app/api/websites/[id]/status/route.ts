import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { assertPublishAllowed } from "@/lib/website/tool-admin";

const prisma = new PrismaClient();

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
