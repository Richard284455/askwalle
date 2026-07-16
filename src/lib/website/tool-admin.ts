import { Prisma, ToolLinkKind, ToolTagKind } from "@prisma/client";
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
