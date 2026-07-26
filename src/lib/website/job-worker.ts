import {
  findNextDrivableJob,
  pauseJob,
  reclaimStalledItems,
  runNextChunk,
  TERMINAL_JOB_STATUSES,
} from "@/lib/website/bulk-job";

/**
 * 无人值守的后台任务驱动器（进程内，无外部队列/调度器）。
 *
 * 之前任务只能靠任务详情页循环调 run-next 推进，关掉页面就停。这里在 Node
 * 服务进程里跑一个自调度循环：取最早一个 queued/running 的任务，逐块调用
 * runNextChunk 直到收尾，然后处理下一个任务。
 *
 * 与任务页的循环可以共存：条目领取是原子的（updateMany where status=queued），
 * 同一条不会被跑两次；页面开着只是多一个驱动者，能更快推进。
 *
 * 安全设计：
 * - 一次只驱动一个任务，不并发打满 provider / 连接池
 * - 僵死回收：进程被杀留下的 running 条目超时后放回 queued
 * - 熔断：AI 改写连续失败（如模型名/额度错误）自动 paused，避免无人看管时
 *   把整批 token 烧光；人工在任务页点「继续执行」可恢复
 *
 * 状态全部挂在 globalThis 上：instrumentation 与 route handler 属于不同的
 * 打包产物，会各自加载一份本模块副本，模块级变量不共享 —— 那样会跑起两个
 * 循环，熔断计数也会被拆开。
 */

const NUDGE_DELAY_MS = 200; // 新任务创建后的启动延迟
const IDLE_DELAY_MS = 15_000; // 空闲轮询间隔
const BUSY_DELAY_MS = 500; // 有进展时的下一块间隔
const ERROR_DELAY_MS = 30_000; // 异常后退避
const RECLAIM_EVERY_MS = 60_000; // 僵死条目回收频率
// running 超过 5 分钟没有心跳视为中断。条目处理期间每 60s 会 touch 一次
// updated_at（见 bulk-job 的 startItemHeartbeat），所以慢条目不会被误判。
const STALE_ITEM_MS = 5 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3; // AI 改写熔断阈值

type WorkerState = {
  started: boolean;
  ticking: boolean;
  timer: NodeJS.Timeout | null;
  lastReclaimAt: number;
  // 每个任务的连续失败计数（仅进程内；重启后从 0 开始）
  consecutiveFailures: Map<number, number>;
};

const STATE_KEY = Symbol.for("askwalle.bulkJobWorkerState");
type WorkerGlobal = typeof globalThis & { [STATE_KEY]?: WorkerState };

function state(): WorkerState {
  const scope = globalThis as WorkerGlobal;
  if (!scope[STATE_KEY]) {
    scope[STATE_KEY] = {
      started: false,
      ticking: false,
      timer: null,
      lastReclaimAt: 0,
      consecutiveFailures: new Map(),
    };
  }
  return scope[STATE_KEY];
}

function log(message: string): void {
  console.log(`[bulk-job-worker] ${message}`);
}

/**
 * 熔断判定：本块只产生了「调用失败」才累计。
 *
 * QC 未通过算「有进展」而不算失败 —— 模型正常应答了，只是内容没过质量闸门。
 * 那是 prompt 的问题，停下来等人也不会变好；把它计入熔断只会让一次正常的
 * 质量波动伪装成 provider 故障，把整批任务白白暂停。
 */
type ProgressCounts = {
  successCount: number;
  skippedCount: number;
  failedCount: number;
  qcFailedCount: number;
};

function trackFailures(
  jobId: number,
  before: ProgressCounts,
  after: ProgressCounts
): number {
  const progressed =
    after.successCount - before.successCount +
    (after.skippedCount - before.skippedCount) +
    (after.qcFailedCount - before.qcFailedCount);
  const failedDelta = after.failedCount - before.failedCount;
  const counters = state().consecutiveFailures;
  const current = counters.get(jobId) ?? 0;
  const next = progressed > 0 ? 0 : current + Math.max(failedDelta, 0);
  counters.set(jobId, next);
  return next;
}

async function reclaimIfDue(): Promise<void> {
  const s = state();
  if (Date.now() - s.lastReclaimAt < RECLAIM_EVERY_MS) return;
  s.lastReclaimAt = Date.now();
  const count = await reclaimStalledItems(STALE_ITEM_MS);
  if (count > 0) log(`回收僵死条目 ${count} 条（超过 ${STALE_ITEM_MS / 60000} 分钟未更新）`);
}

async function tick(): Promise<number> {
  await reclaimIfDue();

  const job = await findNextDrivableJob();
  if (!job) return IDLE_DELAY_MS;

  const outcome = await runNextChunk(job.id);
  if (!outcome.ok) {
    log(`任务 #${job.id} 推进失败：${outcome.message}`);
    return ERROR_DELAY_MS;
  }

  const view = outcome.job;
  const terminal = TERMINAL_JOB_STATUSES.includes(view.status);

  if (job.type === "rewrite_direct") {
    const failures = trackFailures(job.id, job, view);
    if (failures >= MAX_CONSECUTIVE_FAILURES && !terminal) {
      const reason = `连续 ${failures} 条失败，已自动暂停；请检查 provider 配置后在任务页点「继续执行」`;
      await pauseJob(job.id, reason);
      state().consecutiveFailures.delete(job.id);
      log(`任务 #${job.id} 已熔断暂停（连续 ${failures} 条失败）`);
      return IDLE_DELAY_MS;
    }
  }

  if (terminal) {
    state().consecutiveFailures.delete(job.id);
    log(
      `任务 #${job.id}（${view.type}）结束：${view.status} ` +
        `成功 ${view.successCount} / 跳过 ${view.skippedCount} / 失败 ${view.failedCount}`
    );
    return BUSY_DELAY_MS;
  }

  return outcome.processedNow > 0 ? BUSY_DELAY_MS : IDLE_DELAY_MS;
}

function schedule(delayMs: number): void {
  const s = state();
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    state().timer = null;
    void loop();
  }, delayMs);
  // 不阻止进程退出
  s.timer.unref?.();
}

async function loop(): Promise<void> {
  const s = state();
  if (s.ticking) return;
  s.ticking = true;
  let delay = IDLE_DELAY_MS;
  try {
    delay = await tick();
  } catch (error) {
    log(`轮询异常：${error instanceof Error ? error.message : "unknown"}`);
    delay = ERROR_DELAY_MS;
  } finally {
    s.ticking = false;
  }
  schedule(delay);
}

// 由 instrumentation.register() 调用；重复调用无副作用
export function startJobWorker(): void {
  const s = state();
  if (s.started) return;
  if (process.env.BULK_JOB_WORKER === "off") {
    log("已通过 BULK_JOB_WORKER=off 关闭");
    return;
  }
  s.started = true;
  log("已启动：后台自动推进批量任务");
  schedule(NUDGE_DELAY_MS);
}

// 新任务创建后叫醒 worker，省掉最多一个空闲轮询周期的等待。
// 正在跑就不用管：当前这轮结束后会自然取下一个任务。
export function requestJobWorkerTick(): void {
  const s = state();
  if (!s.started || s.ticking) return;
  schedule(NUDGE_DELAY_MS);
}
