import { NextResponse } from "next/server";

import type { AihotTaskType } from "@prisma/client";

import { ALL_TASKS, runScheduledTask } from "@/lib/content/aihot/scheduler";
import { schedulerEnabled } from "@/lib/tasks/aihot-cron";

/**
 * AI HOT 定时任务的**调用式**入口。
 *
 * 无服务器平台上没有常驻进程 —— 用 `cron` 包在 instrumentation 里注册的
 * 那套定时器活不过一次函数回收，等于不会跑。平台自己的 Cron 会按时
 * 打这个地址，由它来推进一轮。
 *
 * 租约不变，仍然是并发收敛的唯一依据：平台可能重试、也可能同一分钟
 * 打进来两次，第二个会拿不到租约并如实记成 SKIPPED_LOCKED。
 *
 * **一次只推进一小批。** 平台会在函数超时的那一刻直接把进程杀掉，
 * 所以传一个比 maxDuration 更早的收工时刻进去：到点不再开新单元，
 * 剩下的下一轮接着做（候选本来就是按「还没做完」算的）。
 */

export const dynamic = "force-dynamic";
/** 与 vercel.json 的 crons 一起决定单次能干多少活。Hobby 计划封顶 60s */
export const maxDuration = 300;

/** 单次调用最多推进几个单元。宁可少做几个，也不要被平台拦腰杀掉 */
const UNITS_PER_INVOCATION: Record<AihotTaskType, number> = {
  HOT_TOPICS: 3,
  SELECTED: 3,
  DAILY: 1,
  ITEMS_ALL: 0,
};

/**
 * 只接受平台的定时调用。
 *
 * Vercel Cron 会带 `Authorization: Bearer $CRON_SECRET`。没配 secret 就
 * **一律拒绝**，不做「没配就放行」—— 这条路由会花 provider 的钱、还会
 * 往公开页写内容，裸奔一天就够别人替我们把预算跑光。
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    // 不解释是「没配 secret」还是「secret 不对」—— 那等于告诉对方下一步怎么试
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  if (!schedulerEnabled()) {
    return NextResponse.json({ ok: true, skipped: "AIHOT_SCHEDULER 已关闭" });
  }

  const url = new URL(request.url);
  const raw = url.searchParams.get("task")?.toUpperCase();
  const task = ALL_TASKS.find((t) => t === raw);
  if (!task) {
    return NextResponse.json(
      { ok: false, message: `task 必须是 ${ALL_TASKS.join(" / ")}` },
      { status: 400 }
    );
  }

  // 留出余量：平台在 maxDuration 那一刻硬杀，收尾也需要时间
  const deadlineAt = Date.now() + (maxDuration - 20) * 1000;

  const r = await runScheduledTask(task, {
    workerId: `vercel-cron-${task.toLowerCase()}-${Date.now().toString(36)}`,
    maxUnits: UNITS_PER_INVOCATION[task],
    deadlineAt,
  });

  // 只回计数与结论，**不回内容、不回 provider payload**
  return NextResponse.json({
    ok: r.status !== "FAILED",
    task,
    status: r.status,
    durationMs: r.durationMs,
    fetched: r.fetched,
    created: r.created,
    revisionsCreated: r.revisionsCreated,
    autoReviewed: r.autoReviewed,
    autoApproved: r.autoApproved,
    autoBlocked: r.autoBlocked,
    published: r.publicationsCreated,
    errorCode: r.errorCode,
    message: r.message,
  });
}
