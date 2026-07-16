import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import {
  getAdminToolById,
  parseToolUpdatePayload,
  updateTool,
} from "@/lib/website/tool-admin";

async function resolveId(params: Promise<{ id: string }>) {
  const id = parseInt((await params).id);
  return Number.isNaN(id) ? null : id;
}

// GET /api/admin/tools/[id]
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const id = await resolveId(params);
  if (id === null) {
    return NextResponse.json(AjaxResponse.fail("无效的工具 ID"), {
      status: 400,
    });
  }

  const tool = await getAdminToolById(id);
  if (!tool) {
    return NextResponse.json(AjaxResponse.fail("工具不存在"), { status: 404 });
  }

  return NextResponse.json(AjaxResponse.ok(tool));
}

// PUT /api/admin/tools/[id]
// 更新 Website 基础信息 + ToolDetail + 标签/链接/媒体/FAQ
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const id = await resolveId(params);
  if (id === null) {
    return NextResponse.json(AjaxResponse.fail("无效的工具 ID"), {
      status: 400,
    });
  }

  try {
    const body = await request.json();
    const parsed = parseToolUpdatePayload(body);

    if (!parsed.ok) {
      return NextResponse.json(AjaxResponse.fail(parsed.message), {
        status: 400,
      });
    }

    await updateTool(id, parsed.data);
    const tool = await getAdminToolById(id);
    return NextResponse.json(AjaxResponse.ok(tool));
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        return NextResponse.json(
          AjaxResponse.fail("slug 已被其它工具占用，请更换 slug"),
          { status: 400 }
        );
      }
      if (error.code === "P2025") {
        return NextResponse.json(AjaxResponse.fail("工具不存在"), {
          status: 404,
        });
      }
      if (error.code === "P2003") {
        return NextResponse.json(AjaxResponse.fail("分类不存在"), {
          status: 400,
        });
      }
    }
    console.error("Failed to update tool:", error);
    return NextResponse.json(AjaxResponse.fail("更新工具失败"), {
      status: 500,
    });
  }
}
