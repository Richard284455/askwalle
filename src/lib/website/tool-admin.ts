import {
  Prisma,
  RewriteStatus,
  ToolLinkKind,
  ToolTagKind,
} from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// 序列化类型（传给客户端组件）
// ---------------------------------------------------------------------------

export type AdminToolListItem = {
  id: number;
  title: string;
  slug: string | null;
  url: string;
  description: string;
  status: string;
  categoryId: number;
  categoryName: string;
  parentCategoryName: string | null;
  hasDetail: boolean;
  listedAt: string | null;
  updatedAt: string;
};

export type AdminToolFaq = {
  question: string;
  answer: string;
};

// AI 改写草稿的结构（管理员粘贴的 AI 输出）
export type RewriteDraft = {
  what: string;
  how: string;
  features: string[];
  useCases: string[];
  faqs: { question: string; answer: string }[];
};

// 原始导入底稿快照（仅内部展示，不公开）
export type RawImportedContent = {
  what: string;
  how: string;
  featuresText: string;
  useCases: string[];
  faqs: { question: string; answer: string | null }[];
};

export type AdminToolRewrite = {
  status: RewriteStatus | null;
  reviewedAt: string | null;
  reviewNotes: string;
  draft: string; // pretty JSON 或空串
  raw: RawImportedContent;
  prompt: string;
};

export type AdminToolRecord = {
  id: number;
  title: string;
  slug: string;
  url: string;
  description: string;
  categoryId: number;
  status: string;
  detail: {
    what: string;
    how: string;
    featuresText: string;
    features: string;
    useCases: string;
    rating: number | null;
    reviewCount: number;
    savedCount: number;
    monthlyVisitors: number | null;
    listedAt: string;
    source: string;
    externalRaw: string;
  };
  tags: {
    platform: string;
    pricing: string;
    topic: string;
  };
  links: string;
  media: string;
  faqs: AdminToolFaq[];
  rewrite: AdminToolRewrite;
};

export type AdminCategoryOption = {
  id: number;
  label: string;
};

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_STATUSES = ["pending", "approved", "rejected", "archived"] as const;

const csvToNames = (value: string) =>
  value
    .split(/[,，]/)
    .map((name) => name.trim())
    .filter(Boolean);

const toolUpdateSchema = z.object({
  title: z.string().min(1, "标题不能为空"),
  slug: z
    .string()
    .min(1, "slug 不能为空")
    .regex(slugPattern, "slug 只能包含小写字母、数字和连字符"),
  url: z.string().url("官网 URL 格式无效"),
  description: z.string().min(1, "描述不能为空"),
  categoryId: z.number().int().positive("分类无效"),
  status: z.enum(TOOL_STATUSES),
  detail: z.object({
    what: z.string(),
    how: z.string(),
    featuresText: z.string(),
    features: z.string(),
    useCases: z.string(),
    rating: z.number().min(0).max(5).nullable(),
    reviewCount: z.number().int().min(0),
    savedCount: z.number().int().min(0),
    monthlyVisitors: z.number().int().min(0).nullable(),
    listedAt: z.string(),
    source: z.string(),
    externalRaw: z.string(),
  }),
  tags: z.object({
    platform: z.string(),
    pricing: z.string(),
    topic: z.string(),
  }),
  links: z.string(),
  media: z.string(),
  faqs: z.array(
    z.object({
      question: z.string().min(1, "FAQ 问题不能为空"),
      answer: z.string(),
    })
  ),
});

export type ToolUpdateInput = z.infer<typeof toolUpdateSchema>;

type ParsedLink = { kind: ToolLinkKind; url: string; label: string | null };
type ParsedMedia = { url: string; alt: string | null };

export type ParsedToolUpdate = {
  website: {
    title: string;
    slug: string;
    url: string;
    description: string;
    category_id: number;
    status: string;
  };
  detail: Omit<Prisma.ToolDetailUncheckedCreateInput, "website_id">;
  tags: { kind: ToolTagKind; name: string }[];
  links: ParsedLink[];
  media: ParsedMedia[];
  faqs: AdminToolFaq[];
};

export type ParseToolResult =
  | { ok: true; data: ParsedToolUpdate }
  | { ok: false; message: string };

const LINK_KINDS = new Set<string>(Object.values(ToolLinkKind));
const EMAIL_PATTERN = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;

function parseJson(raw: string, field: string):
  | { ok: true; value: unknown }
  | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, message: `${field} 不是合法的 JSON` };
  }
}

function parseStringArrayJson(
  raw: string,
  field: string
):
  | { ok: true; value: string[] | null }
  | { ok: false; message: string } {
  if (!raw.trim()) return { ok: true, value: null };
  const parsed = parseJson(raw, field);
  if (!parsed.ok) return parsed;
  if (
    !Array.isArray(parsed.value) ||
    !parsed.value.every((item) => typeof item === "string")
  ) {
    return { ok: false, message: `${field} 必须是字符串数组` };
  }
  return { ok: true, value: parsed.value as string[] };
}

function parseLinksJson(raw: string):
  | { ok: true; value: ParsedLink[] }
  | { ok: false; message: string } {
  if (!raw.trim()) return { ok: true, value: [] };
  const parsed = parseJson(raw, "links");
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value)) {
    return { ok: false, message: "links 必须是 JSON 数组" };
  }
  const links: ParsedLink[] = [];
  for (const item of parsed.value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, message: "links 的每一项必须是对象" };
    }
    const record = item as Record<string, unknown>;
    const kind = String(record.kind ?? "");
    const url = String(record.url ?? "").trim();
    const label =
      typeof record.label === "string" && record.label.trim()
        ? record.label.trim()
        : null;
    if (!LINK_KINDS.has(kind)) {
      return {
        ok: false,
        message: `links.kind "${kind}" 无效，可用: ${[...LINK_KINDS].join(", ")}`,
      };
    }
    if (kind === ToolLinkKind.email) {
      if (!EMAIL_PATTERN.test(url)) {
        return { ok: false, message: `links 中 email 类型的 url 必须是邮箱地址` };
      }
    } else if (!/^https?:\/\//.test(url)) {
      return { ok: false, message: `links.url 必须以 http(s):// 开头` };
    }
    links.push({ kind: kind as ToolLinkKind, url, label });
  }
  return { ok: true, value: links };
}

function parseMediaJson(raw: string):
  | { ok: true; value: ParsedMedia[] }
  | { ok: false; message: string } {
  if (!raw.trim()) return { ok: true, value: [] };
  const parsed = parseJson(raw, "media");
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value)) {
    return { ok: false, message: "media 必须是 JSON 数组" };
  }
  const media: ParsedMedia[] = [];
  for (const item of parsed.value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, message: "media 的每一项必须是对象" };
    }
    const record = item as Record<string, unknown>;
    const url = String(record.url ?? "").trim();
    const alt =
      typeof record.alt === "string" && record.alt.trim()
        ? record.alt.trim()
        : null;
    // 禁止原始 HTML 入库
    if (url.includes("<") || (alt && alt.includes("<"))) {
      return { ok: false, message: "media 不允许包含 HTML 标签" };
    }
    if (!/^https?:\/\//.test(url) && !url.startsWith("/")) {
      return {
        ok: false,
        message: "media.url 必须是 http(s) URL 或以 / 开头的本地路径",
      };
    }
    media.push({ url, alt });
  }
  return { ok: true, value: media };
}

export function parseToolUpdatePayload(body: unknown): ParseToolResult {
  const parsed = toolUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "参数校验失败",
    };
  }
  const input = parsed.data;

  const features = parseStringArrayJson(input.detail.features, "features");
  if (!features.ok) return features;
  const useCases = parseStringArrayJson(input.detail.useCases, "use_cases");
  if (!useCases.ok) return useCases;
  const links = parseLinksJson(input.links);
  if (!links.ok) return links;
  const media = parseMediaJson(input.media);
  if (!media.ok) return media;

  let listedAt: Date | null = null;
  if (input.detail.listedAt.trim()) {
    const date = new Date(input.detail.listedAt);
    if (Number.isNaN(date.getTime())) {
      return { ok: false, message: "listed_at 不是有效的日期" };
    }
    listedAt = date;
  }

  const tags: { kind: ToolTagKind; name: string }[] = [];
  const seenTags = new Set<string>();
  const pushTags = (kind: ToolTagKind, csv: string) => {
    for (const name of csvToNames(csv)) {
      const key = `${kind}:${name}`;
      if (!seenTags.has(key)) {
        seenTags.add(key);
        tags.push({ kind, name });
      }
    }
  };
  pushTags(ToolTagKind.platform, input.tags.platform);
  pushTags(ToolTagKind.pricing, input.tags.pricing);
  pushTags(ToolTagKind.topic, input.tags.topic);

  return {
    ok: true,
    data: {
      website: {
        title: input.title.trim(),
        slug: input.slug,
        url: input.url.trim(),
        description: input.description.trim(),
        category_id: input.categoryId,
        status: input.status,
      },
      detail: {
        what: input.detail.what.trim() || null,
        how: input.detail.how.trim() || null,
        features_text: input.detail.featuresText.trim() || null,
        features: features.value
          ? (features.value as Prisma.InputJsonValue)
          : Prisma.DbNull,
        use_cases: useCases.value
          ? (useCases.value as Prisma.InputJsonValue)
          : Prisma.DbNull,
        rating: input.detail.rating,
        review_count: input.detail.reviewCount,
        saved_count: input.detail.savedCount,
        monthly_visitors: input.detail.monthlyVisitors,
        listed_at: listedAt,
        source: input.detail.source.trim() || null,
        external_raw: input.detail.externalRaw.trim() || null,
      },
      tags,
      links: links.value,
      media: media.value,
      faqs: input.faqs.map((faq) => ({
        question: faq.question.trim(),
        answer: faq.answer.trim(),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// AI 改写 / 人工审核
// ---------------------------------------------------------------------------

function jsonStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

type DetailForRaw = {
  what: string | null;
  how: string | null;
  features_text: string | null;
  use_cases: Prisma.JsonValue | null;
} | null;

type FaqForRaw = { question: string; answer: string | null }[];

// 从当前 ToolDetail/ToolFAQ 派生原始底稿快照（用于首次快照与老数据回退展示）
export function buildRawSnapshot(
  detail: DetailForRaw,
  faqs: FaqForRaw
): RawImportedContent {
  return {
    what: detail?.what ?? "",
    how: detail?.how ?? "",
    featuresText: detail?.features_text ?? "",
    useCases: jsonStringArray(detail?.use_cases),
    faqs: faqs.map((faq) => ({ question: faq.question, answer: faq.answer })),
  };
}

function rawFromStored(
  value: Prisma.JsonValue | null | undefined
): RawImportedContent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    what: typeof record.what === "string" ? record.what : "",
    how: typeof record.how === "string" ? record.how : "",
    featuresText:
      typeof record.featuresText === "string" ? record.featuresText : "",
    useCases: Array.isArray(record.useCases)
      ? record.useCases.filter((v): v is string => typeof v === "string")
      : [],
    faqs: Array.isArray(record.faqs)
      ? record.faqs
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
  };
}

// 生成可复制给外部 AI（ChatGPT/Claude/Gemini）的改写 prompt；V1 不接任何 AI API
export function buildRewritePrompt(
  toolTitle: string,
  raw: RawImportedContent
): string {
  const rawJson = JSON.stringify(
    {
      what: raw.what,
      how: raw.how,
      featuresText: raw.featuresText,
      useCases: raw.useCases,
      faqQuestions: raw.faqs.map((faq) => faq.question),
    },
    null,
    2
  );

  return `You are helping rewrite third-party reference notes about an AI tool called "${toolTitle}" into original directory content for a US-focused AI tools directory.

Requirements:
- Do NOT copy sentences or distinctive phrasing from the reference notes. Write original wording.
- Keep all facts accurate. Do NOT invent capabilities, pricing, or integrations that are not implied by the notes.
- Professional, concise, trustworthy tone for US business users. No hype, no superlatives.
- Every FAQ must include a helpful answer. If the notes cannot support an answer, write a cautious general answer that tells the user to verify on the official site.
- "features" and "useCases" must be arrays of short original strings (max ~15 words each).
- Output STRICT JSON only, no markdown fences, exactly this shape:

{
  "what": "2-4 sentence original description of what the tool is and who it is for",
  "how": "2-4 sentence original description of how a new user gets started",
  "features": ["...", "..."],
  "useCases": ["...", "..."],
  "faqs": [{ "question": "...", "answer": "..." }]
}

Reference notes (do not copy wording):
${rawJson}`;
}

const rewriteDraftSchema = z.object({
  what: z.string().min(1, "draft.what 不能为空"),
  how: z.string().min(1, "draft.how 不能为空"),
  features: z.array(z.string().min(1)).min(1, "draft.features 至少一项"),
  useCases: z.array(z.string().min(1)).min(1, "draft.useCases 至少一项"),
  faqs: z.array(
    z.object({
      question: z.string().min(1, "draft.faqs.question 不能为空"),
      answer: z.string().min(1, "draft.faqs.answer 不能为空"),
    })
  ),
});

export type ParseDraftResult =
  | { ok: true; draft: RewriteDraft }
  | { ok: false; message: string };

export const DRAFT_NOT_OBJECT_MESSAGE =
  "请只粘贴 JSON 对象，不要包含说明文字或 Markdown 代码块。";
export const DRAFT_PARSE_FAILED_MESSAGE =
  "JSON 解析失败。可能原因：多余逗号、中文引号、字段名未加双引号、字符串中有未转义换行。";

// 清理常见 AI 输出包装：```json / ``` 围栏与首尾空白。
// 只做确定性的围栏剥离，不猜测解释文字的位置。
export function cleanDraftInput(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("```")) {
    // 去掉第一行的 ``` 或 ```json
    const firstLineBreak = text.indexOf("\n");
    text = firstLineBreak >= 0 ? text.slice(firstLineBreak + 1) : "";
  }
  if (text.trimEnd().endsWith("```")) {
    text = text.trimEnd();
    text = text.slice(0, text.length - 3);
  }
  return text.trim();
}

export function parseRewriteDraft(rawJson: string): ParseDraftResult {
  const cleaned = cleanDraftInput(rawJson);

  // 前后有解释文字（或根本不是对象）时给明确指引，不做静默猜测
  if (!cleaned.startsWith("{") || !cleaned.endsWith("}")) {
    return { ok: false, message: DRAFT_NOT_OBJECT_MESSAGE };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, message: DRAFT_PARSE_FAILED_MESSAGE };
  }
  const result = rewriteDraftSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      message: result.error.issues[0]?.message ?? "draft 结构校验失败",
    };
  }
  // 禁止 HTML
  const values = [
    result.data.what,
    result.data.how,
    ...result.data.features,
    ...result.data.useCases,
    ...result.data.faqs.flatMap((faq) => [faq.question, faq.answer]),
  ];
  if (values.some((value) => value.includes("<"))) {
    return { ok: false, message: "draft 不允许包含 HTML 标签" };
  }
  return { ok: true, draft: result.data };
}

// 首次进入改写流程时把当前内容固化为 raw 快照（只写一次，不覆盖）
async function ensureRawSnapshot(websiteId: number): Promise<void> {
  const detail = await prisma.toolDetail.findUnique({
    where: { website_id: websiteId },
    select: {
      raw_imported_content: true,
      what: true,
      how: true,
      features_text: true,
      use_cases: true,
    },
  });
  if (!detail || rawFromStored(detail.raw_imported_content)) return;

  const faqs = await prisma.toolFAQ.findMany({
    where: { website_id: websiteId },
    orderBy: { position: "asc" },
    select: { question: true, answer: true },
  });
  await prisma.toolDetail.update({
    where: { website_id: websiteId },
    data: {
      raw_imported_content: buildRawSnapshot(
        detail,
        faqs
      ) as unknown as Prisma.InputJsonValue,
      rewrite_status: detail.raw_imported_content
        ? undefined
        : RewriteStatus.raw_imported,
    },
  });
}

// 保存 AI 改写草稿 → draft_generated（重新保存草稿会要求重新审核）
export async function saveRewriteDraft(
  websiteId: number,
  draft: RewriteDraft
): Promise<void> {
  await ensureRawSnapshot(websiteId);
  await prisma.toolDetail.update({
    where: { website_id: websiteId },
    data: {
      ai_rewrite_draft: draft as unknown as Prisma.InputJsonValue,
      rewrite_status: RewriteStatus.draft_generated,
      reviewed_at: null,
    },
  });
}

// 把草稿应用到公开详情字段（覆盖 ToolDetail 四字段 + 整体替换 ToolFAQ）
export async function applyRewriteDraft(
  websiteId: number
): Promise<{ ok: true } | { ok: false; message: string }> {
  const detail = await prisma.toolDetail.findUnique({
    where: { website_id: websiteId },
    select: { ai_rewrite_draft: true },
  });
  if (!detail?.ai_rewrite_draft) {
    return { ok: false, message: "尚未保存 AI 改写草稿" };
  }
  const parsed = parseRewriteDraft(JSON.stringify(detail.ai_rewrite_draft));
  if (!parsed.ok) {
    return { ok: false, message: `草稿数据无效: ${parsed.message}` };
  }

  await ensureRawSnapshot(websiteId);
  await prisma.toolDetail.update({
    where: { website_id: websiteId },
    data: {
      what: parsed.draft.what,
      how: parsed.draft.how,
      features: parsed.draft.features as Prisma.InputJsonValue,
      use_cases: parsed.draft.useCases as Prisma.InputJsonValue,
    },
  });
  await prisma.toolFAQ.deleteMany({ where: { website_id: websiteId } });
  if (parsed.draft.faqs.length) {
    await prisma.toolFAQ.createMany({
      data: parsed.draft.faqs.map((faq, position) => ({
        website_id: websiteId,
        question: faq.question,
        answer: faq.answer,
        position,
      })),
    });
  }
  return { ok: true };
}

// 标记人工已审核
export async function markToolReviewed(
  websiteId: number,
  reviewNotes: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const detail = await prisma.toolDetail.findUnique({
    where: { website_id: websiteId },
    select: { id: true },
  });
  if (!detail) {
    return { ok: false, message: "该工具没有 ToolDetail，无需审核流程" };
  }
  await prisma.toolDetail.update({
    where: { website_id: websiteId },
    data: {
      rewrite_status: RewriteStatus.human_reviewed,
      reviewed_at: new Date(),
      review_notes: reviewNotes.trim() || null,
    },
  });
  return { ok: true };
}

// 发布守卫：有 ToolDetail（含来源内容）的工具必须 human_reviewed 才能 approved；
// 无 ToolDetail 的普通目录提交不受影响
export async function assertPublishAllowed(
  websiteId: number,
  nextStatus: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (nextStatus !== "approved") return { ok: true };
  const detail = await prisma.toolDetail.findUnique({
    where: { website_id: websiteId },
    select: { rewrite_status: true },
  });
  if (detail && detail.rewrite_status !== RewriteStatus.human_reviewed) {
    return {
      ok: false,
      message: "Please complete human review before publishing this tool.",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export async function getAdminTools(): Promise<AdminToolListItem[]> {
  try {
    const websites = await prisma.website.findMany({
      orderBy: { updated_at: "desc" },
      select: {
        id: true,
        title: true,
        slug: true,
        url: true,
        description: true,
        status: true,
        updated_at: true,
        category: {
          select: {
            id: true,
            name: true,
            parent: { select: { name: true } },
          },
        },
        toolDetail: { select: { id: true, listed_at: true } },
      },
    });
    return websites.map((website) => ({
      id: website.id,
      title: website.title,
      slug: website.slug,
      url: website.url,
      description: website.description,
      status: website.status,
      categoryId: website.category.id,
      categoryName: website.category.name,
      parentCategoryName: website.category.parent?.name ?? null,
      hasDetail: Boolean(website.toolDetail),
      listedAt: website.toolDetail?.listed_at?.toISOString() ?? null,
      updatedAt: website.updated_at.toISOString(),
    }));
  } catch (error) {
    console.error("Error fetching admin tools:", error);
    return [];
  }
}

export async function getAdminCategoryOptions(): Promise<AdminCategoryOption[]> {
  try {
    const categories = await prisma.category.findMany({
      orderBy: [{ parent_id: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        parent: { select: { name: true } },
      },
    });
    return categories.map((category) => ({
      id: category.id,
      label: category.parent
        ? `${category.parent.name} / ${category.name}`
        : category.name,
    }));
  } catch (error) {
    console.error("Error fetching admin categories:", error);
    return [];
  }
}

export async function getAdminToolById(
  id: number
): Promise<AdminToolRecord | null> {
  try {
    const website = await prisma.website.findUnique({
      where: { id },
      include: {
        toolDetail: true,
        toolTags: { include: { tag: true } },
        toolLinks: { orderBy: { id: "asc" } },
        toolMedia: { orderBy: { position: "asc" } },
        toolFaqs: { orderBy: { position: "asc" } },
      },
    });
    if (!website) return null;

    const detail = website.toolDetail;
    const tagNames = (kind: ToolTagKind) =>
      website.toolTags
        .filter((entry) => entry.tag.kind === kind)
        .map((entry) => entry.tag.name)
        .join(", ");

    return {
      id: website.id,
      title: website.title,
      slug: website.slug ?? "",
      url: website.url,
      description: website.description,
      categoryId: website.category_id,
      status: website.status,
      detail: {
        what: detail?.what ?? "",
        how: detail?.how ?? "",
        featuresText: detail?.features_text ?? "",
        features:
          detail?.features && detail.features !== null
            ? JSON.stringify(detail.features, null, 2)
            : "",
        useCases:
          detail?.use_cases && detail.use_cases !== null
            ? JSON.stringify(detail.use_cases, null, 2)
            : "",
        rating: detail?.rating ?? null,
        reviewCount: detail?.review_count ?? 0,
        savedCount: detail?.saved_count ?? 0,
        monthlyVisitors: detail?.monthly_visitors ?? null,
        listedAt: detail?.listed_at
          ? detail.listed_at.toISOString().slice(0, 10)
          : "",
        source: detail?.source ?? "",
        externalRaw: detail?.external_raw ?? "",
      },
      tags: {
        platform: tagNames(ToolTagKind.platform),
        pricing: tagNames(ToolTagKind.pricing),
        topic: tagNames(ToolTagKind.topic),
      },
      links: website.toolLinks.length
        ? JSON.stringify(
            website.toolLinks.map((link) => ({
              kind: link.kind,
              url: link.url,
              ...(link.label ? { label: link.label } : {}),
            })),
            null,
            2
          )
        : "",
      media: website.toolMedia.length
        ? JSON.stringify(
            website.toolMedia.map((item) => ({
              url: item.url,
              ...(item.alt ? { alt: item.alt } : {}),
            })),
            null,
            2
          )
        : "",
      faqs: website.toolFaqs.map((faq) => ({
        question: faq.question,
        answer: faq.answer ?? "",
      })),
      rewrite: (() => {
        const raw =
          rawFromStored(detail?.raw_imported_content) ??
          buildRawSnapshot(detail, website.toolFaqs);
        return {
          status: detail?.rewrite_status ?? null,
          reviewedAt: detail?.reviewed_at?.toISOString() ?? null,
          reviewNotes: detail?.review_notes ?? "",
          draft: detail?.ai_rewrite_draft
            ? JSON.stringify(detail.ai_rewrite_draft, null, 2)
            : "",
          raw,
          prompt: buildRewritePrompt(website.title, raw),
        };
      })(),
    };
  } catch (error) {
    console.error("Error fetching admin tool:", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

function slugifyTagName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function updateTool(
  id: number,
  data: ParsedToolUpdate
): Promise<void> {
  await prisma.website.update({ where: { id }, data: data.website });

  await prisma.toolDetail.upsert({
    where: { website_id: id },
    update: data.detail,
    create: { website_id: id, ...data.detail },
  });

  // 标签：确保 ToolTag 存在后整体替换关联
  const tagIds: number[] = [];
  for (const tag of data.tags) {
    const slug = `${tag.kind}-${slugifyTagName(tag.name)}`;
    const record = await prisma.toolTag.upsert({
      where: { slug },
      update: {},
      create: { name: tag.name, slug, kind: tag.kind },
    });
    tagIds.push(record.id);
  }
  await prisma.websiteToolTag.deleteMany({ where: { website_id: id } });
  if (tagIds.length) {
    await prisma.websiteToolTag.createMany({
      data: tagIds.map((tagId) => ({ website_id: id, tag_id: tagId })),
      skipDuplicates: true,
    });
  }

  // links / media / faq：编辑语义为整体替换
  await prisma.toolLink.deleteMany({ where: { website_id: id } });
  if (data.links.length) {
    await prisma.toolLink.createMany({
      data: data.links.map((link) => ({
        website_id: id,
        kind: link.kind,
        url: link.url,
        label: link.label,
      })),
      skipDuplicates: true,
    });
  }

  await prisma.toolMedia.deleteMany({ where: { website_id: id } });
  if (data.media.length) {
    await prisma.toolMedia.createMany({
      data: data.media.map((item, position) => ({
        website_id: id,
        kind: "screenshot",
        url: item.url,
        alt: item.alt,
        position,
      })),
    });
  }

  await prisma.toolFAQ.deleteMany({ where: { website_id: id } });
  if (data.faqs.length) {
    await prisma.toolFAQ.createMany({
      data: data.faqs.map((faq, position) => ({
        website_id: id,
        question: faq.question,
        answer: faq.answer || null,
        position,
      })),
    });
  }
}
