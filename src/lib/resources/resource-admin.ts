import {
  Prisma,
  type ResourceContent,
  ResourceSourceType,
  ResourceStatus,
  ResourceType,
} from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/prisma";

// 传给客户端表单/列表的序列化形态；content/sources 以 JSON 字符串编辑
export type AdminResourceRecord = {
  id: number;
  type: ResourceType;
  slug: string;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  publishedAt: string;
  updatedAt: string;
  status: ResourceStatus;
  sourceType: ResourceSourceType;
  content: string;
  sources: string;
  seoTitle: string;
  seoDescription: string;
};

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const resourcePayloadSchema = z.object({
  type: z.nativeEnum(ResourceType),
  slug: z
    .string()
    .min(1, "slug 不能为空")
    .regex(slugPattern, "slug 只能包含小写字母、数字和连字符"),
  title: z.string().min(1, "标题不能为空"),
  summary: z.string().min(1, "摘要不能为空"),
  category: z.string().min(1, "分类不能为空"),
  tags: z.array(z.string()).default([]),
  publishedAt: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), "无效的发布时间"),
  status: z.nativeEnum(ResourceStatus).default(ResourceStatus.draft),
  sourceType: z
    .nativeEnum(ResourceSourceType)
    .default(ResourceSourceType.original),
  content: z.string().min(1, "content 不能为空"),
  sources: z.string().optional(),
  seoTitle: z.string().optional(),
  seoDescription: z.string().optional(),
});

const resourceUpdateSchema = resourcePayloadSchema.partial();

export type ParsedResourceResult =
  | { ok: true; data: Prisma.ResourceContentUncheckedCreateInput }
  | { ok: false; message: string };

export type ParsedResourceUpdateResult =
  | { ok: true; data: Prisma.ResourceContentUncheckedUpdateInput }
  | { ok: false; message: string };

function parseJsonObject(
  raw: string,
  field: string
): { ok: true; value: Prisma.InputJsonValue } | { ok: false; message: string } {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, message: `${field} 必须是 JSON 对象` };
    }
    return { ok: true, value: value as Prisma.InputJsonValue };
  } catch {
    return { ok: false, message: `${field} 不是合法的 JSON` };
  }
}

function parseJsonArray(
  raw: string,
  field: string
): { ok: true; value: Prisma.InputJsonValue } | { ok: false; message: string } {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) {
      return { ok: false, message: `${field} 必须是 JSON 数组` };
    }
    return { ok: true, value: value as Prisma.InputJsonValue };
  } catch {
    return { ok: false, message: `${field} 不是合法的 JSON` };
  }
}

function firstZodMessage(error: z.ZodError) {
  return error.issues[0]?.message ?? "参数校验失败";
}

// 创建载荷：全字段必填校验 + content/sources JSON 校验
export function parseResourceCreatePayload(body: unknown): ParsedResourceResult {
  const parsed = resourcePayloadSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, message: firstZodMessage(parsed.error) };
  }

  const content = parseJsonObject(parsed.data.content, "content");
  if (!content.ok) return content;

  let sources: Prisma.InputJsonValue | undefined;
  if (parsed.data.sources && parsed.data.sources.trim()) {
    const parsedSources = parseJsonArray(parsed.data.sources, "sources");
    if (!parsedSources.ok) return parsedSources;
    sources = parsedSources.value;
  }

  return {
    ok: true,
    data: {
      type: parsed.data.type,
      slug: parsed.data.slug,
      title: parsed.data.title,
      summary: parsed.data.summary,
      category: parsed.data.category,
      tags: parsed.data.tags,
      publishedAt: new Date(parsed.data.publishedAt),
      status: parsed.data.status,
      sourceType: parsed.data.sourceType,
      content: content.value,
      sources: sources ?? Prisma.DbNull,
      seoTitle: parsed.data.seoTitle?.trim() || null,
      seoDescription: parsed.data.seoDescription?.trim() || null,
    },
  };
}

// 更新载荷：字段可选；提供的字段按创建规则校验
export function parseResourceUpdatePayload(
  body: unknown
): ParsedResourceUpdateResult {
  const parsed = resourceUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, message: firstZodMessage(parsed.error) };
  }

  const data: Prisma.ResourceContentUncheckedUpdateInput = {};

  if (parsed.data.type !== undefined) data.type = parsed.data.type;
  if (parsed.data.slug !== undefined) data.slug = parsed.data.slug;
  if (parsed.data.title !== undefined) data.title = parsed.data.title;
  if (parsed.data.summary !== undefined) data.summary = parsed.data.summary;
  if (parsed.data.category !== undefined) data.category = parsed.data.category;
  if (parsed.data.tags !== undefined) data.tags = parsed.data.tags;
  if (parsed.data.publishedAt !== undefined) {
    data.publishedAt = new Date(parsed.data.publishedAt);
  }
  if (parsed.data.status !== undefined) data.status = parsed.data.status;
  if (parsed.data.sourceType !== undefined) {
    data.sourceType = parsed.data.sourceType;
  }
  if (parsed.data.seoTitle !== undefined) {
    data.seoTitle = parsed.data.seoTitle.trim() || null;
  }
  if (parsed.data.seoDescription !== undefined) {
    data.seoDescription = parsed.data.seoDescription.trim() || null;
  }

  if (parsed.data.content !== undefined) {
    const content = parseJsonObject(parsed.data.content, "content");
    if (!content.ok) return content;
    data.content = content.value;
  }

  if (parsed.data.sources !== undefined) {
    if (parsed.data.sources.trim()) {
      const sources = parseJsonArray(parsed.data.sources, "sources");
      if (!sources.ok) return sources;
      data.sources = sources.value;
    } else {
      data.sources = Prisma.DbNull;
    }
  }

  return { ok: true, data };
}

function toAdminRecord(resource: ResourceContent): AdminResourceRecord {
  return {
    id: resource.id,
    type: resource.type,
    slug: resource.slug,
    title: resource.title,
    summary: resource.summary,
    category: resource.category,
    tags: Array.isArray(resource.tags)
      ? resource.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    publishedAt: resource.publishedAt.toISOString(),
    updatedAt: resource.updatedAt.toISOString(),
    status: resource.status,
    sourceType: resource.sourceType,
    content: JSON.stringify(resource.content, null, 2),
    sources:
      resource.sources === null
        ? ""
        : JSON.stringify(resource.sources, null, 2),
    seoTitle: resource.seoTitle ?? "",
    seoDescription: resource.seoDescription ?? "",
  };
}

// 管理端列表：含全部状态
export async function getAdminResources(filters?: {
  type?: ResourceType;
  status?: ResourceStatus;
}): Promise<AdminResourceRecord[]> {
  try {
    const resources = await prisma.resourceContent.findMany({
      where: {
        ...(filters?.type ? { type: filters.type } : {}),
        ...(filters?.status ? { status: filters.status } : {}),
      },
      orderBy: { updatedAt: "desc" },
    });
    return resources.map(toAdminRecord);
  } catch (error) {
    console.error("Error fetching admin resources:", error);
    return [];
  }
}

export async function getAdminResourceById(
  id: number
): Promise<AdminResourceRecord | null> {
  try {
    const resource = await prisma.resourceContent.findUnique({
      where: { id },
    });
    return resource ? toAdminRecord(resource) : null;
  } catch (error) {
    console.error("Error fetching admin resource:", error);
    return null;
  }
}

export async function createResource(
  data: Prisma.ResourceContentUncheckedCreateInput
): Promise<AdminResourceRecord> {
  const resource = await prisma.resourceContent.create({ data });
  return toAdminRecord(resource);
}

export async function updateResource(
  id: number,
  data: Prisma.ResourceContentUncheckedUpdateInput
): Promise<AdminResourceRecord> {
  const resource = await prisma.resourceContent.update({
    where: { id },
    data,
  });
  return toAdminRecord(resource);
}

// 归档而非物理删除：公开页只读 published，归档后即从公开页消失
export async function archiveResource(id: number): Promise<AdminResourceRecord> {
  const resource = await prisma.resourceContent.update({
    where: { id },
    data: { status: ResourceStatus.archived },
  });
  return toAdminRecord(resource);
}
