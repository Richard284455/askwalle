import { Prisma, type BulkJob } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  bulkMarkReviewed,
  bulkPublish,
  currentQcVerdicts,
  BULK_LIMIT_MAX,
} from "@/lib/website/tool-review";
import {
  buildImportPlan,
  importSingleRecord,
  type ImportFileInput,
} from "@/lib/website/tool-import";
import { clearClaimedUpload } from "@/lib/website/import-upload";
import {
  runHealthCheckRound,
  selectDueWebsites,
} from "@/lib/website/tool-lifecycle";
import { enrichSourceItem, selectEnrichableItems } from "@/lib/content/article-enrich";
import { ingestSource, selectDueSources } from "@/lib/content/ingest";
import {
  finalizeDirectRewriteBatch,
  markDirectRewriteStarted,
  prepareDirectRewrite,
  runDirectRewriteItem,
  type DirectRewriteContext,
} from "@/lib/website/tool-rewrite-batch";

/**
 * 通用后台批量任务：长操作异步化（第一版无外部队列）。
 *
 * 模式：创建 job（写 BulkJob + BulkJobItem，均 queued）→ 前端跳到
 * /admin/jobs/[id]，页面循环调用 run-next，每次分块处理 CHUNK_SIZE 条并
 * 更新进度 → 全部处理完自动置 completed / completed_with_errors。
 *
 * 每条 item 直接复用现有单条批量助手（bulkMarkReviewed / bulkPublish），
 * 服务端逐条重新校验资格 —— 不信任前端状态、不降低任何 guard：
 * - mark reviewed 仍要求 draft_generated + 非 qc_failed
 * - publish 仍要求 pending + human_reviewed + 媒体本地化通过
 */

// 叫醒后台 worker（动态 import 避免与 job-worker 形成静态循环依赖）。
// worker 未启动 / 未启用时静默忽略，任务仍可由任务页驱动。
function nudgeJobWorker(): void {
  void import("@/lib/website/job-worker")
    .then((m) => m.requestJobWorkerTick())
    .catch(() => {});
}

export const CHUNK_SIZE = 5;

// 直连 AI 改写每条要等 provider 返回（可达数十秒），每块只跑 1 条：
// 既避免单个 run-next 请求超时，也让进度条按条推进。
export const REWRITE_CHUNK_SIZE = 1;

export type BulkJobType =
  | "health_check"
  | "apply_and_review"
  | "publish"
  | "import_excel"
  | "rewrite_direct"
  | "content_ingest"
  | "content_article_enrich";

const JOB_TYPES: BulkJobType[] = [
  "health_check",
  "apply_and_review",
  "publish",
  "import_excel",
  "rewrite_direct",
  "content_ingest",
  "content_article_enrich",
];

// 可达性探测：每块 20 条。单条约 1–3 秒（HEAD 短路居多），一块 ~1 分钟，
// 既不会让 run-next 请求超时，也能让进度条稳定推进。
export const HEALTH_CHECK_CHUNK_SIZE = 20;

// 内容采集：每块 5 个源。单个源要抓订阅再逐条落库，比探测慢得多，
// 块开得大会让 run-next 请求超时。
export const CONTENT_INGEST_CHUNK_SIZE = 5;

function chunkSizeFor(type: BulkJobType): number {
  if (type === "health_check") return HEALTH_CHECK_CHUNK_SIZE;
  if (type === "content_ingest") return CONTENT_INGEST_CHUNK_SIZE;
  if (type === "content_article_enrich") return ARTICLE_ENRICH_CHUNK_SIZE;
  return type === "rewrite_direct" ? REWRITE_CHUNK_SIZE : CHUNK_SIZE;
}

export function isBulkJobType(value: string): value is BulkJobType {
  return (JOB_TYPES as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 创建
// ---------------------------------------------------------------------------

export async function createBulkJob(
  type: BulkJobType,
  websiteIds: number[],
  params: Record<string, unknown> = {}
): Promise<
  | {
      ok: true;
      jobId: number;
      total: number;
      skipped: { websiteId: number; reason: string }[];
    }
  | { ok: false; message: string }
> {
  const ids = [...new Set(websiteIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return { ok: false, message: "未选择任何工具" };
  if (ids.length > BULK_LIMIT_MAX) {
    return { ok: false, message: `单次最多 ${BULK_LIMIT_MAX} 条，请分批执行` };
  }

  // 开了复检的审核任务，在建任务时先用当前闸门筛一遍，不合格的不进队列。
  // 执行时 bulkMarkReviewed 还会再判一次 —— 这里挡在前面只是让用户当场看到
  // 「N 条因当前 QC 不通过未入队」，而不是等任务跑完才发现全被 skip。
  const skipped: { websiteId: number; reason: string }[] = [];
  let eligible = ids;
  if (type === "apply_and_review" && params.recheckQc === true) {
    const verdicts = await currentQcVerdicts(ids);
    eligible = ids.filter((id) => {
      const verdict = verdicts.get(id);
      if (verdict && !verdict.ok) {
        skipped.push({ websiteId: id, reason: verdict.reason });
        return false;
      }
      return true;
    });
    if (!eligible.length) {
      return { ok: false, message: `选中的 ${ids.length} 条均未通过当前 QC 复检，任务未创建` };
    }
  }

  const job = await prisma.bulkJob.create({
    data: {
      type,
      status: "queued",
      total_count: eligible.length,
      params: params as Prisma.InputJsonValue,
    },
  });
  await prisma.bulkJobItem.createMany({
    data: eligible.map((websiteId) => ({ job_id: job.id, website_id: websiteId })),
  });
  nudgeJobWorker();
  return { ok: true, jobId: job.id, total: eligible.length, skipped };
}

// ---------------------------------------------------------------------------
// Excel 导入任务：创建
// ---------------------------------------------------------------------------

// 导入按行分块执行，不存在单请求超时问题，因此行数上限比 websiteIds 批量宽松
export const IMPORT_JOB_MAX_ROWS = 2000;

export type CreateImportJobInput = {
  files: ImportFileInput[];
  overwrite: boolean;
  batchName?: string | null;
  previewToken: string;
};

export async function createImportJob(
  input: CreateImportJobInput
): Promise<
  | { ok: true; jobId: number; batchId: number; total: number; skippedRows: number }
  | { ok: false; message: string }
> {
  const plan = await buildImportPlan(prisma, input.files);
  if (!plan.records.length) {
    return { ok: false, message: "没有可导入的有效行" };
  }
  if (plan.records.length > IMPORT_JOB_MAX_ROWS) {
    return {
      ok: false,
      message: `单次最多导入 ${IMPORT_JOB_MAX_ROWS} 行，请拆分文件`,
    };
  }

  const batch = await prisma.toolImportBatch.create({
    data: {
      name: input.batchName ?? null,
      source_dir: "admin-upload",
      file_count: plan.files.length,
      row_count: plan.totalRows,
      error_count: plan.totalErrors,
    },
  });
  // 文件行先落库（导入过程中可见），计数在任务收尾时回填
  await prisma.toolImportFile.createMany({
    data: plan.files.map((file) => ({
      batch_id: batch.id,
      file_path: file.filePath,
      file_name: file.fileName,
      row_count: file.rowCount,
      error_count: file.errorCount,
      error_log: file.errorLog,
      level1_category: file.level1,
      level2_category: file.level2,
    })),
  });

  const job = await prisma.bulkJob.create({
    data: {
      type: "import_excel",
      status: "queued",
      total_count: plan.records.length,
      related_import_batch_id: batch.id,
      params: {
        files: input.files.map((file) => ({
          filePath: file.filePath,
          fileName: file.fileName ?? null,
        })),
        overwrite: input.overwrite,
        previewToken: input.previewToken,
        batchName: input.batchName ?? null,
        totalRows: plan.totalRows,
        skippedRows: plan.totalErrors,
      } as Prisma.InputJsonValue,
    },
  });
  await prisma.bulkJobItem.createMany({
    data: plan.records.map(() => ({ job_id: job.id })),
  });
  nudgeJobWorker();

  return {
    ok: true,
    jobId: job.id,
    batchId: batch.id,
    total: plan.records.length,
    skippedRows: plan.totalErrors,
  };
}

// ---------------------------------------------------------------------------
// 可达性探测任务：创建
// ---------------------------------------------------------------------------

// 一次任务最多取多少条到期工具。日均到期量远小于此，上限只是防止一次建出巨型任务。
export const HEALTH_CHECK_JOB_MAX = 800;

/**
 * 建可达性探测任务。
 *
 * **全局同时只允许一个未终结的 health_check 任务**：多个任务并行会让全局并发
 * 失控（每个任务各自按块跑），也会让同一批到期工具被重复探测。想加大吞吐应该
 * 调 chunk size，不是开多个任务。
 */
export async function createHealthCheckJob(
  limit = HEALTH_CHECK_JOB_MAX
): Promise<
  { ok: true; jobId: number; total: number } | { ok: false; message: string }
> {
  const running = await prisma.bulkJob.findFirst({
    where: { type: "health_check", status: { notIn: TERMINAL_JOB_STATUSES } },
    select: { id: true, status: true },
  });
  if (running) {
    return {
      ok: false,
      message: `已有未终结的探测任务 #${running.id}（${running.status}），同时只允许一个`,
    };
  }

  const capped = Math.min(Math.max(1, limit), HEALTH_CHECK_JOB_MAX);
  const websiteIds = await selectDueWebsites(capped);
  if (!websiteIds.length) return { ok: false, message: "当前没有到期需要探测的工具" };

  const job = await prisma.bulkJob.create({
    data: {
      type: "health_check",
      status: "queued",
      total_count: websiteIds.length,
      params: { limit: capped, selectedAt: new Date().toISOString() } as Prisma.InputJsonValue,
    },
  });
  await prisma.bulkJobItem.createMany({
    data: websiteIds.map((websiteId) => ({ job_id: job.id, website_id: websiteId })),
  });
  nudgeJobWorker();
  return { ok: true, jobId: job.id, total: websiteIds.length };
}

// ---------------------------------------------------------------------------
// 任务终态收口
// ---------------------------------------------------------------------------

/**
 * 把任务转入终态，并终结它剩下的 queued 条目。
 *
 * 不这么做的后果实测过：C3 Canary 取消任务 #176 时留下了 item#2925 —— 归属任务
 * 已终态、worker 永远不会驱动它，但「卡住 item」这个监控指标会一直显示 1，
 * 把真正的卡死淹掉。
 *
 * running 条目**不粗暴覆盖**：那是别人正在跑的活，交给 worker 安全收尾或
 * 僵死回收，这里只管 queued。历史记录一条都不删。
 */
export async function terminalizeJob(
  jobId: number,
  status: "canceled" | "failed",
  reason = "parent_job_cancelled"
): Promise<{ jobStatus: string; itemsTerminalized: number }> {
  const [, terminalized] = await prisma.$transaction([
    prisma.bulkJob.update({
      where: { id: jobId },
      data: { status, finished_at: new Date(), locked_by: null, locked_until: null },
    }),
    prisma.bulkJobItem.updateMany({
      where: { job_id: jobId, status: "queued" },
      data: { status: "skipped", error: reason },
    }),
  ]);
  return { jobStatus: status, itemsTerminalized: terminalized.count };
}

/**
 * 真正卡住的条目：只算归属任务仍可驱动的。
 * 终态任务下的 queued 条目是历史残留，不是待办。
 */
export async function countActionableStuckItems(olderThanMs = 30 * 60_000): Promise<number> {
  return prisma.bulkJobItem.count({
    where: {
      status: { in: ["queued", "running"] },
      job: { status: { in: DRIVABLE_JOB_STATUSES } },
      updated_at: { lt: new Date(Date.now() - olderThanMs) },
    },
  });
}

/**
 * 修复历史遗留：终态任务下仍是 queued 的条目。
 * 只改状态并写明原因，**不删除**任何记录。
 */
export async function repairTerminalJobItems(
  reason = "parent_job_cancelled"
): Promise<{ repaired: number; jobs: number[] }> {
  const orphans = await prisma.bulkJobItem.findMany({
    where: { status: "queued", job: { status: { in: TERMINAL_JOB_STATUSES } } },
    select: { id: true, job_id: true },
  });
  if (!orphans.length) return { repaired: 0, jobs: [] };
  await prisma.bulkJobItem.updateMany({
    where: { id: { in: orphans.map((o) => o.id) } },
    data: { status: "skipped", error: reason },
  });
  return { repaired: orphans.length, jobs: [...new Set(orphans.map((o) => o.job_id))] };
}

// ---------------------------------------------------------------------------
// 内容采集任务：创建
// ---------------------------------------------------------------------------

export const CONTENT_INGEST_JOB_MAX = 200;

/**
 * 建内容采集任务。
 *
 * 与 health_check 同一条纪律：**全局同时只允许一个未终结的 content_ingest 任务**。
 * 多个任务并行会让同一个源被重复抓取，也会把对源站的并发放大到不礼貌的程度。
 * 想加吞吐应该调 chunk size，不是开多个任务。
 */
export async function createContentIngestJob(
  limit = CONTENT_INGEST_JOB_MAX
): Promise<{ ok: true; jobId: number; total: number } | { ok: false; message: string }> {
  const running = await prisma.bulkJob.findFirst({
    where: { type: "content_ingest", status: { notIn: TERMINAL_JOB_STATUSES } },
    select: { id: true, status: true },
  });
  if (running) {
    return {
      ok: false,
      message: `已有未终结的采集任务 #${running.id}（${running.status}），同时只允许一个`,
    };
  }

  const capped = Math.min(Math.max(1, limit), CONTENT_INGEST_JOB_MAX);
  const sourceIds = await selectDueSources(capped);
  if (!sourceIds.length) return { ok: false, message: "当前没有到期需要抓取的信息源" };

  const job = await prisma.bulkJob.create({
    data: {
      type: "content_ingest",
      status: "queued",
      total_count: sourceIds.length,
      params: { limit: capped, selectedAt: new Date().toISOString() } as Prisma.InputJsonValue,
    },
  });
  await prisma.bulkJobItem.createMany({
    data: sourceIds.map((sourceId) => ({ job_id: job.id, source_id: sourceId })),
  });
  nudgeJobWorker();
  return { ok: true, jobId: job.id, total: sourceIds.length };
}

// ---------------------------------------------------------------------------
// 文章增强任务：创建
// ---------------------------------------------------------------------------

/** 一次一条：抓第三方页面要串行且有间隔，吞吐不是这里的目标 */
export const ARTICLE_ENRICH_CHUNK_SIZE = 1;
export const ARTICLE_ENRICH_JOB_MAX = 50;

/**
 * 建文章增强任务。
 *
 * 与 content_ingest 同一条纪律：**全局同时只允许一个未终结的增强任务**。
 * 并行会把对同一个源站的请求频率放大到不礼貌的程度，同域 2 秒间隔也就形同虚设。
 */
export async function createArticleEnrichJob(
  limit = 10,
  sourceIds?: number[],
  /** Canary 用的显式条目列表。资格仍由 selectEnrichableItems 逐条重判，不绕策略闸门 */
  onlyItemIds?: number[]
): Promise<{ ok: true; jobId: number; total: number } | { ok: false; message: string }> {
  const running = await prisma.bulkJob.findFirst({
    where: { type: "content_article_enrich", status: { notIn: TERMINAL_JOB_STATUSES } },
    select: { id: true, status: true },
  });
  if (running) {
    return {
      ok: false,
      message: `已有未终结的文章增强任务 #${running.id}（${running.status}），同时只允许一个`,
    };
  }

  const capped = Math.min(Math.max(1, limit), ARTICLE_ENRICH_JOB_MAX);
  const itemIds = await selectEnrichableItems(capped, sourceIds, onlyItemIds);
  if (!itemIds.length) return { ok: false, message: "没有符合条件的待增强条目" };

  const job = await prisma.bulkJob.create({
    data: {
      type: "content_article_enrich",
      status: "queued",
      total_count: itemIds.length,
      params: {
        limit: capped,
        ...(sourceIds?.length ? { sourceIds } : {}),
        selectedAt: new Date().toISOString(),
      } as Prisma.InputJsonValue,
    },
  });
  await prisma.bulkJobItem.createMany({
    data: itemIds.map((sourceItemId) => ({ job_id: job.id, source_item_id: sourceItemId })),
  });
  nudgeJobWorker();
  return { ok: true, jobId: job.id, total: itemIds.length };
}

// ---------------------------------------------------------------------------
// 直连 AI 改写任务：创建
// ---------------------------------------------------------------------------

// 把改写批次的待处理条目转成后台任务（不在本请求内调用 AI）。
// 资格与 provider 校验全部复用 prepareDirectRewrite，不降低任何 guard；
// 结果仍只写 ai_rewrite_draft（draft_generated），不会自动 human_reviewed / approved。
export async function createRewriteJob(
  rewriteBatchId: number
): Promise<{ ok: true; jobId: number; total: number } | { ok: false; message: string }> {
  const running = await prisma.bulkJob.findFirst({
    where: {
      type: "rewrite_direct",
      related_rewrite_batch_id: rewriteBatchId,
      status: { in: ["queued", "running"] },
    },
    select: { id: true },
  });
  if (running) {
    return {
      ok: false,
      message: `该批次已有进行中的任务 #${running.id}，请在任务页查看进度`,
    };
  }

  const prepared = await prepareDirectRewrite(rewriteBatchId);
  if (!prepared.ok) return prepared;
  const websiteIds = prepared.pendingWebsiteIds;
  if (!websiteIds.length) {
    return { ok: false, message: "批次没有待处理条目" };
  }

  const job = await prisma.bulkJob.create({
    data: {
      type: "rewrite_direct",
      status: "queued",
      total_count: websiteIds.length,
      related_rewrite_batch_id: rewriteBatchId,
      params: { rewriteBatchId } as Prisma.InputJsonValue,
    },
  });
  await prisma.bulkJobItem.createMany({
    data: websiteIds.map((websiteId) => ({ job_id: job.id, website_id: websiteId })),
  });
  await markDirectRewriteStarted(rewriteBatchId, websiteIds.length);
  nudgeJobWorker();

  return { ok: true, jobId: job.id, total: websiteIds.length };
}

// ---------------------------------------------------------------------------
// 分块执行
// ---------------------------------------------------------------------------

// 条目心跳间隔：远小于 job-worker 的僵死回收阈值
const ITEM_HEARTBEAT_MS = 60_000;

/**
 * 条目处理期间定期 touch updated_at。
 *
 * 单条可能跑很久（AI 改写上限 180s、媒体下载、数据库变慢时更久），若不刷新
 * 时间戳，僵死回收会把「还在跑」误判成「进程已死」并放回 queued，导致同一条被
 * 并发执行两次 —— 对 AI 改写就是重复计费。写 status: "running" 是空操作，
 * 目的只是触发 Prisma 更新 @updatedAt；条目一旦不再是 running 就不会被改到。
 */
function startItemHeartbeat(itemId: number): () => void {
  const timer = setInterval(() => {
    void prisma.bulkJobItem
      .updateMany({ where: { id: itemId, status: "running" }, data: { status: "running" } })
      .catch(() => {});
    // 任务租约不在这里续 —— 它归 startJobLeaseHeartbeat 管，覆盖整个 chunk。
    // 挂在这里的旧写法对短条目根本不触发（12s 的条目等不到 60s 的第一跳）。
  }, ITEM_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// 任务级租约
//
// 条目领取是原子的，所以多个 worker 不会把同一条跑两遍 —— 但每多一个 worker
// 就多一路并发打向 provider（两个进程 = 两条 AI 请求同时在飞）。限流和账单都
// 受不了这个放大，所以再加一层：同一时刻只有一个 worker 能推进同一个任务。
//
// 租约是有期限的：持有者进程被杀也不会把任务永久锁死，过期后其它 worker 自然
// 接管；处理期间由心跳续期。
// ---------------------------------------------------------------------------

const WORKER_INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const JOB_LEASE_MS = Number(process.env.BULK_JOB_LEASE_MS) || 2 * 60_000;

async function acquireJobLease(jobId: number): Promise<boolean> {
  const now = new Date();
  const acquired = await prisma.bulkJob.updateMany({
    where: {
      id: jobId,
      OR: [
        { locked_until: null },
        { locked_until: { lt: now } },
        { locked_by: WORKER_INSTANCE_ID }, // 本进程续持
      ],
    },
    data: {
      locked_by: WORKER_INSTANCE_ID,
      locked_until: new Date(Date.now() + JOB_LEASE_MS),
    },
  });
  return acquired.count === 1;
}

/** 续租一次。返回 false 表示租约已不属于本 worker（或任务已终态），必须停手。 */
async function renewJobLease(jobId: number): Promise<boolean> {
  const renewed = await prisma.bulkJob.updateMany({
    where: {
      id: jobId,
      locked_by: WORKER_INSTANCE_ID,
      status: { in: DRIVABLE_JOB_STATUSES },
    },
    data: { locked_until: new Date(Date.now() + JOB_LEASE_MS) },
  });
  return renewed.count === 1;
}

/** 续租间隔：必须显著小于租约时长，留出至少一次重试的余量 */
const LEASE_HEARTBEAT_MS = Number(process.env.BULK_JOB_LEASE_HEARTBEAT_MS) || 30_000;

export type LeaseHeartbeat = {
  /** 租约是否已丢失（被别人接管、任务终态、或续租连续失败） */
  lost: () => boolean;
  /** 丢失原因，供调用方回报 */
  reason: () => "lease_lost" | "lease_renew_failed" | null;
  /** 成功续租次数，测试用 */
  renewals: () => number;
  stop: () => void;
};

/**
 * 任务级租约心跳：整个 chunk 期间持续续租，与单条 item 的执行时长无关。
 *
 * 之前续租挂在 item 心跳里（60s 一次），而 health_check 单条只要约 12 秒 ——
 * 定时器在首次触发前就被 clearInterval 清掉，于是租约只在 chunk 开始时设置一次，
 * 一个 chunk（20 × 12s ≈ 240s）必然跑过 120s 的租约期。单 worker 时能靠 chunk
 * 边界自愈，多实例时第二个 worker 就能在 chunk 中途抢走租约并发跑。
 */
function startJobLeaseHeartbeat(jobId: number): LeaseHeartbeat {
  let lost = false;
  let reason: "lease_lost" | "lease_renew_failed" | null = null;
  let renewals = 0;

  const timer = setInterval(() => {
    void renewJobLease(jobId)
      .then((ok) => {
        if (ok) renewals++;
        else if (!lost) {
          // 条件没匹配上：租约已被别人接管，或任务已终态
          lost = true;
          reason = "lease_lost";
        }
      })
      .catch(() => {
        // 数据库故障导致续租失败：无法证明租约仍属于自己，按丢失处理。
        // 保守方向 —— 宁可停下让别人接管，也不要两个 worker 同时推进。
        if (!lost) {
          lost = true;
          reason = "lease_renew_failed";
        }
      });
  }, LEASE_HEARTBEAT_MS);
  timer.unref?.();

  return {
    lost: () => lost,
    reason: () => reason,
    renewals: () => renewals,
    stop: () => clearInterval(timer),
  };
}

async function releaseJobLease(jobId: number): Promise<void> {
  await prisma.bulkJob
    .updateMany({
      where: { id: jobId, locked_by: WORKER_INSTANCE_ID },
      data: { locked_by: null, locked_until: null },
    })
    .catch(() => {});
}

// 单条执行：复用现有批量助手（含全部 guard），把 1 条的结果翻译成 item 结果
async function runSingleItem(
  type: BulkJobType,
  websiteId: number,
  params: Record<string, unknown>
): Promise<{ status: "success" | "skipped" | "failed"; error?: string; result?: Prisma.InputJsonValue }> {
  const reviewNotes = typeof params.reviewNotes === "string" ? params.reviewNotes : "";
  // 复检开关随任务参数走：建任务时勾了，执行每一条时也照样复检
  const recheckQc = params.recheckQc === true;
  // 显式白名单：以前是 apply_and_review ? ... : publish，任何新 job 类型只要漏接
  // 分支就会掉进 publish 把工具发布出去。宁可报错也不能默认发布。
  if (type !== "apply_and_review" && type !== "publish") {
    return { status: "failed", error: `任务类型 ${type} 不该走 runSingleItem` };
  }
  const outcome =
    type === "apply_and_review"
      ? await bulkMarkReviewed([websiteId], reviewNotes, { recheckQc })
      : await bulkPublish([websiteId]);

  if (!outcome.ok) return { status: "failed", error: outcome.message };
  const r = outcome.result;
  if (r.succeeded > 0) {
    return {
      status: "success",
      result: {
        ...(r.mediaLocalized !== undefined
          ? {
              mediaLocalized: r.mediaLocalized,
              mediaAlreadyCached: r.mediaAlreadyCached ?? 0,
              mediaFailed: r.mediaFailed ?? 0,
            }
          : {}),
      } as Prisma.InputJsonValue,
    };
  }
  const reason = r.failedReasons[0]?.reason ?? "不符合执行条件";
  return { status: "skipped", error: reason };
}

// 终态：不再推进
export const TERMINAL_JOB_STATUSES = [
  "completed",
  "completed_with_errors",
  "failed",
  "canceled",
];

// 后台 worker 会自动推进的状态（paused 需要人工在任务页点「继续执行」）
export const DRIVABLE_JOB_STATUSES = ["queued", "running"];

export type RunNextOutcome =
  | {
      ok: true;
      job: BulkJobView;
      processedNow: number;
      /** 本块因租约丢失提前收尾；剩余条目仍是 queued，等下一个持有者接手 */
      leaseLost?: "lease_lost" | "lease_renew_failed";
    }
  | { ok: false; message: string };

export async function runNextChunk(jobId: number): Promise<RunNextOutcome> {
  const job = await prisma.bulkJob.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, message: "任务不存在" };
  if (!isBulkJobType(job.type)) return { ok: false, message: `不支持的任务类型: ${job.type}` };
  if (TERMINAL_JOB_STATUSES.includes(job.status)) {
    const view = await getBulkJob(jobId);
    return { ok: true, job: view!, processedNow: 0 };
  }

  // 拿不到租约 = 另一个驱动者（别的实例，或打开着的任务详情页）正在推进。
  // 不报错也不空转：把当前进度原样返回，调用方照常轮询即可。
  if (!(await acquireJobLease(jobId))) {
    const view = await getBulkJob(jobId);
    return { ok: true, job: view!, processedNow: 0 };
  }

  // 租约到手就立刻开始续期，覆盖整个 chunk
  const lease = startJobLeaseHeartbeat(jobId);
  try {
    return await runChunkLocked(jobId, job, job.type, lease);
  } finally {
    lease.stop();
    // 租约已被别人接管时，releaseJobLease 的 where 匹配不到本 worker，
    // 因此不会清掉新持有者的 locked_by/locked_until
    await releaseJobLease(jobId);
  }
}

// 已持有任务租约时的实际分块执行（jobType 已在上面收窄）
async function runChunkLocked(
  jobId: number,
  job: BulkJob,
  jobType: BulkJobType,
  lease: LeaseHeartbeat
): Promise<RunNextOutcome> {
  // queued → running；paused 说明是人工点了「继续执行」，清掉暂停原因
  if (job.status === "queued" || job.status === "paused") {
    await prisma.bulkJob.update({
      where: { id: jobId },
      data: {
        status: "running",
        started_at: job.started_at ?? new Date(),
        ...(job.status === "paused" ? { error: Prisma.DbNull } : {}),
      },
    });
  }

  const params =
    job.params && typeof job.params === "object" && !Array.isArray(job.params)
      ? (job.params as Record<string, unknown>)
      : {};

  const queued = await prisma.bulkJobItem.findMany({
    where: { job_id: jobId, status: "queued" },
    orderBy: { id: "asc" },
    take: chunkSizeFor(jobType),
    select: { id: true, website_id: true, source_id: true, source_item_id: true },
  });

  // 直连改写：每块开始前重新解析 provider 运行时（key 只在进程内传递）。
  // provider 不可用时直接把任务标记失败，避免前端无限重试。
  let rewriteContext: DirectRewriteContext | null = null;
  if (job.type === "rewrite_direct" && queued.length) {
    const prepared = job.related_rewrite_batch_id
      ? await prepareDirectRewrite(job.related_rewrite_batch_id)
      : ({ ok: false, message: "任务缺少关联改写批次" } as const);
    if (!prepared.ok) {
      await prisma.bulkJob.update({
        where: { id: jobId },
        data: {
          status: "failed",
          finished_at: new Date(),
          error: { message: prepared.message } as Prisma.InputJsonValue,
        },
      });
      const view = await getBulkJob(jobId);
      return { ok: true, job: view!, processedNow: 0 };
    }
    rewriteContext = prepared.context;
  }

  // Excel 导入：item 与解析出的记录按序号一一对应，需先重建 plan
  let importPlan: Awaited<ReturnType<typeof buildImportPlan>> | null = null;
  let recordIndexById: Map<number, number> | null = null;
  if (job.type === "import_excel" && queued.length) {
    const files = Array.isArray(params.files)
      ? (params.files as { filePath: string; fileName: string | null }[]).map((f) => ({
          filePath: f.filePath,
          fileName: f.fileName ?? undefined,
        }))
      : [];
    importPlan = await buildImportPlan(prisma, files);
    if (importPlan.records.length !== job.total_count) {
      // 源文件与创建任务时不一致（被删除/改动），停止并标记失败，避免错位导入
      await prisma.bulkJob.update({
        where: { id: jobId },
        data: {
          status: "failed",
          finished_at: new Date(),
          error: {
            message: `源文件已变化：解析到 ${importPlan.records.length} 行，任务创建时为 ${job.total_count} 行`,
          } as Prisma.InputJsonValue,
        },
      });
      const view = await getBulkJob(jobId);
      return { ok: true, job: view!, processedNow: 0 };
    }
    const allItems = await prisma.bulkJobItem.findMany({
      where: { job_id: jobId },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    recordIndexById = new Map(allItems.map((item, index) => [item.id, index]));
  }

  let processedNow = 0;
  for (const item of queued) {
    // 租约没了就不再领新条目。正在跑的那条已经在上一轮循环里安全收尾，
    // 剩下的仍是 queued —— 不标失败，等新持有者接手。
    if (lease.lost()) break;

    // 原子占用：并发 run-next 时同一条只会被一个请求处理
    const claimed = await prisma.bulkJobItem.updateMany({
      where: { id: item.id, status: "queued" },
      data: { status: "running" },
    });
    if (claimed.count !== 1) continue;

    // 处理期间持续刷新 updated_at，让僵死回收只挑真正被中断的条目
    const stopHeartbeat = startItemHeartbeat(item.id);

    let itemStatus: "success" | "skipped" | "failed" | "qc_failed";
    let itemError: string | null = null;
    let itemResult: Prisma.InputJsonValue | undefined;
    let itemWebsiteId: number | undefined;
    try {
      if (job.type === "import_excel") {
        const index = recordIndexById?.get(item.id);
        const record = index === undefined ? undefined : importPlan?.records[index];
        if (!record) {
          itemStatus = "failed";
          itemError = "找不到对应的导入记录";
        } else {
          const imported = await importSingleRecord(prisma, record, {
            overwrite: params.overwrite === true,
            importBatchId: job.related_import_batch_id,
          });
          itemStatus = imported.outcome === "imported" ? "success" : "skipped";
          itemError =
            imported.outcome === "skipped"
              ? "已存在且未覆盖，或已发布/已人工审核（受覆盖保护）"
              : null;
          itemResult = { name: record.name, slug: record.slug } as Prisma.InputJsonValue;
          // 关联到实际落库的工具，便于任务详情页跳转
          const website = await prisma.website.findFirst({
            where: { OR: [{ slug: record.slug }, { url: record.site }] },
            select: { id: true },
          });
          itemWebsiteId = website?.id;
        }
      } else if (job.type === "content_ingest") {
        // 一个 item = 一个信息源的一轮抓取。
        //
        // 与 health_check 同一套语义：item 状态说的是「采集跑没跑成」，
        // 不是「源健不健康」。源返回 404 也是 success —— 那是有效的采集结论，
        // 否则一批失效订阅会把熔断器打爆。
        if (!item.source_id) {
          itemStatus = "failed";
          itemError = "缺少 source_id";
        } else {
          const ingest = await ingestSource(item.source_id, {
            jobId,
            jobItemId: item.id,
          });
          // item 状态按**归因**分：源侧问题记 skipped（源坏了不是任务坏了），
          // 基础设施问题记 failed（那是我们这边的故障，运维需要看见）。
          itemStatus = ingest.ok
            ? "success"
            : ingest.sourceAtFault
              ? "skipped"
              : "failed";
          itemError = ingest.ok
            ? null
            : `${ingest.runOutcome}/${ingest.errorDomain}: ${ingest.error ?? ""}`.slice(0, 300);
          itemResult = {
            sourceId: ingest.sourceId,
            runId: ingest.runId,
            outcome: ingest.runOutcome,
            errorDomain: ingest.errorDomain,
            sourceAtFault: ingest.sourceAtFault,
            status: ingest.status,
            feedFormat: ingest.feedFormat,
            itemsSeen: ingest.itemsSeen,
            itemsCreated: ingest.itemsCreated,
            itemsDuplicate: ingest.itemsDuplicate,
            itemsTitleChanged: ingest.itemsTitleChanged,
            itemsSkipped: ingest.itemsSkipped,
            itemsErrored: ingest.itemsErrored,
            truncated: ingest.truncated,
          } as Prisma.InputJsonValue;
        }
      } else if (job.type === "content_article_enrich") {
        // 一个 item = 一条来源条目的一次正文抓取。
        //
        // 与 content_ingest 同一套归因：源站拒绝 / 正文不足都是**有效结论**，
        // 记 skipped 而不是 failed —— 那不是任务坏了。只有我们这边的故障记 failed。
        if (!item.source_item_id) {
          itemStatus = "failed";
          itemError = "缺少 source_item_id";
        } else {
          const enriched = await enrichSourceItem(item.source_item_id, {
            jobId,
            jobItemId: item.id,
          });
          itemStatus = enriched.ok ? "success" : enriched.sourceAtFault ? "skipped" : "failed";
          itemError = enriched.ok
            ? null
            : `${enriched.outcome ?? "NONE"}/${enriched.errorDomain}: ${enriched.error ?? ""}`.slice(0, 300);
          itemResult = {
            sourceItemId: enriched.sourceItemId,
            runId: enriched.runId,
            outcome: enriched.outcome,
            errorDomain: enriched.errorDomain,
            sourceAtFault: enriched.sourceAtFault,
            visibleTextLength: enriched.visibleTextLength,
          } as Prisma.InputJsonValue;
        }
      } else if (!item.website_id) {
        itemStatus = "failed";
        itemError = "缺少 website_id";
      } else if (job.type === "health_check") {
        // 一个 item = 一轮 scheduled round，恰好产出一个 outcome。
        //
        // item 状态的语义是「探针跑没跑成」，不是「站点活没活着」：
        // 探针成功判定出 dead 也是 success。否则一批真死链会把熔断器打爆。
        // deferred 记 skipped —— 本轮什么都没结论，等下次。
        const round = await runHealthCheckRound(item.website_id, jobId);
        itemStatus = round.outcome === "deferred" ? "skipped" : "success";
        itemError =
          round.outcome === "ok" ? null : `outcome=${round.outcome}`;
        itemResult = {
          outcome: round.outcome,
          reachFrom: round.reachFrom,
          reachTo: round.reachTo,
          changeFlags: round.changeFlags,
          eventId: round.eventId,
          ...(round.versionMismatch ? { versionMismatch: true } : {}),
        } as Prisma.InputJsonValue;
      } else if (job.type === "rewrite_direct") {
        const outcome = await runDirectRewriteItem(rewriteContext!, item.website_id);
        // qc_failed 单列一档：模型答了但内容不合格，重试同一个 prompt 没有意义，
        // 和「请求失败」混在一起会误导排障，也会误触发熔断
        itemStatus =
          outcome.outcome === "saved"
            ? "success"
            : outcome.outcome === "skipped"
            ? "skipped"
            : outcome.outcome === "qc_failed"
            ? "qc_failed"
            : "failed";
        itemError = outcome.outcome === "saved" ? null : outcome.message ?? null;
        itemResult = { rewriteOutcome: outcome.outcome } as Prisma.InputJsonValue;
      } else {
        const single = await runSingleItem(jobType, item.website_id, params);
        itemStatus = single.status;
        itemError = single.error ?? null;
        itemResult = single.result;
      }
    } catch (error) {
      itemStatus = "failed";
      itemError = error instanceof Error ? error.message.slice(0, 300) : "执行异常";
    } finally {
      stopHeartbeat();
    }

    try {
      await prisma.bulkJobItem.update({
        where: { id: item.id },
        data: {
          status: itemStatus,
          error: itemError,
          ...(itemResult !== undefined ? { result: itemResult } : {}),
          ...(itemWebsiteId !== undefined ? { website_id: itemWebsiteId } : {}),
        },
      });
      processedNow++;
    } catch (error) {
      // 写回失败（多半是数据库瞬断）：活可能已经干完，但记账没落库。
      // 把条目退回 queued 让下一块立刻重跑，而不是留在 running 空等僵死回收窗口。
      // 重跑是安全的：三种任务的单条执行都会重新校验状态，已完成的会被判为
      // skipped（publish 只接受 pending、改写跳过已 saved、导入跳过已存在）。
      console.error(
        `[bulk-job] 条目 #${item.id} 结果写回失败，已退回 queued 重试:`,
        error instanceof Error ? error.message : "unknown"
      );
      await prisma.bulkJobItem
        .updateMany({
          where: { id: item.id, status: "running" },
          data: { status: "queued", error: null },
        })
        .catch(() => {});
    }
  }

  // 重算进度；无剩余 queued/running 则收尾
  const counts = await prisma.bulkJobItem.groupBy({
    by: ["status"],
    where: { job_id: jobId },
    _count: true,
  });
  const count = (status: string) => counts.find((c) => c.status === status)?._count ?? 0;
  const success = count("success");
  const skipped = count("skipped");
  const failed = count("failed");
  const qcFailed = count("qc_failed");
  const remaining = count("queued") + count("running");
  const done = remaining === 0;

  // 汇总 publish 的媒体统计到 job.result
  let jobResult: Prisma.InputJsonValue | undefined;
  if (done && job.type === "publish") {
    const items = await prisma.bulkJobItem.findMany({
      where: { job_id: jobId },
      select: { result: true },
    });
    let mediaLocalized = 0;
    let mediaAlreadyCached = 0;
    let mediaFailed = 0;
    for (const item of items) {
      const r = item.result as Record<string, number> | null;
      if (r) {
        mediaLocalized += r.mediaLocalized ?? 0;
        mediaAlreadyCached += r.mediaAlreadyCached ?? 0;
        mediaFailed += r.mediaFailed ?? 0;
      }
    }
    jobResult = { mediaLocalized, mediaAlreadyCached, mediaFailed };
  }

  // 改写任务收尾：按条目实际状态重算批次计数并置 imported
  if (done && job.type === "rewrite_direct" && job.related_rewrite_batch_id) {
    const totals = await finalizeDirectRewriteBatch(job.related_rewrite_batch_id);
    jobResult = {
      saved: totals.saved,
      qcFailed: totals.qcFailed,
      failed: totals.failed,
      rewriteBatchId: job.related_rewrite_batch_id,
    };
  }

  // 导入任务收尾：回填 ToolImportBatch / ToolImportFile 计数，并清理临时上传文件
  if (done && job.type === "import_excel" && job.related_import_batch_id) {
    await finalizeImportJob(jobId, job.related_import_batch_id, params, {
      imported: success,
      skipped,
      failed,
    });
    jobResult = {
      imported: success,
      skipped,
      failed,
      skippedRows: typeof params.skippedRows === "number" ? params.skippedRows : 0,
      batchId: job.related_import_batch_id,
    };
  }

  await prisma.bulkJob.update({
    where: { id: jobId },
    data: {
      processed_count: success + skipped + failed + qcFailed,
      success_count: success,
      skipped_count: skipped,
      failed_count: failed,
      qc_failed_count: qcFailed,
      ...(done
        ? {
            status:
              skipped + failed + qcFailed > 0 ? "completed_with_errors" : "completed",
            finished_at: new Date(),
            ...(jobResult !== undefined ? { result: jobResult } : {}),
          }
        : {}),
    },
  });

  const view = await getBulkJob(jobId);
  // 租约中途丢失时如实回报：剩余条目仍是 queued，调用方据此知道本块是提前收尾的
  const leaseLost = lease.reason();
  return { ok: true, job: view!, processedNow, ...(leaseLost ? { leaseLost } : {}) };
}

// 导入任务收尾：按文件回填计数、关闭批次、删除临时上传目录
async function finalizeImportJob(
  jobId: number,
  batchId: number,
  params: Record<string, unknown>,
  totals: { imported: number; skipped: number; failed: number }
): Promise<void> {
  const files = Array.isArray(params.files)
    ? (params.files as { filePath: string; fileName: string | null }[]).map((f) => ({
        filePath: f.filePath,
        fileName: f.fileName ?? undefined,
      }))
    : [];

  // 按 item 顺序把结果归属到各文件（每个文件占用连续的记录区间）
  try {
    const plan = await buildImportPlan(prisma, files);
    const items = await prisma.bulkJobItem.findMany({
      where: { job_id: jobId },
      orderBy: { id: "asc" },
      select: { status: true },
    });
    for (const file of plan.files) {
      const slice = items.slice(file.recordStart, file.recordStart + file.recordCount);
      await prisma.toolImportFile.updateMany({
        where: { batch_id: batchId, file_name: file.fileName },
        data: {
          imported_count: slice.filter((i) => i.status === "success").length,
          skipped_count: slice.filter((i) => i.status === "skipped").length,
        },
      });
    }
  } catch {
    // 源文件此时可能已不可读；批次总计仍按 job 统计写入，不阻塞收尾
  }

  await prisma.toolImportBatch.update({
    where: { id: batchId },
    data: {
      imported_count: totals.imported,
      skipped_count: totals.skipped + totals.failed,
      finished_at: new Date(),
    },
  });

  const previewToken =
    typeof params.previewToken === "string" ? params.previewToken : "";
  if (previewToken) {
    try {
      clearClaimedUpload(previewToken);
    } catch (error) {
      console.error(
        "Cleanup after import job failed:",
        error instanceof Error ? error.message : "unknown"
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export type BulkJobItemView = {
  id: number;
  websiteId: number | null;
  websiteTitle: string | null;
  websiteSlug: string | null;
  status: string;
  error: string | null;
};

export type BulkJobView = {
  id: number;
  type: string;
  status: string;
  totalCount: number;
  processedCount: number;
  successCount: number;
  skippedCount: number;
  failedCount: number;
  qcFailedCount: number;
  result: unknown;
  error: unknown;
  relatedImportBatchId: number | null;
  relatedRewriteBatchId: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  items: BulkJobItemView[];
};

export async function getBulkJob(jobId: number): Promise<BulkJobView | null> {
  const job = await prisma.bulkJob.findUnique({
    where: { id: jobId },
    include: {
      items: { orderBy: { id: "asc" } },
    },
  });
  if (!job) return null;

  // item → website 标题（一次查全）
  const websiteIds = job.items
    .map((item) => item.website_id)
    .filter((id): id is number => typeof id === "number");
  const websites = await prisma.website.findMany({
    where: { id: { in: websiteIds } },
    select: { id: true, title: true, slug: true },
  });
  const byId = new Map(websites.map((w) => [w.id, w]));

  return {
    id: job.id,
    type: job.type,
    status: job.status,
    totalCount: job.total_count,
    processedCount: job.processed_count,
    successCount: job.success_count,
    skippedCount: job.skipped_count,
    failedCount: job.failed_count,
    qcFailedCount: job.qc_failed_count,
    result: job.result,
    error: job.error,
    relatedImportBatchId: job.related_import_batch_id,
    relatedRewriteBatchId: job.related_rewrite_batch_id,
    createdAt: job.created_at.toISOString(),
    startedAt: job.started_at?.toISOString() ?? null,
    finishedAt: job.finished_at?.toISOString() ?? null,
    items: job.items.map((item) => ({
      id: item.id,
      websiteId: item.website_id,
      websiteTitle: item.website_id ? byId.get(item.website_id)?.title ?? null : null,
      websiteSlug: item.website_id ? byId.get(item.website_id)?.slug ?? null : null,
      status: item.status,
      error: item.error,
    })),
  };
}

// ---------------------------------------------------------------------------
// 无人值守支持：worker 调度用的查询与状态操作
// ---------------------------------------------------------------------------

// 取最早一个可推进的任务（FIFO，一次只驱动一个，避免并发打满 provider / DB）
export async function findNextDrivableJob(): Promise<{
  id: number;
  type: string;
  successCount: number;
  skippedCount: number;
  failedCount: number;
  qcFailedCount: number;
} | null> {
  const job = await prisma.bulkJob.findFirst({
    where: { status: { in: DRIVABLE_JOB_STATUSES } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      type: true,
      success_count: true,
      skipped_count: true,
      failed_count: true,
      qc_failed_count: true,
    },
  });
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    successCount: job.success_count,
    skippedCount: job.skipped_count,
    failedCount: job.failed_count,
    qcFailedCount: job.qc_failed_count,
  };
}

// 回收僵死条目：进程在处理中被杀会留下 running 的 item，任务将永远无法收尾。
// 超过阈值未更新的 running 条目放回 queued，由下一轮重新领取。
export async function reclaimStalledItems(staleMs: number): Promise<number> {
  const threshold = new Date(Date.now() - staleMs);
  const reclaimed = await prisma.bulkJobItem.updateMany({
    where: {
      status: "running",
      updated_at: { lt: threshold },
      job: { status: { notIn: TERMINAL_JOB_STATUSES } },
    },
    data: { status: "queued", error: null },
  });
  return reclaimed.count;
}

// 熔断：连续失败时暂停任务（非终态，人工在任务页点「继续执行」可恢复）
export async function pauseJob(jobId: number, message: string): Promise<void> {
  await prisma.bulkJob.updateMany({
    where: { id: jobId, status: { notIn: TERMINAL_JOB_STATUSES } },
    data: { status: "paused", error: { message } as Prisma.InputJsonValue },
  });
}

// 改写批次页用：该批次最近一次后台改写任务（用于展示进度入口）
export async function findLatestRewriteJob(
  rewriteBatchId: number
): Promise<{ id: number; status: string } | null> {
  return prisma.bulkJob.findFirst({
    where: { type: "rewrite_direct", related_rewrite_batch_id: rewriteBatchId },
    orderBy: { id: "desc" },
    select: { id: true, status: true },
  });
}

export type BulkJobSummary = Omit<BulkJobView, "items">;

export async function listBulkJobs(limit = 50): Promise<BulkJobSummary[]> {
  const jobs = await prisma.bulkJob.findMany({
    orderBy: { id: "desc" },
    take: limit,
  });
  return jobs.map((job) => ({
    id: job.id,
    type: job.type,
    status: job.status,
    totalCount: job.total_count,
    processedCount: job.processed_count,
    successCount: job.success_count,
    skippedCount: job.skipped_count,
    failedCount: job.failed_count,
    qcFailedCount: job.qc_failed_count,
    result: job.result,
    error: job.error,
    relatedImportBatchId: job.related_import_batch_id,
    relatedRewriteBatchId: job.related_rewrite_batch_id,
    createdAt: job.created_at.toISOString(),
    startedAt: job.started_at?.toISOString() ?? null,
    finishedAt: job.finished_at?.toISOString() ?? null,
  }));
}
