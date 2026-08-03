import { CronJob } from "cron";

import { runScheduledTask, TASK_SCHEDULE, ALL_TASKS } from "@/lib/content/aihot/scheduler";
import type { AihotTaskType } from "@prisma/client";

/**
 * AI HOT 三类内容的定时任务注册。
 *
 * **三个独立 job**，不是一个 job 里跑三件事：
 * 合成一个的话，热点接口一慢就会把日报的窗口一起占掉，
 * 而且任何一类抛异常都会顺手掐掉后面两类。
 *
 * 任务本身永不抛异常（runScheduledTask 内部兜底），这里再兜一层，
 * 是因为 cron 回调抛出去会变成未捕获的 rejection。
 */

const STARTED = Symbol.for("askwalle.aihotCronStarted");
type CronGlobal = typeof globalThis & { [STARTED]?: boolean };

/** 紧急停机开关。设成 off/0/false 即不注册 —— 这条链路会花 provider 的钱 */
export function schedulerEnabled(): boolean {
  const raw = (process.env.AIHOT_SCHEDULER ?? "").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(raw);
}

const TIMEZONE = "Asia/Shanghai";

export const aihotJobs: Record<AihotTaskType, CronJob> = Object.fromEntries(
  ALL_TASKS.map((taskType) => [
    taskType,
    new CronJob(
      TASK_SCHEDULE[taskType].cron,
      async () => {
        try {
          const r = await runScheduledTask(taskType);
          console.log(
            `[aihot-cron] ${taskType} ${r.status} ${r.durationMs}ms ` +
            `取${r.fetched} 新${r.created} 复用${r.reused} 304=${r.notModified} ` +
            `provider=${r.providerCalls} 新版本${r.revisionsCreated} ` +
            `自动审核${r.autoReviewed}(过${r.autoApproved}/拦${r.autoBlocked}/模型否决${r.llmVetoed}) ` +
            `发布${r.publicationsCreated}` +
            (r.errorCode ? ` [${r.errorCode}] ${r.message ?? ""}` : "")
          );
        } catch (e) {
          // 到这里说明兜底本身失败了（多半是数据库不可达）。
          // 只记一行，绝不让它变成未捕获 rejection 把进程带走
          console.error(`[aihot-cron] ${taskType} 任务异常:`, e instanceof Error ? e.message : e);
        }
      },
      null,
      false,
      TIMEZONE
    ),
  ])
) as Record<AihotTaskType, CronJob>;

/** 进程级幂等：重复调用只注册一次 */
export function startAihotCronJobs(): void {
  const g = globalThis as CronGlobal;
  if (g[STARTED]) return;

  if (!schedulerEnabled()) {
    console.log("[aihot-cron] AIHOT_SCHEDULER 已关闭，未注册 AI HOT 定时任务");
    return;
  }

  g[STARTED] = true;
  for (const taskType of ALL_TASKS) {
    aihotJobs[taskType].start();
    console.log(
      `[aihot-cron] 已注册 ${taskType}（${TASK_SCHEDULE[taskType].label}）` +
      ` ${TASK_SCHEDULE[taskType].cron} ${TIMEZONE}`
    );
  }
}
