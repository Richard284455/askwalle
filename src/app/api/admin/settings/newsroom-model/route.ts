import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/admin-auth";
import {
  newsroomModelOptions, resolveNewsroomModel, saveNewsroomModel,
} from "@/lib/content/multilingual/model-settings";
import { AjaxResponse } from "@/lib/utils";

export const dynamic = "force-dynamic";

// GET /api/admin/settings/newsroom-model — 当前选择 + 可选项
export async function GET() {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const [current, options] = await Promise.all([resolveNewsroomModel(), newsroomModelOptions()]);
    return NextResponse.json(AjaxResponse.ok({ current, options }));
  } catch (error) {
    console.error("Failed to load newsroom model setting:", error);
    return NextResponse.json(AjaxResponse.fail("读取模型设置失败"), { status: 500 });
  }
}

// POST /api/admin/settings/newsroom-model — 保存选择
export async function POST(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  let body: { provider?: string; model?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(AjaxResponse.fail("请求体不是合法 JSON"), { status: 400 });
  }
  if (!body.provider) return NextResponse.json(AjaxResponse.fail("必须选择 provider"), { status: 400 });

  const r = await saveNewsroomModel({ provider: body.provider, model: body.model ?? null });
  if (!r.ok) return NextResponse.json(AjaxResponse.fail(r.reason), { status: 409 });
  return NextResponse.json(AjaxResponse.ok(await resolveNewsroomModel()));
}
