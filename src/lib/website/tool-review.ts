import { Prisma, RewriteStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  applyRewriteDraft,
  assertPublishAllowed,
  markToolReviewed,
} from "@/lib/website/tool-admin";
import { ensureMediaLocalizedBeforePublish } from "@/lib/website/tool-media-cache";
import {
  rawForWebsite,
  validateRewriteDraft,
} from "@/lib/website/tool-rewrite-batch";

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

/**
 * provider / model / qcStatus 三个筛选看的是「最近一次」改写条目，不是「任意一次」
 * ——一个工具可能第一批 QC 失败、第二批通过，用 `some` 会把它同时算进两边。
 *
 * 以前这三个是在取回前 300 条之后做内存过滤，于是筛选结果在数据量超过 300 时
 * 直接是错的（第 301 名之后的工具永远出不来）。这里改成先用 DISTINCT ON 把每个
 * 工具的最近一次条目算出来，拿到 id 集合再交给主查询，分页才是准的。
 *
 * 返回 null 表示这三个筛选都没启用，不需要限制 id。
 */
async function websiteIdsByLatestRewriteItem(
  filter: ReviewListFilter
): Promise<number[] | null> {
  if (!filter.provider && !filter.model && !filter.qcStatus) return null;

  const rows = await prisma.$queryRaw<{ website_id: number }[]>`
    SELECT website_id FROM (
      SELECT DISTINCT ON (i.website_id)
             i.website_id, i.qc_status, b.provider, b.model
        FROM tool_rewrite_items i
        JOIN tool_rewrite_batches b ON b.id = i.batch_id
       ORDER BY i.website_id, i.id DESC
    ) latest
     WHERE (${filter.qcStatus ?? null}::text IS NULL OR latest.qc_status = ${filter.qcStatus ?? null}::text)
       AND (${filter.provider ?? null}::text IS NULL OR latest.provider = ${filter.provider ?? null}::text)
       AND (${filter.model ?? null}::text IS NULL OR latest.model = ${filter.model ?? null}::text)
  `;
  return rows.map((row) => row.website_id);
}

export type ReviewListPage = {
  items: ReviewListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export const REVIEW_PAGE_SIZE_MAX = 200;

export async function getReviewList(
  filter: ReviewListFilter,
  pagination?: { page?: number; pageSize?: number }
): Promise<ReviewListPage> {
  const pageSize = Math.min(
    Math.max(pagination?.pageSize ?? 100, 1),
    REVIEW_PAGE_SIZE_MAX
  );
  const page = Math.max(pagination?.page ?? 1, 1);

  const where: Prisma.WebsiteWhereInput = {
    toolDetail: { isNot: null },
  };

  // 多个 id 来源（批次筛选 / 最近一次条目筛选）取交集
  const idSets: number[][] = [];
  if (filter.rewriteBatchId) {
    idSets.push(await websiteIdsForBatch(filter.rewriteBatchId));
  }
  const latestIds = await websiteIdsByLatestRewriteItem(filter);
  if (latestIds !== null) idSets.push(latestIds);

  if (idSets.length) {
    const intersection = idSets.reduce((acc, ids) => {
      const set = new Set(ids);
      return acc.filter((id) => set.has(id));
    });
    where.id = { in: intersection.length ? intersection : [-1] };
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

  const total = await prisma.website.count({ where });
  const websites = await prisma.website.findMany({
    where,
    orderBy: { updated_at: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
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

  const items = websites.map((website) => {
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

  return { items, total, page, pageSize };
}

/**
 * 当前筛选命中的全部 website id（不分页）。
 * 供「选中全部 N 条」使用：批量操作有 100 条上限，客户端拿到完整 id 集合后
 * 自行分批提交，用户不必手工翻页勾选。
 */
export async function getReviewFilterIds(
  filter: ReviewListFilter
): Promise<number[]> {
  const page = await getReviewList(filter, { page: 1, pageSize: 1 });
  if (page.total === 0) return [];

  // 复用同一套筛选：按页取完，保证与列表口径完全一致
  const ids: number[] = [];
  const pageSize = REVIEW_PAGE_SIZE_MAX;
  const pages = Math.ceil(page.total / pageSize);
  for (let p = 1; p <= pages; p++) {
    const chunk = await getReviewList(filter, { page: p, pageSize });
    ids.push(...chunk.items.map((item) => item.websiteId));
  }
  return ids;
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

// ---------------------------------------------------------------------------
// 当前 QC 实时复检
//
// 落库的 qc_status 记的是「跑那一批时的闸门怎么判的」。闸门后来收紧过，于是有
// 一批草稿顶着 passed 的旧记录，实际已经不合格 —— 相似度口径从字段拼接改成逐单元
// 之后，就有 12 条这样的草稿。历史状态、前端传来的 eligible、latest item 三者都
// 不能单独作为放行依据，apply / mark reviewed 之前必须拿当前草稿重跑一次生产闸门。
// ---------------------------------------------------------------------------

// 复检需要的最小字段集
const QC_RECHECK_SELECT = {
  id: true,
  title: true,
  description: true,
  toolDetail: {
    select: {
      rewrite_status: true,
      ai_rewrite_draft: true,
      raw_imported_content: true,
      what: true,
      how: true,
      features_text: true,
      use_cases: true,
    },
  },
} satisfies Prisma.WebsiteSelect;

type QcRecheckSubject = Prisma.WebsiteGetPayload<{
  select: typeof QC_RECHECK_SELECT;
}>;

export type CurrentQcVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 复检开关。默认**不**复检 —— 落库的 qc_status 在每次回溯复检之后是准的，
 * 而复检要对每条草稿跑词级 DP，100 条的批量会明显变慢。闸门改动之后先跑一次
 * 回溯复检把 qc_status 刷新，日常批量就不必每次重算。
 *
 * 什么时候该打开：闸门刚改过、还没跑回溯复检，或者不确定 qc_status 是否已经漂移。
 */
export type ReviewOptions = { recheckQc?: boolean };

/**
 * 用当前生产闸门判定一条工具的草稿。
 *
 * 没有草稿时返回通过 —— 这条路径是「人工直接编辑公开字段后标记审核」，本来就
 * 没有 AI 草稿可查，交给 applyRewriteDraft / markToolReviewed 的既有校验兜底。
 */
export function currentQcVerdictFor(
  subject: QcRecheckSubject | null | undefined
): CurrentQcVerdict {
  if (!subject?.toolDetail) return { ok: false, reason: "无 ToolDetail" };
  const draft = subject.toolDetail.ai_rewrite_draft;
  if (!draft) return { ok: true };

  const raw = rawForWebsite({
    title: subject.title,
    description: subject.description,
    toolDetail: subject.toolDetail,
  });
  const verdict = validateRewriteDraft(draft, raw);
  if (verdict.ok) return { ok: true };
  return {
    ok: false,
    reason: `当前 QC 未通过: ${verdict.errors.join("；")}`,
  };
}

/** 批量复检；一次查询取回全部所需字段，避免逐条往返 */
export async function currentQcVerdicts(
  websiteIds: number[]
): Promise<Map<number, CurrentQcVerdict>> {
  const subjects = await prisma.website.findMany({
    where: { id: { in: websiteIds } },
    select: QC_RECHECK_SELECT,
  });
  const byId = new Map(subjects.map((s) => [s.id, s]));
  return new Map(
    websiteIds.map((id) => [id, currentQcVerdictFor(byId.get(id))])
  );
}

// A. 批量应用草稿到公开字段（复用单条 applyRewriteDraft；不改 status）
export async function bulkApplyDrafts(
  websiteIds: number[],
  options: ReviewOptions = {}
): Promise<{ ok: true; result: BulkResult } | { ok: false; message: string }> {
  const check = validateBulkInput(websiteIds);
  if (!check.ok) return check;

  const result = emptyResult(websiteIds.length);
  const subjects = await prisma.website.findMany({
    where: { id: { in: websiteIds } },
    select: QC_RECHECK_SELECT,
  });
  const subjectByWebsite = new Map(subjects.map((s) => [s.id, s]));

  for (const websiteId of websiteIds) {
    const subject = subjectByWebsite.get(websiteId);
    const detail = subject?.toolDetail;
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
    // 历史 qc_status 只说明「当时通过」。开启复检时拿当前草稿再判一次
    if (options.recheckQc) {
      const current = currentQcVerdictFor(subject);
      if (!current.ok) {
        result.skipped++;
        result.failedReasons.push({ websiteId, reason: current.reason });
        continue;
      }
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
  reviewNotes: string,
  options: ReviewOptions = {}
): Promise<{ ok: true; result: BulkResult } | { ok: false; message: string }> {
  const check = validateBulkInput(websiteIds);
  if (!check.ok) return check;

  const result = emptyResult(websiteIds.length);
  const subjects = await prisma.website.findMany({
    where: { id: { in: websiteIds } },
    select: QC_RECHECK_SELECT,
  });
  const subjectByWebsite = new Map(subjects.map((s) => [s.id, s]));

  for (const websiteId of websiteIds) {
    const subject = subjectByWebsite.get(websiteId);
    const detail = subject?.toolDetail;
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
    // 同 apply：开启复检时用当前闸门重判当前草稿
    if (options.recheckQc) {
      const current = currentQcVerdictFor(subject);
      if (!current.ok) {
        result.skipped++;
        result.failedReasons.push({ websiteId, reason: current.reason });
        continue;
      }
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
