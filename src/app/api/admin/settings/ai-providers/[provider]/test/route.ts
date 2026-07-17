import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import {
  isProviderKey,
  testProviderConnection,
} from "@/lib/website/ai-provider-config";

// POST /api/admin/settings/ai-providers/[provider]/test — 轻量连接测试
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
    const result = await testProviderConnection(providerKey);
    if (!result.ok) {
      return NextResponse.json(AjaxResponse.fail(result.message), {
        status: 400,
      });
    }
    return NextResponse.json(AjaxResponse.ok({ message: result.message }));
  } catch (error) {
    console.error("Failed to test AI provider:", error);
    return NextResponse.json(AjaxResponse.fail("测试连接失败"), {
      status: 500,
    });
  }
}
