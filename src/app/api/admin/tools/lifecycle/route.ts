import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import {
  getErrorKindBreakdown,
  getLifecycleList,
  getLifecycleStats,
} from "@/lib/website/tool-lifecycle";

// GET /api/admin/tools/lifecycle — 只读：统计 + 分页列表
export async function GET(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const url = new URL(request.url);
    const intOf = (key: string) => {
      const raw = url.searchParams.get(key);
      const n = raw ? parseInt(raw, 10) : NaN;
      return Number.isFinite(n) ? n : undefined;
    };

    const [stats, breakdown, page] = await Promise.all([
      getLifecycleStats(),
      getErrorKindBreakdown(),
      getLifecycleList(
        {
          reach: url.searchParams.get("reach") ?? undefined,
          errorKind: url.searchParams.get("errorKind") ?? undefined,
          tier: url.searchParams.get("tier") ?? undefined,
          needsManualCheck: url.searchParams.get("needsManualCheck") === "1",
          search: url.searchParams.get("search") ?? undefined,
        },
        { page: intOf("page"), pageSize: intOf("pageSize") }
      ),
    ]);

    return NextResponse.json(AjaxResponse.ok({ stats, breakdown, ...page }));
  } catch (error) {
    console.error("Failed to load lifecycle list:", error);
    return NextResponse.json(AjaxResponse.fail("获取生命周期数据失败"), { status: 500 });
  }
}
