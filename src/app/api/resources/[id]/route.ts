import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import {
  archiveResource,
  getAdminResourceById,
  parseResourceUpdatePayload,
  updateResource,
} from "@/lib/resources/resource-admin";

async function resolveId(params: Promise<{ id: string }>) {
  const id = parseInt((await params).id);
  return Number.isNaN(id) ? null : id;
}

// GET /api/resources/[id]
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const id = await resolveId(params);
  if (id === null) {
    return NextResponse.json(AjaxResponse.fail("无效的资源 ID"), {
      status: 400,
    });
  }

  const resource = await getAdminResourceById(id);
  if (!resource) {
    return NextResponse.json(AjaxResponse.fail("资源不存在"), { status: 404 });
  }

  return NextResponse.json(AjaxResponse.ok(resource));
}

// PUT /api/resources/[id]
// 更新资源内容（支持部分字段）
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const id = await resolveId(params);
  if (id === null) {
    return NextResponse.json(AjaxResponse.fail("无效的资源 ID"), {
      status: 400,
    });
  }

  try {
    const body = await request.json();
    const parsed = parseResourceUpdatePayload(body);

    if (!parsed.ok) {
      return NextResponse.json(AjaxResponse.fail(parsed.message), {
        status: 400,
      });
    }

    const resource = await updateResource(id, parsed.data);
    return NextResponse.json(AjaxResponse.ok(resource));
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        return NextResponse.json(
          AjaxResponse.fail("该类型下 slug 已存在，请更换 slug"),
          { status: 400 }
        );
      }
      if (error.code === "P2025") {
        return NextResponse.json(AjaxResponse.fail("资源不存在"), {
          status: 404,
        });
      }
    }
    console.error("Failed to update resource:", error);
    return NextResponse.json(AjaxResponse.fail("更新资源失败"), {
      status: 500,
    });
  }
}

// DELETE /api/resources/[id]
// 归档资源（不做物理删除）
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const id = await resolveId(params);
  if (id === null) {
    return NextResponse.json(AjaxResponse.fail("无效的资源 ID"), {
      status: 400,
    });
  }

  try {
    const resource = await archiveResource(id);
    return NextResponse.json(AjaxResponse.ok(resource));
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(AjaxResponse.fail("资源不存在"), {
        status: 404,
      });
    }
    console.error("Failed to archive resource:", error);
    return NextResponse.json(AjaxResponse.fail("归档资源失败"), {
      status: 500,
    });
  }
}
