import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { bulkMarkReviewed, bulkPublish, BULK_LIMIT_MAX } from "@/lib/website/tool-review";

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

export type BulkJobType = "apply_and_review" | "publish";

const JOB_TYPES: BulkJobType[] = ["apply_and_review", "publish"];

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
    take: CHUNK_SIZE,
    select: { id: true, website_id: true },
  });

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
    try {
      if (!item.website_id) {
        itemStatus = "failed";
        itemError = "缺少 website_id";
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
    relatedImportBatchId: job.related_import_batch_id,
    relatedRewriteBatchId: job.related_rewrite_batch_id,
    createdAt: job.created_at.toISOString(),
    startedAt: job.started_at?.toISOString() ?? null,
    finishedAt: job.finished_at?.toISOString() ?? null,
  }));
}
