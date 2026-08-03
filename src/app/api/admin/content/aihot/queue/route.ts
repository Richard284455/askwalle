import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/admin-auth";
import { loadQueue, QUEUE_TABS, type QueueTab } from "@/lib/content/publishing/queue";
import { AjaxResponse } from "@/lib/utils";

export const dynamic = "force-dynamic";

// GET /api/admin/content/aihot/queue?tab=AWAITING_HUMAN — 编辑审核队列
export async function GET(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const url = new URL(request.url);
    const raw = url.searchParams.get("tab") ?? "AWAITING_HUMAN";
    const tab = (QUEUE_TABS as readonly string[]).includes(raw) ? (raw as QueueTab) : "AWAITING_HUMAN";
    // 一次读取同时得出行与计数：并发两路深层查询会打满共享连接池
    return NextResponse.json(AjaxResponse.ok(await loadQueue({ tab })));
  } catch (error) {
    console.error("Failed to list AI HOT review queue:", error);
    return NextResponse.json(AjaxResponse.fail("获取审核队列失败"), { status: 500 });
  }
}
