import { randomUUID } from "crypto";

import type { AihotTaskStatus, AihotTaskType } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * 任务级租约。
 *
 * 同一类任务同一时刻只允许一个 worker 推进 —— 否则两个实例会对同一批热点
 * 各调一次 provider，钱花两份，还可能写出两条互相覆盖的 revision。
 *
 * 互斥靠**数据库条件更新**，不靠「先查再写」：那两步之间的窗口一定会被撞上。
 * 语义与 BulkJob 的租约逐字一致（locked_by + locked_until + 条件 updateMany），
 * 不另发明一套。
 */

/** 租约时长。取远大于一次正常运行的耗时，但短到 worker 崩溃后能自然过期 */
export const LEASE_TTL_MS = 5 * 60_000;
/** 心跳间隔。长任务靠它续租，避免跑到一半被别人抢走 */
export const HEARTBEAT_MS = 60_000;

export function newWorkerId(): string {
  return `${process.pid}-${randomUUID().slice(0, 8)}`;
}

/** 确保租约行存在。task_type 唯一，重复调用无副作用 */
async function ensureRow(taskType: AihotTaskType): Promise<void> {
  await prisma.aihotTaskLease.upsert({
    where: { task_type: taskType },
    create: { task_type: taskType },
    update: {},
  });
}

export type AcquireResult =
  | { ok: true; workerId: string; expiresAt: Date }
  | { ok: false; heldBy: string | null; heldUntil: Date | null };

export async function acquireLease(
  taskType: AihotTaskType, workerId: string, ttlMs = LEASE_TTL_MS
): Promise<AcquireResult> {
  await ensureRow(taskType);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  const r = await prisma.aihotTaskLease.updateMany({
    where: {
      task_type: taskType,
      // 空闲、已过期，或本来就是自己持有 —— 后者让重入安全
      OR: [{ locked_until: null }, { locked_until: { lt: now } }, { locked_by: workerId }],
    },
    data: { locked_by: workerId, locked_until: expiresAt, heartbeat_at: now },
  });
  if (r.count === 1) return { ok: true, workerId, expiresAt };

  const held = await prisma.aihotTaskLease.findUnique({
    where: { task_type: taskType }, select: { locked_by: true, locked_until: true },
  });
  return { ok: false, heldBy: held?.locked_by ?? null, heldUntil: held?.locked_until ?? null };
}

/** 续租。返回 false 表示租约已被别人接手 —— 调用方必须立刻停手 */
export async function renewLease(
  taskType: AihotTaskType, workerId: string, ttlMs = LEASE_TTL_MS
): Promise<boolean> {
  const now = new Date();
  const r = await prisma.aihotTaskLease.updateMany({
    where: { task_type: taskType, locked_by: workerId },
    data: { locked_until: new Date(now.getTime() + ttlMs), heartbeat_at: now },
  });
  return r.count === 1;
}

/**
 * 释放租约。
 *
 * 只释放自己持有的那一份 —— 无条件清空会把别人刚接手的租约也抹掉。
 */
export async function releaseLease(
  taskType: AihotTaskType, workerId: string, status?: AihotTaskStatus
): Promise<boolean> {
  const r = await prisma.aihotTaskLease.updateMany({
    where: { task_type: taskType, locked_by: workerId },
    data: {
      locked_by: null, locked_until: null, heartbeat_at: null,
      last_run_at: new Date(), last_run_status: status ?? null,
    },
  });
  return r.count === 1;
}

/** 仍被持有且未过期的租约。收尾核对用：跑完还剩租约就是泄漏 */
export async function residualLeases(now = new Date()) {
  return prisma.aihotTaskLease.findMany({
    where: { locked_by: { not: null }, locked_until: { gt: now } },
    select: { task_type: true, locked_by: true, locked_until: true },
  });
}

/** 心跳。返回停止函数；续租失败时回调被触发，调用方据此收尾 */
export function startHeartbeat(
  taskType: AihotTaskType, workerId: string,
  onLost: () => void, intervalMs = HEARTBEAT_MS, ttlMs = LEASE_TTL_MS
): () => void {
  const timer = setInterval(() => {
    void renewLease(taskType, workerId, ttlMs).then((ok) => {
      if (!ok) {
        clearInterval(timer);
        onLost();
      }
    }).catch(() => {
      // 续租查询本身失败：不当作丢租约，下一次心跳再试。
      // 一次网络抖动就自杀，比偶尔多跑一小会儿更糟
    });
  }, intervalMs);
  // 别让心跳把进程钉住不退出
  timer.unref?.();
  return () => clearInterval(timer);
}
