import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/admin-auth";
import { listQueue, queueCounts, QUEUE_TABS, type QueueTab } from "@/lib/content/publishing/queue";
import { AjaxResponse } from "@/lib/utils";

export const dynamic = "force-dynamic";

// GET /api/admin/content/aihot/queue?tab=NEEDS_REVIEW — 编辑审核队列
export async function GET(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const url = new URL(request.url);
    const raw = url.searchParams.get("tab") ?? "NEEDS_REVIEW";
    const tab = (QUEUE_TABS as readonly string[]).includes(raw) ? (raw as QueueTab) : "NEEDS_REVIEW";
    const [rows, counts] = await Promise.all([listQueue({ tab }), queueCounts()]);
    return NextResponse.json(AjaxResponse.ok({ tab, rows, counts }));
  } catch (error) {
    console.error("Failed to list AI HOT review queue:", error);
    return NextResponse.json(AjaxResponse.fail("获取审核队列失败"), { status: 500 });
  }
}
