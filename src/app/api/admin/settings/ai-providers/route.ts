import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { getProviderSettings } from "@/lib/website/ai-provider-config";

// GET /api/admin/settings/ai-providers — provider 配置列表（不含任何 key 明文/密文）
export async function GET() {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const settings = await getProviderSettings();
    return NextResponse.json(AjaxResponse.ok(settings));
  } catch (error) {
    console.error("Failed to load AI provider settings:", error);
    return NextResponse.json(AjaxResponse.fail("获取 provider 配置失败"), {
      status: 500,
    });
  }
}
