import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import {
  isProviderKey,
  syncProviderModels,
} from "@/lib/website/ai-provider-config";

// POST /api/admin/settings/ai-providers/[provider]/sync-models
// 从 OpenAI 兼容 /models 同步模型列表；失败时保留手动 presets
export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const providerKey = (await params).provider;
  if (!isProviderKey(providerKey)) {
    return NextResponse.json(AjaxResponse.fail("未知 provider"), {
      status: 400,
    });
  }

  try {
    const result = await syncProviderModels(providerKey);
    if (!result.ok) {
      return NextResponse.json(AjaxResponse.fail(result.message), {
        status: 400,
      });
    }
    return NextResponse.json(
      AjaxResponse.ok({ message: result.message, count: result.count })
    );
  } catch (error) {
    console.error("Failed to sync AI provider models:", error);
    return NextResponse.json(AjaxResponse.fail("同步模型失败"), {
      status: 500,
    });
  }
}
