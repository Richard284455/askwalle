import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import {
  getAdminToolById,
  parseRewriteDraft,
  saveRewriteDraft,
} from "@/lib/website/tool-admin";

async function resolveId(params: Promise<{ id: string }>) {
  const id = parseInt((await params).id);
  return Number.isNaN(id) ? null : id;
}

// GET /api/admin/tools/[id]/rewrite
// 返回 raw 快照、当前草稿、审核状态与改写 prompt（仅内部）
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

  return NextResponse.json(AjaxResponse.ok(tool.rewrite));
}

// PUT /api/admin/tools/[id]/rewrite
// 保存管理员粘贴的 AI 改写草稿（严格 JSON 校验，禁止 HTML）
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
    const draftJson =
      typeof body?.draft === "string" ? body.draft : JSON.stringify(body?.draft);
    if (!draftJson || !draftJson.trim()) {
      return NextResponse.json(AjaxResponse.fail("draft 不能为空"), {
        status: 400,
      });
    }

    const parsed = parseRewriteDraft(draftJson);
    if (!parsed.ok) {
      return NextResponse.json(AjaxResponse.fail(parsed.message), {
        status: 400,
      });
    }

    await saveRewriteDraft(id, parsed.draft);
    const tool = await getAdminToolById(id);
    return NextResponse.json(AjaxResponse.ok(tool?.rewrite ?? null));
  } catch (error) {
    console.error("Failed to save rewrite draft:", error);
    return NextResponse.json(AjaxResponse.fail("保存草稿失败"), {
      status: 500,
    });
  }
}
