import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import {
  getProviderSetting,
  isProviderKey,
  saveProviderConfig,
} from "@/lib/website/ai-provider-config";

// PUT /api/admin/settings/ai-providers/[provider]
// 保存 provider 配置；API key 只加密入库，响应绝不包含 key
export async function PUT(
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
    const body = await request.json().catch(() => ({}));
    const modelPresets = Array.isArray(body?.modelPresets)
      ? body.modelPresets.filter((v: unknown) => typeof v === "string")
      : typeof body?.modelPresets === "string"
      ? body.modelPresets.split(/[,，\n]/)
      : undefined;

    const result = await saveProviderConfig(providerKey, {
      enabled: typeof body?.enabled === "boolean" ? body.enabled : undefined,
      apiKey: typeof body?.apiKey === "string" ? body.apiKey : undefined,
      clearApiKey: body?.clearApiKey === true,
      baseUrl: typeof body?.baseUrl === "string" ? body.baseUrl : undefined,
      defaultModel:
        typeof body?.defaultModel === "string" ? body.defaultModel : undefined,
      modelPresets,
      notes: typeof body?.notes === "string" ? body.notes : undefined,
      displayName:
        typeof body?.displayName === "string" ? body.displayName : undefined,
    });

    if (!result.ok) {
      return NextResponse.json(AjaxResponse.fail(result.message), {
        status: 400,
      });
    }
    const setting = await getProviderSetting(providerKey);
    return NextResponse.json(AjaxResponse.ok(setting));
  } catch (error) {
    console.error("Failed to save AI provider config:", error);
    return NextResponse.json(AjaxResponse.fail("保存 provider 配置失败"), {
      status: 500,
    });
  }
}
