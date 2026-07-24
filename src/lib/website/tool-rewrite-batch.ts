import { Prisma, RewriteStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  buildRawSnapshot,
  type RawImportedContent,
} from "@/lib/website/tool-admin";

// ---------------------------------------------------------------------------
// Provider 配置来自 AI Provider 配置中心（env 优先于 DB，key 仅服务端解析）
//
// - openai:   官方 Batch API（异步：Submit → Refresh → Import results）
// - deepseek/qwen/kimi/custom: OpenAI 兼容 chat/completions 直连模式
//   （Submit 即同步逐条改写并完成 QC 入库；无需 Refresh/Import）
// ---------------------------------------------------------------------------

import {
  getProviderSetting,
  getProviderSettings,
  isProviderKey,
  providerMode,
  resolveProviderRuntime,
  type ProviderKey,
  type ProviderSettingsView,
} from "@/lib/website/ai-provider-config";

export type RewriteProviderId = ProviderKey;

export function isRewriteProvider(value: string): value is RewriteProviderId {
  return isProviderKey(value);
}

export function getDefaultProvider(): RewriteProviderId {
  const configured = process.env.REWRITE_PROVIDER;
  return configured && isProviderKey(configured) ? configured : "openai";
}

export function getProviderMode(provider: string): "batch" | "direct" {
  return providerMode(provider);
}

export type RewriteProviderInfo = {
  id: RewriteProviderId;
  label: string;
  model: string;
  modelPresets: string[];
  mode: "batch" | "direct";
  enabled: boolean;
  hasKey: boolean;
  keySource: "env" | "db" | "missing";
  keyEnv: string;
};

// 提供给 UI 的 provider 清单（不含任何 key 值，仅状态信息）
export async function listRewriteProviders(): Promise<RewriteProviderInfo[]> {
  const settings = await getProviderSettings();
  return settings
    .filter(
      (setting) => setting.providerKey !== "custom" || Boolean(setting.baseUrl)
    )
    .map((setting: ProviderSettingsView) => ({
      id: setting.providerKey,
      label: setting.displayName,
      model: setting.defaultModel,
      modelPresets: setting.modelPresets,
      mode: setting.mode,
      enabled: setting.enabled,
      hasKey: setting.keyStatus === "configured",
      keySource: setting.keySource,
      keyEnv: setting.keyEnv,
    }));
}

const BATCH_LIMIT_MAX = 20;

// ---------------------------------------------------------------------------
// Structured Outputs JSON Schema（strict）
// ---------------------------------------------------------------------------

export const REWRITE_DRAFT_JSON_SCHEMA = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description: "1-2 sentence original directory card description",
    },
    what: {
      type: "string",
      description: "2-4 sentence original description of what the tool is",
    },
    how: {
      type: "string",
      description: "2-4 sentence original description of how to get started",
    },
    features: {
      type: "array",
      items: { type: "string" },
      description: "3-8 short original feature statements",
    },
    useCases: {
      type: "array",
      items: { type: "string" },
      description: "2-8 short original use cases",
    },
    faqs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
        },
        required: ["question", "answer"],
        additionalProperties: false,
      },
      description: "2-8 FAQ entries; every answer must be non-empty",
    },
  },
  required: ["description", "what", "how", "features", "useCases", "faqs"],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type BatchRewriteDraft = {
  description: string;
  what: string;
  how: string;
  features: string[];
  useCases: string[];
  faqs: { question: string; answer: string }[];
};

// 选择工具的筛选条件（estimate 与 create 共用，确保预估与实际一致）
export type SelectionFilter = {
  categoryId?: number;
  importBatchId?: number;
  rewriteStatuses?: ("raw_imported" | "draft_generated")[];
  search?: string;
  // 只选有历史失败记录的工具（重试场景）/ 只选无草稿的工具
  retryFilter?: "failed" | "qc_failed" | "no_draft";
  // 已有 ai_rewrite_draft 时默认跳过；勾选后允许重写（仍不含 human_reviewed / approved）
  overwriteExistingDraft?: boolean;
};

export type CreateBatchFilter = SelectionFilter & {
  name?: string;
  limit?: number;
  provider?: RewriteProviderId;
  model?: string;
  modelType?: string; // fast / general / reasoning / custom（仅 UI/metadata）
};

// 可重试的历史 item 状态（重试永远新建 batch，不复用旧 batch）
export const RETRYABLE_ITEM_STATUSES = ["failed", "parse_failed", "qc_failed"];

function allowedStatuses(filter: SelectionFilter): RewriteStatus[] {
  const statuses = (filter.rewriteStatuses?.length
    ? filter.rewriteStatuses
    : ["raw_imported"]) as RewriteStatus[];
  return statuses.filter((s) => s !== RewriteStatus.human_reviewed);
}

// 范围筛选（分类 / 导入批次 / 搜索），estimate 的 skipped 细分也复用
function scopeWhere(filter: SelectionFilter): Prisma.WebsiteWhereInput {
  return {
    ...(filter.categoryId ? { category_id: filter.categoryId } : {}),
    ...(filter.importBatchId ? { import_batch_id: filter.importBatchId } : {}),
    ...(filter.search?.trim()
      ? {
          OR: [
            { title: { contains: filter.search.trim(), mode: "insensitive" } },
            { slug: { contains: filter.search.trim(), mode: "insensitive" } },
          ],
        }
      : {}),
  };
}

// 统一改写资格判断（estimate / create / retry 共用，不信任前端）：
// - Website.status = pending（排除 approved / archived / rejected）
// - rewrite_status ∈ raw_imported / draft_generated（排除 human_reviewed）
// - reviewed_at 为空（人工审过的不允许 AI 覆盖）
// - raw_imported_content 存在（缺 raw 的先修数据）
// - 已有草稿默认跳过，除非显式 overwriteExistingDraft
// 历史 failed / qc_failed item 不构成排除条件——失败的工具必须可以重试。
function eligibleWhere(filter: SelectionFilter): Prisma.WebsiteWhereInput {
  const allowed = allowedStatuses(filter);
  return {
    status: "pending",
    ...scopeWhere(filter),
    toolDetail: {
      rewrite_status: { in: allowed },
      reviewed_at: null,
      NOT: { raw_imported_content: { equals: Prisma.AnyNull } },
      ...(filter.overwriteExistingDraft
        ? {}
        : { ai_rewrite_draft: { equals: Prisma.AnyNull } }),
    },
    ...(filter.retryFilter === "failed"
      ? { rewriteItems: { some: { status: { in: ["failed", "parse_failed"] } } } }
      : filter.retryFilter === "qc_failed"
      ? { rewriteItems: { some: { status: "qc_failed" } } }
      : {}),
    // no_draft 已由默认的 ai_rewrite_draft=null 条件覆盖；显式选择时强制生效
    ...(filter.retryFilter === "no_draft"
      ? { toolDetail: {
          rewrite_status: { in: allowed },
          reviewed_at: null,
          NOT: { raw_imported_content: { equals: Prisma.AnyNull } },
          ai_rewrite_draft: { equals: Prisma.AnyNull },
        } }
      : {}),
  };
}

function selectionWhere(filter: SelectionFilter): Prisma.WebsiteWhereInput {
  return eligibleWhere(filter);
}

// create 与 estimate 共用的请求体解析，保证预估与创建条件一致
export function parseCreateBatchBody(body: unknown): CreateBatchFilter {
  const b = (body ?? {}) as Record<string, unknown>;
  const posInt = (v: unknown) =>
    typeof v === "number" && v > 0 ? Math.floor(v) : undefined;
  return {
    name: typeof b.name === "string" ? b.name : undefined,
    categoryId: posInt(b.categoryId),
    importBatchId: posInt(b.importBatchId),
    limit: posInt(b.limit),
    search: typeof b.search === "string" ? b.search : undefined,
    rewriteStatuses: Array.isArray(b.rewriteStatuses)
      ? (b.rewriteStatuses.filter((s: unknown) =>
          ["raw_imported", "draft_generated"].includes(String(s))
        ) as ("raw_imported" | "draft_generated")[])
      : undefined,
    retryFilter:
      typeof b.retryFilter === "string" &&
      ["failed", "qc_failed", "no_draft"].includes(b.retryFilter)
        ? (b.retryFilter as "failed" | "qc_failed" | "no_draft")
        : undefined,
    overwriteExistingDraft: b.overwriteExistingDraft === true,
    provider:
      typeof b.provider === "string" && isRewriteProvider(b.provider)
        ? (b.provider as RewriteProviderId)
        : undefined,
    model:
      typeof b.model === "string" && b.model.trim() ? b.model.trim() : undefined,
    modelType:
      typeof b.modelType === "string" &&
      ["fast", "general", "reasoning", "custom"].includes(b.modelType)
        ? b.modelType
        : undefined,
  };
}

export type RewriteEstimate = {
  eligible: number;
  limit: number;
  wouldProcess: number;
  wouldSkip: number;
  // 细分：为什么某些工具不会被处理
  skippedApproved: number;
  skippedHumanReviewed: number;
  skippedMissingRaw: number;
  skippedExistingDraft: number;
  // 符合条件工具中有历史失败记录的（可重试）
  retryableFailed: number;
  retryableQcFailed: number;
};

// 预估当前筛选下可处理/跳过数量（不写数据库）
export async function estimateRewriteSelection(
  filter: CreateBatchFilter
): Promise<RewriteEstimate> {
  const limit = Math.min(Math.max(filter.limit ?? BATCH_LIMIT_MAX, 1), BATCH_LIMIT_MAX);
  const scope = scopeWhere(filter);
  const allowed = allowedStatuses(filter);
  const base = selectionWhere(filter);

  const [
    eligible,
    retryableFailed,
    retryableQcFailed,
    skippedApproved,
    skippedHumanReviewed,
    skippedMissingRaw,
    skippedExistingDraft,
  ] = await Promise.all([
    prisma.website.count({ where: base }),
    prisma.website.count({
      where: { AND: [base, { rewriteItems: { some: { status: { in: ["failed", "parse_failed"] } } } }] },
    }),
    prisma.website.count({
      where: { AND: [base, { rewriteItems: { some: { status: "qc_failed" } } }] },
    }),
    prisma.website.count({
      where: { ...scope, status: "approved", toolDetail: { isNot: null } },
    }),
    prisma.website.count({
      where: { ...scope, status: "pending", toolDetail: { rewrite_status: RewriteStatus.human_reviewed } },
    }),
    prisma.website.count({
      where: {
        ...scope,
        status: "pending",
        toolDetail: {
          rewrite_status: { in: allowed },
          reviewed_at: null,
          raw_imported_content: { equals: Prisma.AnyNull },
        },
      },
    }),
    filter.overwriteExistingDraft
      ? Promise.resolve(0)
      : prisma.website.count({
          where: {
            ...scope,
            status: "pending",
            toolDetail: {
              rewrite_status: { in: allowed },
              reviewed_at: null,
              NOT: { ai_rewrite_draft: { equals: Prisma.AnyNull } },
            },
          },
        }),
  ]);

  const wouldProcess = Math.min(eligible, limit);
  return {
    eligible,
    limit,
    wouldProcess,
    wouldSkip: eligible - wouldProcess,
    skippedApproved,
    skippedHumanReviewed,
    skippedMissingRaw,
    skippedExistingDraft,
    retryableFailed,
    retryableQcFailed,
  };
}

export type RewriteBatchSummary = {
  id: number;
  name: string | null;
  provider: string;
  providerMode: "batch" | "direct";
  model: string;
  modelType: string | null;
  categoryId: number | null;
  status: string;
  totalCount: number;
  submittedCount: number;
  completedCount: number;
  failedCount: number;
  qcPassedCount: number;
  qcFailedCount: number;
  openaiBatchId: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type RewriteItemSummary = {
  id: number;
  websiteId: number;
  websiteTitle: string;
  websiteSlug: string | null;
  status: string;
  customId: string;
  qcStatus: string | null;
  qcErrors: string[];
  errorMessage: string | null;
};

export type RewriteBatchDetail = RewriteBatchSummary & {
  filterSnapshot: unknown;
  items: RewriteItemSummary[];
};

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

type BatchRow = Prisma.ToolRewriteBatchGetPayload<Record<string, never>>;

function snapshotField(
  snapshot: Prisma.JsonValue | null,
  key: string
): unknown {
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>)[key]
    : undefined;
}

function toSummary(batch: BatchRow): RewriteBatchSummary {
  const modelType = snapshotField(batch.filter_snapshot, "modelType");
  const categoryId = snapshotField(batch.filter_snapshot, "categoryId");
  return {
    id: batch.id,
    name: batch.name,
    provider: batch.provider,
    providerMode: getProviderMode(batch.provider),
    model: batch.model,
    modelType: typeof modelType === "string" ? modelType : null,
    categoryId: typeof categoryId === "number" ? categoryId : null,
    status: batch.status,
    totalCount: batch.total_count,
    submittedCount: batch.submitted_count,
    completedCount: batch.completed_count,
    failedCount: batch.failed_count,
    qcPassedCount: batch.qc_passed_count,
    qcFailedCount: batch.qc_failed_count,
    openaiBatchId: batch.openai_batch_id,
    submittedAt: batch.submitted_at?.toISOString() ?? null,
    completedAt: batch.completed_at?.toISOString() ?? null,
    createdAt: batch.created_at.toISOString(),
  };
}

export async function listRewriteBatches(): Promise<RewriteBatchSummary[]> {
  const batches = await prisma.toolRewriteBatch.findMany({
    orderBy: { id: "desc" },
    take: 50,
  });
  return batches.map(toSummary);
}

export async function getRewriteBatch(
  batchId: number
): Promise<RewriteBatchDetail | null> {
  const batch = await prisma.toolRewriteBatch.findUnique({
    where: { id: batchId },
    include: {
      items: {
        orderBy: { id: "asc" },
        include: { website: { select: { title: true, slug: true } } },
      },
    },
  });
  if (!batch) return null;
  return {
    ...toSummary(batch),
    filterSnapshot: batch.filter_snapshot,
    items: batch.items.map((item) => ({
      id: item.id,
      websiteId: item.website_id,
      websiteTitle: item.website.title,
      websiteSlug: item.website.slug,
      status: item.status,
      customId: item.custom_id,
      qcStatus: item.qc_status,
      qcErrors: Array.isArray(item.qc_errors)
        ? item.qc_errors.filter((e): e is string => typeof e === "string")
        : [],
      errorMessage: item.error_message,
    })),
  };
}

// ---------------------------------------------------------------------------
// 创建批次
// ---------------------------------------------------------------------------

export async function createRewriteBatch(
  filter: CreateBatchFilter
): Promise<{ ok: true; batchId: number; total: number } | { ok: false; message: string }> {
  const limit = Math.min(Math.max(filter.limit ?? BATCH_LIMIT_MAX, 1), BATCH_LIMIT_MAX);
  const statuses = (filter.rewriteStatuses?.length
    ? filter.rewriteStatuses
    : ["raw_imported"]) as RewriteStatus[];

  // 与 estimate 共用 selectionWhere：只选 pending + 指定审核状态，排除 human_reviewed / approved
  const websites = await prisma.website.findMany({
    where: selectionWhere(filter),
    orderBy: { id: "asc" },
    take: limit,
    select: { id: true },
  });

  if (!websites.length) {
    return { ok: false, message: "没有符合条件的待改写工具" };
  }

  const provider = filter.provider ?? getDefaultProvider();
  const providerSetting = await getProviderSetting(provider);
  const batch = await prisma.toolRewriteBatch.create({
    data: {
      name: filter.name?.trim() || null,
      provider,
      model: filter.model?.trim() || providerSetting.defaultModel,
      filter_snapshot: {
        categoryId: filter.categoryId ?? null,
        importBatchId: filter.importBatchId ?? null,
        rewriteStatuses: statuses,
        search: filter.search?.trim() || null,
        modelType: filter.modelType ?? null,
        retryFilter: filter.retryFilter ?? null,
        overwriteExistingDraft: filter.overwriteExistingDraft ?? false,
        limit,
      } as Prisma.InputJsonValue,
      total_count: websites.length,
    },
  });

  await prisma.toolRewriteItem.createMany({
    data: websites.map((website) => ({
      batch_id: batch.id,
      website_id: website.id,
      custom_id: `tool-${website.id}-batch-${batch.id}`,
    })),
  });

  return { ok: true, batchId: batch.id, total: websites.length };
}

// ---------------------------------------------------------------------------
// Retry Failed：为旧批次的失败条目新建批次（保留历史 batch/item 作审计）
// ---------------------------------------------------------------------------

export async function retryFailedBatch(
  batchId: number
): Promise<
  | { ok: true; batchId: number; total: number; skipped: number }
  | { ok: false; message: string }
> {
  const source = await prisma.toolRewriteBatch.findUnique({
    where: { id: batchId },
    include: {
      items: {
        where: { status: { in: RETRYABLE_ITEM_STATUSES } },
        select: { website_id: true },
      },
    },
  });
  if (!source) return { ok: false, message: "批次不存在" };
  if (!source.items.length) {
    return { ok: false, message: "该批次没有可重试的失败条目" };
  }

  // 服务端重新校验资格（统一 eligibleWhere，不信任前端）：
  // 仍 pending、未 human_reviewed、未 reviewed、raw 存在；draft 已存在的默认跳过
  const failedIds = [...new Set(source.items.map((item) => item.website_id))];
  const eligible = await prisma.website.findMany({
    where: {
      AND: [
        selectionWhere({
          rewriteStatuses: ["raw_imported", "draft_generated"],
          overwriteExistingDraft: false, // 已在别的批次成功出草稿的不重复改写
        }),
        { id: { in: failedIds } },
      ],
    },
    orderBy: { id: "asc" },
    take: BATCH_LIMIT_MAX,
    select: { id: true },
  });
  if (!eligible.length) {
    return {
      ok: false,
      message:
        "失败条目均不可重试（已审核 / 已发布 / 已有草稿 / 缺 raw 数据）",
    };
  }

  const snapshot =
    source.filter_snapshot && typeof source.filter_snapshot === "object"
      ? (source.filter_snapshot as Record<string, unknown>)
      : {};
  const batch = await prisma.toolRewriteBatch.create({
    data: {
      name: `retry-of-${batchId}`,
      provider: source.provider,
      model: source.model,
      filter_snapshot: {
        ...snapshot,
        retryOfBatchId: batchId,
        limit: eligible.length,
      } as Prisma.InputJsonValue,
      total_count: eligible.length,
    },
  });
  await prisma.toolRewriteItem.createMany({
    data: eligible.map((website) => ({
      batch_id: batch.id,
      website_id: website.id,
      custom_id: `tool-${website.id}-batch-${batch.id}`,
    })),
  });

  return {
    ok: true,
    batchId: batch.id,
    total: eligible.length,
    skipped: failedIds.length - eligible.length,
  };
}

// ---------------------------------------------------------------------------
// Prompt 与 JSONL
// ---------------------------------------------------------------------------

function rawForWebsite(website: {
  title: string;
  description: string;
  toolDetail: {
    raw_imported_content: Prisma.JsonValue | null;
    what: string | null;
    how: string | null;
    features_text: string | null;
    use_cases: Prisma.JsonValue | null;
  } | null;
}): RawImportedContent & { description: string } {
  const stored = website.toolDetail?.raw_imported_content;
  const storedRecord =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : null;
  const base = storedRecord
    ? {
        what: typeof storedRecord.what === "string" ? storedRecord.what : "",
        how: typeof storedRecord.how === "string" ? storedRecord.how : "",
        featuresText:
          typeof storedRecord.featuresText === "string"
            ? storedRecord.featuresText
            : "",
        useCases: Array.isArray(storedRecord.useCases)
          ? storedRecord.useCases.filter(
              (v): v is string => typeof v === "string"
            )
          : [],
        faqs: Array.isArray(storedRecord.faqs)
          ? storedRecord.faqs
              .filter(
                (v): v is Record<string, unknown> =>
                  Boolean(v) && typeof v === "object" && !Array.isArray(v)
              )
              .map((v) => ({
                question: typeof v.question === "string" ? v.question : "",
                answer: typeof v.answer === "string" ? v.answer : null,
              }))
              .filter((v) => v.question)
          : [],
      }
    : buildRawSnapshot(website.toolDetail, []);
  const description =
    storedRecord && typeof storedRecord.description === "string"
      ? storedRecord.description
      : website.description;
  return { ...base, description };
}

export function buildBatchRewritePrompt(
  title: string,
  raw: RawImportedContent & { description: string }
): string {
  const reference = JSON.stringify(
    {
      description: raw.description,
      what: raw.what,
      how: raw.how,
      featuresText: raw.featuresText,
      useCases: raw.useCases,
      faqQuestions: raw.faqs.map((faq) => faq.question),
    },
    null,
    2
  );

  return `You are rewriting third-party reference notes about an AI tool called "${title}" into original directory content for a US-focused AI tools directory.

Strict requirements:
- Write completely original wording. Do NOT copy any full sentence or distinctive phrasing from the reference notes.
- Keep facts accurate. Do NOT invent pricing, integrations, APIs, or model support that the notes do not mention.
- Never mention Toolify or any other directory site.
- Professional, concise, trustworthy tone for US business users. No hype.
- "description": 1-2 sentences for a directory card.
- "what": 2-4 sentences on what the tool is and who it is for.
- "how": 2-4 sentences on how a new user gets started.
- "features": 3-8 short original feature statements (max ~15 words each).
- "useCases": 2-8 short original use cases.
- "faqs": 2-8 entries; every answer must be helpful and non-empty. If the notes cannot support a factual answer, write a cautious answer telling the user to verify on the official site.
- No HTML, no Markdown.

Output format:
Respond with a single valid JSON object only (no prose, no code fences), with exactly these keys:
{"description": string, "what": string, "how": string, "features": string[], "useCases": string[], "faqs": [{"question": string, "answer": string}]}

Reference notes (facts only, do not copy wording):
${reference}`;
}

async function loadBatchWebsites(batchId: number) {
  return prisma.toolRewriteItem.findMany({
    where: { batch_id: batchId },
    orderBy: { id: "asc" },
    include: {
      website: {
        select: {
          id: true,
          title: true,
          description: true,
          toolDetail: {
            select: {
              raw_imported_content: true,
              what: true,
              how: true,
              features_text: true,
              use_cases: true,
              rewrite_status: true,
            },
          },
        },
      },
    },
  });
}

// 生成 OpenAI Batch JSONL（/v1/responses + Structured Outputs strict schema）
export async function buildOpenAIBatchJsonl(
  batchId: number
): Promise<{ ok: true; jsonl: string; lineCount: number } | { ok: false; message: string }> {
  const batch = await prisma.toolRewriteBatch.findUnique({ where: { id: batchId } });
  if (!batch) return { ok: false, message: "批次不存在" };

  const items = await loadBatchWebsites(batchId);
  if (!items.length) return { ok: false, message: "批次没有条目" };

  const lines: string[] = [];
  for (const item of items) {
    const prompt = buildBatchRewritePrompt(
      item.website.title,
      rawForWebsite(item.website)
    );
    if (item.prompt !== prompt) {
      await prisma.toolRewriteItem.update({
        where: { id: item.id },
        data: { prompt },
      });
    }
    // openai 走 /v1/responses + strict json_schema；
    // 其余 OpenAI 兼容 provider 走 /v1/chat/completions + json_object
    const requestLine =
      getProviderMode(batch.provider) === "batch"
        ? {
            custom_id: item.custom_id,
            method: "POST",
            url: "/v1/responses",
            body: {
              model: batch.model,
              input: prompt,
              text: {
                format: {
                  type: "json_schema",
                  name: "tool_rewrite_draft",
                  schema: REWRITE_DRAFT_JSON_SCHEMA,
                  strict: true,
                },
              },
            },
          }
        : {
            custom_id: item.custom_id,
            method: "POST",
            url: "/v1/chat/completions",
            body: {
              model: batch.model,
              messages: [{ role: "user", content: prompt }],
              response_format: { type: "json_object" },
            },
          };
    lines.push(JSON.stringify(requestLine));
  }

  if (batch.status === "created") {
    await prisma.toolRewriteBatch.update({
      where: { id: batchId },
      data: { status: "jsonl_generated" },
    });
  }

  return { ok: true, jsonl: lines.join("\n"), lineCount: lines.length };
}

// ---------------------------------------------------------------------------
// Provider HTTP 层（原生 fetch；key 仅服务端，不入日志）
// ---------------------------------------------------------------------------

type ProviderHttpRuntime = { baseUrl: string; apiKey: string };

async function providerFetch(
  runtime: ProviderHttpRuntime,
  pathName: string,
  init?: RequestInit
) {
  const response = await fetch(`${runtime.baseUrl}${pathName}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${runtime.apiKey}`,
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, ok: response.ok, body, text };
}

function apiErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { message?: string } }).error;
    if (error?.message) return error.message.slice(0, 300);
  }
  return fallback;
}

export type SubmitResult =
  | { ok: true; mode: "batch"; openaiBatchId: string }
  | { ok: true; mode: "direct"; saved: number; qcFailed: number; failed: number }
  | { ok: false; message: string };

export async function submitRewriteBatch(batchId: number): Promise<SubmitResult> {
  const batch = await prisma.toolRewriteBatch.findUnique({ where: { id: batchId } });
  if (!batch) return { ok: false, message: "批次不存在" };
  if (!isRewriteProvider(batch.provider)) {
    return { ok: false, message: `未知 provider: ${batch.provider}` };
  }
  const provider = batch.provider;
  const runtime = await resolveProviderRuntime(provider, batch.model);
  if (!runtime.ok) {
    return { ok: false, message: runtime.message };
  }
  if (!runtime.enabled) {
    return { ok: false, message: `${provider} 已在配置中心禁用，无法提交真实任务` };
  }
  if (batch.openai_batch_id) {
    return { ok: false, message: `批次已提交过 (${batch.openai_batch_id})` };
  }
  if (batch.status === "imported") {
    return { ok: false, message: "批次已完成，请新建批次" };
  }

  // 直连模式：同步逐条改写并完成 QC 入库
  if (getProviderMode(provider) === "direct") {
    return runDirectRewrite(batchId, runtime, batch.model);
  }

  // OpenAI Batch API 模式
  const jsonl = await buildOpenAIBatchJsonl(batchId);
  if (!jsonl.ok) return jsonl;

  // 1) 上传 JSONL 文件
  const form = new FormData();
  form.append("purpose", "batch");
  form.append(
    "file",
    new Blob([jsonl.jsonl], { type: "application/jsonl" }),
    `tool-rewrite-batch-${batchId}.jsonl`
  );
  const upload = await providerFetch(runtime, "/files", {
    method: "POST",
    body: form,
  });
  if (!upload.ok) {
    return { ok: false, message: `上传 JSONL 失败: ${apiErrorMessage(upload.body, `HTTP ${upload.status}`)}` };
  }
  const inputFileId = (upload.body as { id?: string }).id;
  if (!inputFileId) return { ok: false, message: "上传 JSONL 未返回 file id" };

  // 2) 创建 batch
  const created = await providerFetch(runtime, "/batches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input_file_id: inputFileId,
      endpoint: "/v1/responses",
      completion_window: "24h",
      metadata: { source: "askwalle-tool-rewrite", batch_id: String(batchId) },
    }),
  });
  if (!created.ok) {
    return { ok: false, message: `创建 OpenAI batch 失败: ${apiErrorMessage(created.body, `HTTP ${created.status}`)}` };
  }
  const openaiBatch = created.body as { id?: string; status?: string };
  if (!openaiBatch.id) return { ok: false, message: "OpenAI 未返回 batch id" };

  await prisma.toolRewriteBatch.update({
    where: { id: batchId },
    data: {
      status: "submitted",
      openai_batch_id: openaiBatch.id,
      input_file_id: inputFileId,
      submitted_at: new Date(),
      submitted_count: jsonl.lineCount,
    },
  });
  await prisma.toolRewriteItem.updateMany({
    where: { batch_id: batchId, status: "queued" },
    data: { status: "submitted", attempt_count: { increment: 1 } },
  });

  return { ok: true, mode: "batch", openaiBatchId: openaiBatch.id };
}

// 直连模式执行：逐条 chat/completions → QC → 入库（单条失败不影响其它条目）
async function runDirectRewrite(
  batchId: number,
  runtime: ProviderHttpRuntime,
  model: string
): Promise<SubmitResult> {
  const items = await loadBatchWebsites(batchId);
  const pendingItems = items.filter((item) =>
    ["queued", "failed", "qc_failed"].includes(item.status)
  );
  if (!pendingItems.length) {
    return { ok: false, message: "批次没有待处理条目" };
  }

  await prisma.toolRewriteBatch.update({
    where: { id: batchId },
    data: { status: "in_progress", submitted_at: new Date(), submitted_count: pendingItems.length },
  });

  let saved = 0;
  let qcFailed = 0;
  let failed = 0;

  for (const item of pendingItems) {
    // 始终用当前模板重建 prompt（旧存量 prompt 可能缺少 response_format 所需的
    // "json" 字样），并回写 item.prompt 作审计
    const prompt = buildBatchRewritePrompt(
      item.website.title,
      rawForWebsite(item.website)
    );
    if (item.prompt !== prompt) {
      await prisma.toolRewriteItem.update({
        where: { id: item.id },
        data: { prompt },
      });
    }

    let outcome: "saved" | "qc_failed" | "failed";
    try {
      const response = await providerFetch(runtime, "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
        }),
      });
      if (!response.ok) {
        outcome = "failed";
        await prisma.toolRewriteItem.update({
          where: { id: item.id },
          data: {
            status: "failed",
            attempt_count: { increment: 1 },
            error_message: apiErrorMessage(response.body, `HTTP ${response.status}`),
          },
        });
      } else {
        const content = extractChatContent(response.body);
        let draftJson: unknown = null;
        if (content) {
          try {
            draftJson = JSON.parse(
              content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
            );
          } catch {
            draftJson = null;
          }
        }
        outcome = await applyDraftOutcome(item, draftJson, content);
      }
    } catch (error) {
      outcome = "failed";
      await prisma.toolRewriteItem.update({
        where: { id: item.id },
        data: {
          status: "failed",
          attempt_count: { increment: 1 },
          error_message:
            error instanceof Error ? error.message.slice(0, 300) : "请求失败",
        },
      });
    }

    if (outcome === "saved") saved++;
    else if (outcome === "qc_failed") qcFailed++;
    else failed++;
  }

  await prisma.toolRewriteBatch.update({
    where: { id: batchId },
    data: {
      status: "imported",
      completed_at: new Date(),
      completed_count: saved + qcFailed,
      qc_passed_count: saved,
      qc_failed_count: qcFailed,
      failed_count: failed,
    },
  });

  return { ok: true, mode: "direct", saved, qcFailed, failed };
}

function extractChatContent(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  return typeof message?.content === "string" ? message.content : null;
}

export async function refreshOpenAIBatchStatus(
  batchId: number
): Promise<{ ok: true; status: string } | { ok: false; message: string }> {
  const batch = await prisma.toolRewriteBatch.findUnique({ where: { id: batchId } });
  if (!batch) return { ok: false, message: "批次不存在" };
  if (!isRewriteProvider(batch.provider)) {
    return { ok: false, message: `未知 provider: ${batch.provider}` };
  }
  if (getProviderMode(batch.provider) === "direct") {
    return { ok: false, message: "直连模式在 Submit 时即同步完成，无需刷新状态" };
  }
  const runtime = await resolveProviderRuntime(batch.provider);
  if (!runtime.ok) return { ok: false, message: runtime.message };
  if (!batch.openai_batch_id) return { ok: false, message: "批次尚未提交到 OpenAI" };

  const result = await providerFetch(
    runtime,
    `/batches/${batch.openai_batch_id}`
  );
  if (!result.ok) {
    return { ok: false, message: `查询状态失败: ${apiErrorMessage(result.body, `HTTP ${result.status}`)}` };
  }
  const remote = result.body as {
    status?: string;
    output_file_id?: string | null;
    error_file_id?: string | null;
    request_counts?: { total?: number; completed?: number; failed?: number };
  };
  const remoteStatus = remote.status ?? "unknown";
  const mapped =
    remoteStatus === "completed"
      ? "completed"
      : ["failed", "expired", "cancelled", "cancelling"].includes(remoteStatus)
      ? "failed"
      : ["validating", "in_progress", "finalizing"].includes(remoteStatus)
      ? "in_progress"
      : batch.status;

  await prisma.toolRewriteBatch.update({
    where: { id: batchId },
    data: {
      status: batch.status === "imported" ? batch.status : mapped,
      output_file_id: remote.output_file_id ?? batch.output_file_id,
      error_file_id: remote.error_file_id ?? batch.error_file_id,
      completed_count: remote.request_counts?.completed ?? batch.completed_count,
      failed_count: remote.request_counts?.failed ?? batch.failed_count,
      ...(remoteStatus === "completed" && !batch.completed_at
        ? { completed_at: new Date() }
        : {}),
    },
  });

  return { ok: true, status: remoteStatus };
}

// ---------------------------------------------------------------------------
// QC 校验
// ---------------------------------------------------------------------------

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 40);
}

export function validateRewriteDraft(
  draft: unknown,
  raw: RawImportedContent & { description: string }
): { ok: true; draft: BatchRewriteDraft } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return { ok: false, errors: ["输出不是 JSON 对象"] };
  }
  const record = draft as Record<string, unknown>;
  const str = (key: string) =>
    typeof record[key] === "string" ? (record[key] as string).trim() : "";
  const strArray = (key: string) =>
    Array.isArray(record[key])
      ? (record[key] as unknown[])
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter(Boolean)
      : [];

  const description = str("description");
  const what = str("what");
  const how = str("how");
  const features = strArray("features");
  const useCases = strArray("useCases");
  const faqs = Array.isArray(record.faqs)
    ? (record.faqs as unknown[])
        .filter(
          (v): v is Record<string, unknown> =>
            Boolean(v) && typeof v === "object" && !Array.isArray(v)
        )
        .map((v) => ({
          question: typeof v.question === "string" ? v.question.trim() : "",
          answer: typeof v.answer === "string" ? v.answer.trim() : "",
        }))
    : [];

  if (!description) errors.push("description 为空");
  if (!what) errors.push("what 为空");
  if (!how) errors.push("how 为空");
  if (features.length < 3) errors.push("features 少于 3 条");
  if (useCases.length < 2) errors.push("useCases 少于 2 条");
  if (faqs.length < 2) errors.push("faqs 少于 2 条");
  if (faqs.some((faq) => !faq.question)) errors.push("存在空的 faq.question");
  if (faqs.some((faq) => !faq.answer)) errors.push("存在空的 faq.answer");

  const allText = [
    description,
    what,
    how,
    ...features,
    ...useCases,
    ...faqs.flatMap((faq) => [faq.question, faq.answer]),
  ].join("\n");

  if (allText.includes("<")) errors.push("包含 HTML 标签");
  if (allText.includes("```")) errors.push("包含 Markdown 代码块");
  if (/toolify/i.test(allText)) errors.push("包含 Toolify 字样");

  // 不允许复制原文完整句子（>=40 字符的句子逐一比对）
  const rawSentences = [
    ...splitSentences(raw.description),
    ...splitSentences(raw.what),
    ...splitSentences(raw.how),
  ];
  for (const sentence of rawSentences) {
    if (allText.includes(sentence)) {
      errors.push(`复制了原文句子: "${sentence.slice(0, 50)}…"`);
      break;
    }
  }

  // 编造检测启发式：原文没有具体价格时，草稿不应出现 $ 金额
  const rawText = `${raw.description}\n${raw.what}\n${raw.how}\n${raw.featuresText}`;
  if (/\$\s?\d/.test(allText) && !/\$\s?\d/.test(rawText)) {
    errors.push("疑似编造价格（原文无 $ 金额）");
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    draft: { description, what, how, features, useCases, faqs },
  };
}

// ---------------------------------------------------------------------------
// 结果导入
// ---------------------------------------------------------------------------

function extractOutputText(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const output = (body as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;
  for (const entry of output) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { type?: string; content?: unknown };
    if (record.type !== "message" || !Array.isArray(record.content)) continue;
    for (const part of record.content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: string }).type === "output_text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
    }
  }
  return null;
}

export async function importOpenAIBatchResults(
  batchId: number
): Promise<
  | { ok: true; saved: number; qcFailed: number; failed: number }
  | { ok: false; message: string }
> {
  const batch = await prisma.toolRewriteBatch.findUnique({ where: { id: batchId } });
  if (!batch) return { ok: false, message: "批次不存在" };
  if (!isRewriteProvider(batch.provider)) {
    return { ok: false, message: `未知 provider: ${batch.provider}` };
  }
  if (getProviderMode(batch.provider) === "direct") {
    return { ok: false, message: "直连模式在 Submit 时即同步完成，无需导入结果" };
  }
  const runtime = await resolveProviderRuntime(batch.provider);
  if (!runtime.ok) return { ok: false, message: runtime.message };
  if (!batch.output_file_id) {
    return { ok: false, message: "尚无 output 文件，请先 Refresh status 并等待 batch 完成" };
  }

  const download = await providerFetch(
    runtime,
    `/files/${batch.output_file_id}/content`
  );
  if (!download.ok) {
    return { ok: false, message: `下载结果失败: ${apiErrorMessage(download.body, `HTTP ${download.status}`)}` };
  }

  const items = await loadBatchWebsites(batchId);
  const itemByCustomId = new Map(items.map((item) => [item.custom_id, item]));

  let saved = 0;
  let qcFailed = 0;
  let failed = 0;

  for (const line of download.text.split("\n")) {
    if (!line.trim()) continue;
    let parsedLine: {
      custom_id?: string;
      response?: { status_code?: number; body?: unknown };
      error?: { message?: string } | null;
    };
    try {
      parsedLine = JSON.parse(line);
    } catch {
      continue;
    }
    const item = parsedLine.custom_id
      ? itemByCustomId.get(parsedLine.custom_id)
      : undefined;
    if (!item) continue;

    // OpenAI 层错误
    if (parsedLine.error || (parsedLine.response?.status_code ?? 200) >= 400) {
      failed++;
      await prisma.toolRewriteItem.update({
        where: { id: item.id },
        data: {
          status: "failed",
          error_message:
            parsedLine.error?.message?.slice(0, 500) ??
            `HTTP ${parsedLine.response?.status_code}`,
        },
      });
      continue;
    }

    const outputText = extractOutputText(parsedLine.response?.body);
    let draftJson: unknown = null;
    if (outputText) {
      try {
        draftJson = JSON.parse(outputText);
      } catch {
        draftJson = null;
      }
    }

    const outcome = await applyDraftOutcome(item, draftJson, outputText);
    if (outcome === "saved") saved++;
    else if (outcome === "qc_failed") qcFailed++;
    else failed++;
  }

  await prisma.toolRewriteBatch.update({
    where: { id: batchId },
    data: {
      status: "imported",
      qc_passed_count: saved,
      qc_failed_count: qcFailed,
      failed_count: failed,
    },
  });

  return { ok: true, saved, qcFailed, failed };
}

// 共享的单条结果处理：QC → 入库/标记（batch 导入与直连模式共用）
type LoadedRewriteItem = Awaited<ReturnType<typeof loadBatchWebsites>>[number];

async function applyDraftOutcome(
  item: LoadedRewriteItem,
  draftJson: unknown,
  rawOutputText: string | null
): Promise<"saved" | "qc_failed" | "failed"> {
  const raw = rawForWebsite(item.website);
  const validation = draftJson
    ? validateRewriteDraft(draftJson, raw)
    : ({ ok: false, errors: ["无法从响应中提取 JSON 输出"] } as const);

  if (!validation.ok) {
    await prisma.toolRewriteItem.update({
      where: { id: item.id },
      data: {
        status: "qc_failed",
        qc_status: "failed",
        qc_errors: validation.errors as unknown as Prisma.InputJsonValue,
        raw_output: (draftJson ?? rawOutputText ?? null) as Prisma.InputJsonValue,
        attempt_count: { increment: 1 },
      },
    });
    return "qc_failed";
  }

  // 不覆盖 human_reviewed 工具
  if (item.website.toolDetail?.rewrite_status === RewriteStatus.human_reviewed) {
    await prisma.toolRewriteItem.update({
      where: { id: item.id },
      data: {
        status: "failed",
        error_message: "工具已 human_reviewed，跳过写入",
        attempt_count: { increment: 1 },
      },
    });
    return "failed";
  }

  await saveRewriteDraftToToolDetail(item.website_id, validation.draft);
  await prisma.toolRewriteItem.update({
    where: { id: item.id },
    data: {
      status: "saved",
      qc_status: "passed",
      qc_errors: Prisma.DbNull,
      raw_output: draftJson as Prisma.InputJsonValue,
      parsed_draft: validation.draft as unknown as Prisma.InputJsonValue,
      error_message: null,
      attempt_count: { increment: 1 },
    },
  });
  return "saved";
}

// QC 通过后写入 ToolDetail：只写草稿，状态 draft_generated；绝不 human_reviewed / approved
export async function saveRewriteDraftToToolDetail(
  websiteId: number,
  draft: BatchRewriteDraft
): Promise<void> {
  await prisma.toolDetail.update({
    where: { website_id: websiteId },
    data: {
      ai_rewrite_draft: draft as unknown as Prisma.InputJsonValue,
      rewrite_status: RewriteStatus.draft_generated,
      reviewed_at: null,
    },
  });
}
