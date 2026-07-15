import { NextResponse } from "next/server";
import { Prisma, ResourceStatus, ResourceType } from "@prisma/client";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import {
  createResource,
  getAdminResources,
  parseResourceCreatePayload,
} from "@/lib/resources/resource-admin";

function isEnumValue<T extends Record<string, string>>(
  enumObject: T,
  value: string | null
): value is T[keyof T] {
  return value !== null && Object.values(enumObject).includes(value);
}

// GET /api/resources?type=&status=
// 管理端资源列表（含草稿/归档）
export async function GET(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const typeParam = searchParams.get("type");
  const statusParam = searchParams.get("status");

  const resources = await getAdminResources({
    type: isEnumValue(ResourceType, typeParam) ? typeParam : undefined,
    status: isEnumValue(ResourceStatus, statusParam) ? statusParam : undefined,
  });

  return NextResponse.json(AjaxResponse.ok(resources));
}

// POST /api/resources
// 创建资源内容
export async function POST(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json();
    const parsed = parseResourceCreatePayload(body);

    if (!parsed.ok) {
      return NextResponse.json(AjaxResponse.fail(parsed.message), {
        status: 400,
      });
    }

    const resource = await createResource(parsed.data);
    return NextResponse.json(AjaxResponse.ok(resource));
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        AjaxResponse.fail("该类型下 slug 已存在，请更换 slug"),
        { status: 400 }
      );
    }
    console.error("Failed to create resource:", error);
    return NextResponse.json(AjaxResponse.fail("创建资源失败"), {
      status: 500,
    });
  }
}
