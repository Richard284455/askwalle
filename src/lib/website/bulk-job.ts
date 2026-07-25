import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { bulkMarkReviewed, bulkPublish, BULK_LIMIT_MAX } from "@/lib/website/tool-review";
import {
  buildImportPlan,
  importSingleRecord,
  type ImportFileInput,
} from "@/lib/website/tool-import";
import { clearClaimedUpload } from "@/lib/website/import-upload";
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

export const CHUNK_SIZE = 5;

// 直连 AI 改写每条要等 provider 返回（可达数十秒），每块只跑 1 条：
// 既避免单个 run-next 请求超时，也让进度条按条推进。
export const REWRITE_CHUNK_SIZE = 1;

export type BulkJobType =
  | "apply_and_review"
  | "publish"
  | "import_excel"
  | "rewrite_direct";

const JOB_TYPES: BulkJobType[] = [
  "apply_and_review",
  "publish",
  "import_excel",
  "rewrite_direct",
];

function chunkSizeFor(type: BulkJobType): number {
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
): Promise<{ ok: true; jobId: number; total: number } | { ok: false; message: string }> {
  const ids = [...new Set(websiteIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return { ok: false, message: "未选择任何工具" };
  if (ids.length > BULK_LIMIT_MAX) {
    return { ok: false, message: `单次最多 ${BULK_LIMIT_MAX} 条，请分批执行` };
  }

  const job = await prisma.bulkJob.create({
    data: {
      type,
      status: "queued",
      total_count: ids.length,
      params: params as Prisma.InputJsonValue,
    },
  });
  await prisma.bulkJobItem.createMany({
    data: ids.map((websiteId) => ({ job_id: job.id, website_id: websiteId })),
  });
  return { ok: true, jobId: job.id, total: ids.length };
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

  return {
    ok: true,
    jobId: job.id,
    batchId: batch.id,
    total: plan.records.length,
    skippedRows: plan.totalErrors,
  };
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

  return { ok: true, jobId: job.id, total: websiteIds.length };
}

// ---------------------------------------------------------------------------
// 分块执行
// ---------------------------------------------------------------------------

// 单条执行：复用现有批量助手（含全部 guard），把 1 条的结果翻译成 item 结果
async function runSingleItem(
  type: BulkJobType,
  websiteId: number,
  params: Record<string, unknown>
): Promise<{ status: "success" | "skipped" | "failed"; error?: string; result?: Prisma.InputJsonValue }> {
  const reviewNotes = typeof params.reviewNotes === "string" ? params.reviewNotes : "";
  const outcome =
    type === "apply_and_review"
      ? await bulkMarkReviewed([websiteId], reviewNotes)
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

export type RunNextOutcome =
  | { ok: true; job: BulkJobView; processedNow: number }
  | { ok: false; message: string };

export async function runNextChunk(jobId: number): Promise<RunNextOutcome> {
  const job = await prisma.bulkJob.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, message: "任务不存在" };
  if (!isBulkJobType(job.type)) return { ok: false, message: `不支持的任务类型: ${job.type}` };
  if (["completed", "completed_with_errors", "failed", "canceled"].includes(job.status)) {
    const view = await getBulkJob(jobId);
    return { ok: true, job: view!, processedNow: 0 };
  }

  if (job.status === "queued") {
    await prisma.bulkJob.update({
      where: { id: jobId },
      data: { status: "running", started_at: job.started_at ?? new Date() },
    });
  }

  const params =
    job.params && typeof job.params === "object" && !Array.isArray(job.params)
      ? (job.params as Record<string, unknown>)
      : {};

  const queued = await prisma.bulkJobItem.findMany({
    where: { job_id: jobId, status: "queued" },
    orderBy: { id: "asc" },
    take: chunkSizeFor(job.type),
    select: { id: true, website_id: true },
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
    // 原子占用：并发 run-next 时同一条只会被一个请求处理
    const claimed = await prisma.bulkJobItem.updateMany({
      where: { id: item.id, status: "queued" },
      data: { status: "running" },
    });
    if (claimed.count !== 1) continue;

    let itemStatus: "success" | "skipped" | "failed";
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
      } else if (!item.website_id) {
        itemStatus = "failed";
        itemError = "缺少 website_id";
      } else if (job.type === "rewrite_direct") {
        const outcome = await runDirectRewriteItem(rewriteContext!, item.website_id);
        itemStatus =
          outcome.outcome === "saved"
            ? "success"
            : outcome.outcome === "skipped"
            ? "skipped"
            : "failed";
        itemError = outcome.outcome === "saved" ? null : outcome.message ?? null;
        itemResult = { rewriteOutcome: outcome.outcome } as Prisma.InputJsonValue;
      } else {
        const single = await runSingleItem(job.type, item.website_id, params);
        itemStatus = single.status;
        itemError = single.error ?? null;
        itemResult = single.result;
      }
    } catch (error) {
      itemStatus = "failed";
      itemError = error instanceof Error ? error.message.slice(0, 300) : "执行异常";
    }

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
      processed_count: success + skipped + failed,
      success_count: success,
      skipped_count: skipped,
      failed_count: failed,
      ...(done
        ? {
            status: skipped + failed > 0 ? "completed_with_errors" : "completed",
            finished_at: new Date(),
            ...(jobResult !== undefined ? { result: jobResult } : {}),
          }
        : {}),
    },
  });

  const view = await getBulkJob(jobId);
  return { ok: true, job: view!, processedNow };
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
    result: job.result,
    error: job.error,
    relatedImportBatchId: job.related_import_batch_id,
    relatedRewriteBatchId: job.related_rewrite_batch_id,
    createdAt: job.created_at.toISOString(),
    startedAt: job.started_at?.toISOString() ?? null,
    finishedAt: job.finished_at?.toISOString() ?? null,
  }));
}
