import { Prisma, RewriteStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  applyRewriteDraft,
  assertPublishAllowed,
  markToolReviewed,
} from "@/lib/website/tool-admin";
import { ensureMediaLocalizedBeforePublish } from "@/lib/website/tool-media-cache";

// 单次批量操作上限；超过需分页批处理（后续再做）
export const BULK_LIMIT_MAX = 100;

// ---------------------------------------------------------------------------
// 列表 / 筛选
// ---------------------------------------------------------------------------

export type ReviewListFilter = {
  rewriteBatchId?: number;
  categoryId?: number;
  provider?: string;
  model?: string;
  websiteStatus?: string;
  rewriteStatus?: string;
  qcStatus?: string;
  search?: string;
};

export type ReviewListItem = {
  websiteId: number;
  title: string;
  slug: string | null;
  categoryName: string;
  websiteStatus: string;
  rewriteStatus: string | null;
  qcStatus: string | null;
  provider: string | null;
  model: string | null;
  updatedAt: string;
};

// rewriteBatchId 过滤时先解析出该批次涉及的 website 集合
async function websiteIdsForBatch(batchId: number): Promise<number[]> {
  const items = await prisma.toolRewriteItem.findMany({
    where: { batch_id: batchId },
    select: { website_id: true },
  });
  return [...new Set(items.map((item) => item.website_id))];
}

export async function getReviewList(
  filter: ReviewListFilter
): Promise<ReviewListItem[]> {
  const where: Prisma.WebsiteWhereInput = {
    toolDetail: { isNot: null },
  };

  if (filter.rewriteBatchId) {
    const ids = await websiteIdsForBatch(filter.rewriteBatchId);
    where.id = { in: ids.length ? ids : [-1] };
  }
  if (filter.categoryId) where.category_id = filter.categoryId;
  if (filter.websiteStatus) where.status = filter.websiteStatus;
  if (filter.rewriteStatus) {
    where.toolDetail = {
      is: { rewrite_status: filter.rewriteStatus as RewriteStatus },
    };
  }
  if (filter.search) {
    const query = filter.search.trim();
    where.OR = [
      { title: { contains: query, mode: "insensitive" } },
      { slug: { contains: query, mode: "insensitive" } },
    ];
  }

  const websites = await prisma.website.findMany({
    where,
    orderBy: { updated_at: "desc" },
    take: 300,
    select: {
      id: true,
      title: true,
      slug: true,
      status: true,
      updated_at: true,
      category: { select: { name: true } },
      toolDetail: { select: { rewrite_status: true } },
      rewriteItems: {
        orderBy: { id: "desc" },
        take: 1,
        select: {
          qc_status: true,
          batch: { select: { provider: true, model: true } },
        },
      },
    },
  });

  let items = websites.map((website) => {
    const latestItem = website.rewriteItems[0];
    return {
      websiteId: website.id,
      title: website.title,
      slug: website.slug,
      categoryName: website.category.name,
      websiteStatus: website.status,
      rewriteStatus: website.toolDetail?.rewrite_status ?? null,
      qcStatus: latestItem?.qc_status ?? null,
      provider: latestItem?.batch.provider ?? null,
      model: latestItem?.batch.model ?? null,
      updatedAt: website.updated_at.toISOString(),
    };
  });

  // provider / model / qcStatus 依赖最近一次 rewrite item，做内存过滤
  if (filter.provider) {
    items = items.filter((item) => item.provider === filter.provider);
  }
  if (filter.model) {
    items = items.filter((item) => item.model === filter.model);
  }
  if (filter.qcStatus) {
    items = items.filter((item) => item.qcStatus === filter.qcStatus);
  }

  return items;
}

// ---------------------------------------------------------------------------
// 统计卡片（全部由现有字段计算，不新增 DB 字段）
// ---------------------------------------------------------------------------

export type ReviewStats = {
  pendingRewrite: number; // raw_imported（含待修复）
  draftGenerated: number; // draft_generated
  qcPassed: number; // draft_generated 且最近一次 QC 通过
  qcFailed: number; // 最近一次 QC 失败
  pendingReview: number; // = qcPassed（待应用/待审核合并）
  pendingPublish: number; // human_reviewed + pending
  published: number; // approved
  archived: number; // archived
};

export async function getReviewStats(): Promise<ReviewStats> {
  const websites = await prisma.website.findMany({
    where: { toolDetail: { isNot: null } },
    select: {
      status: true,
      toolDetail: { select: { rewrite_status: true } },
      rewriteItems: {
        orderBy: { id: "desc" },
        take: 1,
        select: { qc_status: true },
      },
    },
  });

  const stats: ReviewStats = {
    pendingRewrite: 0,
    draftGenerated: 0,
    qcPassed: 0,
    qcFailed: 0,
    pendingReview: 0,
    pendingPublish: 0,
    published: 0,
    archived: 0,
  };

  for (const w of websites) {
    const rewrite = w.toolDetail?.rewrite_status;
    const qc = w.rewriteItems[0]?.qc_status ?? null;
    if (w.status === "approved") stats.published++;
    else if (w.status === "archived") stats.archived++;

    if (rewrite === RewriteStatus.raw_imported) stats.pendingRewrite++;
    else if (rewrite === RewriteStatus.draft_generated) {
      stats.draftGenerated++;
      if (qc === "passed") stats.qcPassed++;
    } else if (rewrite === RewriteStatus.human_reviewed && w.status === "pending") {
      stats.pendingPublish++;
    }
    if (qc === "failed") stats.qcFailed++;
  }
  stats.pendingReview = stats.qcPassed;
  return stats;
}

// ---------------------------------------------------------------------------
// 单条预览（raw + draft + 公开当前字段 + QC 错误；不含任何 key）
// ---------------------------------------------------------------------------

export type ReviewPreview = {
  websiteId: number;
  title: string;
  websiteStatus: string;
  rewriteStatus: string | null;
  current: {
    description: string;
    what: string;
    how: string;
    features: string[];
    useCases: string[];
    faqs: { question: string; answer: string | null }[];
  };
  raw: unknown;
  draft: unknown;
  qcErrors: string[];
};

function stringArray(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

export async function getReviewPreview(
  websiteId: number
): Promise<ReviewPreview | null> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      toolDetail: {
        select: {
          what: true,
          how: true,
          features: true,
          use_cases: true,
          raw_imported_content: true,
          ai_rewrite_draft: true,
          rewrite_status: true,
        },
      },
      toolFaqs: {
        orderBy: { position: "asc" },
        select: { question: true, answer: true },
      },
      rewriteItems: {
        orderBy: { id: "desc" },
        take: 1,
        select: { qc_errors: true },
      },
    },
  });
  if (!website || !website.toolDetail) return null;

  return {
    websiteId: website.id,
    title: website.title,
    websiteStatus: website.status,
    rewriteStatus: website.toolDetail.rewrite_status,
    current: {
      description: website.description,
      what: website.toolDetail.what ?? "",
      how: website.toolDetail.how ?? "",
      features: stringArray(website.toolDetail.features),
      useCases: stringArray(website.toolDetail.use_cases),
      faqs: website.toolFaqs,
    },
    raw: website.toolDetail.raw_imported_content,
    draft: website.toolDetail.ai_rewrite_draft,
    qcErrors: Array.isArray(website.rewriteItems[0]?.qc_errors)
      ? (website.rewriteItems[0].qc_errors as unknown[]).filter(
          (v): v is string => typeof v === "string"
        )
      : [],
  };
}

// ---------------------------------------------------------------------------
// 批量操作（服务端逐条重校验资格，不信前端 checkbox）
// ---------------------------------------------------------------------------

export type BulkResult = {
  selected: number;
  succeeded: number;
  skipped: number;
  failed: number;
  failedReasons: { websiteId: number; reason: string }[];
  affectedIds: number[];
  // 仅 publish 填充：发布前媒体本地化统计
  mediaLocalized?: number;
  mediaAlreadyCached?: number;
  mediaFailed?: number;
};

function emptyResult(selected: number): BulkResult {
  return {
    selected,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    failedReasons: [],
    affectedIds: [],
  };
}

function validateBulkInput(
  websiteIds: number[]
): { ok: true } | { ok: false; message: string } {
  if (!Array.isArray(websiteIds) || websiteIds.length === 0) {
    return { ok: false, message: "未选择任何工具" };
  }
  if (websiteIds.length > BULK_LIMIT_MAX) {
    return {
      ok: false,
      message: `单次批量操作最多 ${BULK_LIMIT_MAX} 条，请分批处理`,
    };
  }
  return { ok: true };
}

// 最近一次 rewrite item 的 QC 是否通过（用于 apply / mark reviewed 资格判断）
async function latestQcPassed(websiteId: number): Promise<boolean> {
  const item = await prisma.toolRewriteItem.findFirst({
    where: { website_id: websiteId },
    orderBy: { id: "desc" },
    select: { qc_status: true },
  });
  // 无 rewrite item（如单条手工粘贴草稿）视为通过，交给 applyRewriteDraft 的结构校验兜底
  return item ? item.qc_status === "passed" : true;
}

// A. 批量应用草稿到公开字段（复用单条 applyRewriteDraft；不改 status）
export async function bulkApplyDrafts(
  websiteIds: number[]
): Promise<{ ok: true; result: BulkResult } | { ok: false; message: string }> {
  const check = validateBulkInput(websiteIds);
  if (!check.ok) return check;

  const result = emptyResult(websiteIds.length);
  const details = await prisma.toolDetail.findMany({
    where: { website_id: { in: websiteIds } },
    select: { website_id: true, rewrite_status: true, ai_rewrite_draft: true },
  });
  const detailByWebsite = new Map(details.map((d) => [d.website_id, d]));

  for (const websiteId of websiteIds) {
    const detail = detailByWebsite.get(websiteId);
    if (!detail || !detail.ai_rewrite_draft) {
      result.skipped++;
      result.failedReasons.push({ websiteId, reason: "无 AI 改写草稿" });
      continue;
    }
    if (detail.rewrite_status !== RewriteStatus.draft_generated) {
      result.skipped++;
      result.failedReasons.push({
        websiteId,
        reason: `rewrite_status=${detail.rewrite_status}，仅 draft_generated 可应用`,
      });
      continue;
    }
    if (!(await latestQcPassed(websiteId))) {
      result.skipped++;
      result.failedReasons.push({ websiteId, reason: "最近一次 QC 未通过" });
      continue;
    }
    const applied = await applyRewriteDraft(websiteId);
    if (applied.ok) {
      result.succeeded++;
      result.affectedIds.push(websiteId);
    } else {
      result.failed++;
      result.failedReasons.push({ websiteId, reason: applied.message });
    }
  }
  return { ok: true, result };
}

// B. 批量标记人工已审核（先自动 apply 再 mark；qc_failed / raw_imported 一律拒绝）
export async function bulkMarkReviewed(
  websiteIds: number[],
  reviewNotes: string
): Promise<{ ok: true; result: BulkResult } | { ok: false; message: string }> {
  const check = validateBulkInput(websiteIds);
  if (!check.ok) return check;

  const result = emptyResult(websiteIds.length);
  const details = await prisma.toolDetail.findMany({
    where: { website_id: { in: websiteIds } },
    select: { website_id: true, rewrite_status: true, ai_rewrite_draft: true },
  });
  const detailByWebsite = new Map(details.map((d) => [d.website_id, d]));

  for (const websiteId of websiteIds) {
    const detail = detailByWebsite.get(websiteId);
    if (!detail) {
      result.skipped++;
      result.failedReasons.push({ websiteId, reason: "无 ToolDetail" });
      continue;
    }
    if (detail.rewrite_status === RewriteStatus.human_reviewed) {
      result.skipped++;
      result.failedReasons.push({ websiteId, reason: "已是 human_reviewed" });
      continue;
    }
    // 只允许 draft_generated；raw_imported / 其它一律拒绝
    if (detail.rewrite_status !== RewriteStatus.draft_generated) {
      result.skipped++;
      result.failedReasons.push({
        websiteId,
        reason: `rewrite_status=${detail.rewrite_status}，仅 draft_generated 可审核`,
      });
      continue;
    }
    if (!(await latestQcPassed(websiteId))) {
      result.skipped++;
      result.failedReasons.push({ websiteId, reason: "QC 未通过，不能标记审核" });
      continue;
    }

    // 尚未 apply 的草稿先 apply（applyRewriteDraft 会重跑结构校验，兜底 HTML 等）
    if (detail.ai_rewrite_draft) {
      const applied = await applyRewriteDraft(websiteId);
      if (!applied.ok) {
        result.failed++;
        result.failedReasons.push({
          websiteId,
          reason: `apply 失败: ${applied.message}`,
        });
        continue;
      }
    }
    const reviewed = await markToolReviewed(websiteId, reviewNotes);
    if (reviewed.ok) {
      result.succeeded++;
      result.affectedIds.push(websiteId);
    } else {
      result.failed++;
      result.failedReasons.push({ websiteId, reason: reviewed.message });
    }
  }
  return { ok: true, result };
}

// C. 批量发布（复用 assertPublishAllowed；仅 pending + human_reviewed）
export async function bulkPublish(
  websiteIds: number[]
): Promise<{ ok: true; result: BulkResult } | { ok: false; message: string }> {
  const check = validateBulkInput(websiteIds);
  if (!check.ok) return check;

  const result = emptyResult(websiteIds.length);
  const websites = await prisma.website.findMany({
    where: { id: { in: websiteIds } },
    select: { id: true, status: true },
  });
  const statusByWebsite = new Map(websites.map((w) => [w.id, w.status]));

  for (const websiteId of websiteIds) {
    const status = statusByWebsite.get(websiteId);
    if (status === undefined) {
      result.skipped++;
      result.failedReasons.push({ websiteId, reason: "工具不存在" });
      continue;
    }
    if (status !== "pending") {
      result.skipped++;
      result.failedReasons.push({
        websiteId,
        reason: `status=${status}，仅 pending 可发布`,
      });
      continue;
    }
    // 复用现有发布守卫：非 human_reviewed 一律拒绝
    const allowed = await assertPublishAllowed(websiteId, "approved");
    if (!allowed.ok) {
      result.skipped++;
      result.failedReasons.push({ websiteId, reason: allowed.message });
      continue;
    }
    // 媒体本地化 guard：外链缓存失败的工具不发布（单个失败不影响其它工具）
    const media = await ensureMediaLocalizedBeforePublish(prisma, websiteId);
    result.mediaLocalized = (result.mediaLocalized ?? 0) + media.stats.cached;
    result.mediaAlreadyCached =
      (result.mediaAlreadyCached ?? 0) + media.stats.alreadyCached;
    result.mediaFailed = (result.mediaFailed ?? 0) + media.stats.failed;
    if (!media.ok) {
      result.skipped++;
      result.failedReasons.push({ websiteId, reason: media.message });
      continue;
    }
    await prisma.website.update({
      where: { id: websiteId },
      data: { status: "approved" },
    });
    result.succeeded++;
    result.affectedIds.push(websiteId);
  }
  return { ok: true, result };
}

// D. 批量归档 / 拒绝（不物理删除）
export async function bulkSetStatus(
  websiteIds: number[],
  status: "archived" | "rejected"
): Promise<{ ok: true; result: BulkResult } | { ok: false; message: string }> {
  const check = validateBulkInput(websiteIds);
  if (!check.ok) return check;

  const result = emptyResult(websiteIds.length);
  const websites = await prisma.website.findMany({
    where: { id: { in: websiteIds } },
    select: { id: true },
  });
  const existing = new Set(websites.map((w) => w.id));

  for (const websiteId of websiteIds) {
    if (!existing.has(websiteId)) {
      result.skipped++;
      result.failedReasons.push({ websiteId, reason: "工具不存在" });
      continue;
    }
    await prisma.website.update({
      where: { id: websiteId },
      data: { status },
    });
    result.succeeded++;
    result.affectedIds.push(websiteId);
  }
  return { ok: true, result };
}
