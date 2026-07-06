import {
  Prisma,
  type ResourceContent,
  ResourceSourceType,
  ResourceStatus,
  ResourceType,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type {
  BaseResourceItem,
  DetailSection,
  ResourceItem,
  ResourceSource,
} from "@/data/resources/types";

export type ResourceTypeInput =
  | ResourceType
  | "NEWS"
  | "REVIEW"
  | "PROMPT"
  | "SKILL"
  | "TUTORIAL";

export type ResourceQueryOptions = {
  limit?: number;
  category?: string;
};

export type PublicResourceContent = {
  id: number;
  type: ResourceType;
  slug: string;
  title: string;
  summary: string;
  category: string;
  tags: Prisma.JsonValue;
  publishedAt: Date;
  updatedAt: Date;
  status: ResourceStatus;
  sourceType: ResourceSourceType;
  sources: Prisma.JsonValue | null;
  content: Prisma.JsonValue;
  seoTitle: string | null;
  seoDescription: string | null;
};

export type HomepageResourcePreviews = {
  latestNews: PublicResourceContent[];
  latestReviews: PublicResourceContent[];
  featuredPrompts: PublicResourceContent[];
  popularSkills: PublicResourceContent[];
  beginnerTutorials: PublicResourceContent[];
};

export type PublicResourceListItem = ResourceItem &
  Record<string, unknown> & {
  rating?: number;
  difficulty?: string;
  level?: string;
  sourceName?: string;
  sourceUrl?: string;
};

export type PublicResourceDetailItem = BaseResourceItem &
  Record<string, unknown> & {
    sourceName?: string;
    sourceUrl?: string;
    readTime?: string;
    rating?: number;
    bestFor?: string;
    pros?: string[];
    cons?: string[];
    difficulty?: string;
    useCase?: string;
    promptText?: string;
    exampleInput?: string;
    adaptationTips?: string[];
    estimatedTime?: string;
    steps?: string[];
    relatedTools?: string[];
    outcome?: string;
    level?: string;
  };

const resourceTypeMap: Record<string, ResourceType> = {
  NEWS: ResourceType.news,
  REVIEW: ResourceType.review,
  PROMPT: ResourceType.prompt,
  SKILL: ResourceType.skill,
  TUTORIAL: ResourceType.tutorial,
  news: ResourceType.news,
  review: ResourceType.review,
  prompt: ResourceType.prompt,
  skill: ResourceType.skill,
  tutorial: ResourceType.tutorial,
};

function normalizeResourceType(type: ResourceTypeInput) {
  return resourceTypeMap[type] ?? type;
}

function safeLimit(limit: number | undefined) {
  if (!limit) return undefined;
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined;
}

function handleResourceError(context: string) {
  console.warn(`[ResourceContent] ${context} failed; returning safe fallback.`);
}

function toPublicResource(resource: ResourceContent): PublicResourceContent {
  return {
    id: resource.id,
    type: resource.type,
    slug: resource.slug,
    title: resource.title,
    summary: resource.summary,
    category: resource.category,
    tags: resource.tags,
    publishedAt: resource.publishedAt,
    updatedAt: resource.updatedAt,
    status: resource.status,
    sourceType: resource.sourceType,
    sources: resource.sources,
    content: resource.content,
    seoTitle: resource.seoTitle,
    seoDescription: resource.seoDescription,
  };
}

function asObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function optionalStringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function detailSectionsValue(value: unknown): DetailSection[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((section) => {
      if (!section || typeof section !== "object" || Array.isArray(section)) {
        return null;
      }

      const sectionRecord = section as Record<string, unknown>;
      const heading = optionalStringValue(sectionRecord.heading);
      const body = optionalStringValue(sectionRecord.body);

      return heading && body ? { heading, body } : null;
    })
    .filter((section): section is DetailSection => section !== null);
}

function sourcesValue(value: Prisma.JsonValue | null): ResourceSource[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((source) => {
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        return null;
      }

      const sourceRecord = source as Record<string, unknown>;
      const title = optionalStringValue(sourceRecord.title);
      const url = optionalStringValue(sourceRecord.url);
      const publisher = optionalStringValue(sourceRecord.publisher);
      const accessedAt = optionalStringValue(sourceRecord.accessedAt);

      return title && url && publisher && accessedAt
        ? { title, url, publisher, accessedAt }
        : null;
    })
    .filter((source): source is ResourceSource => source !== null);
}

function tagsValue(value: Prisma.JsonValue) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function hrefForType(type: ResourceType, slug: string) {
  const routeByType: Record<ResourceType, string> = {
    [ResourceType.news]: "news",
    [ResourceType.review]: "reviews",
    [ResourceType.prompt]: "prompts",
    [ResourceType.skill]: "skills",
    [ResourceType.tutorial]: "tutorials",
  };

  return `/${routeByType[type]}/${slug}`;
}

function kindForType(type: ResourceType) {
  return type as PublicResourceListItem["kind"];
}

function metaForResource(resource: PublicResourceContent, content: Record<string, unknown>) {
  switch (resource.type) {
    case ResourceType.news:
      return stringValue(content.readTime, stringValue(content.sourceName, "News"));
    case ResourceType.review: {
      const rating = numberValue(content.rating);
      return rating ? `${rating.toFixed(1)} rating` : "Review";
    }
    case ResourceType.prompt:
      return stringValue(content.difficulty, "Prompt");
    case ResourceType.skill:
      return stringValue(content.estimatedTime, stringValue(content.difficulty, "Skill"));
    case ResourceType.tutorial:
      return stringValue(content.level, stringValue(content.estimatedTime, "Tutorial"));
    default:
      return "Resource";
  }
}

export function resourceContentToResourceItem(
  resource: PublicResourceContent
): PublicResourceListItem {
  const content = asObject(resource.content);

  return {
    title: resource.title,
    slug: resource.slug,
    summary: resource.summary,
    category: resource.category,
    tags: tagsValue(resource.tags),
    publishedAt: resource.publishedAt.toISOString(),
    analysis: stringValue(content.analysis),
    detailSections: [],
    href: hrefForType(resource.type, resource.slug),
    kind: kindForType(resource.type),
    meta: metaForResource(resource, content),
    sourceName: optionalStringValue(content.sourceName),
    sourceUrl: optionalStringValue(content.sourceUrl),
    rating: numberValue(content.rating),
    difficulty: optionalStringValue(content.difficulty),
    level: optionalStringValue(content.level),
    useCase: optionalStringValue(content.useCase),
    promptText: optionalStringValue(content.promptText),
    exampleInput: optionalStringValue(content.exampleInput),
    adaptationTips: stringArrayValue(content.adaptationTips),
    bestFor: optionalStringValue(content.bestFor),
    pros: stringArrayValue(content.pros),
    cons: stringArrayValue(content.cons),
    estimatedTime: optionalStringValue(content.estimatedTime),
    steps: stringArrayValue(content.steps),
    relatedTools: stringArrayValue(content.relatedTools),
    outcome: optionalStringValue(content.outcome),
  };
}

export function resourceContentToDetailItem(
  resource: PublicResourceContent
): PublicResourceDetailItem {
  const content = asObject(resource.content);

  return {
    title: resource.title,
    slug: resource.slug,
    summary: resource.summary,
    category: resource.category,
    tags: tagsValue(resource.tags),
    publishedAt: resource.publishedAt.toISOString(),
    analysis: stringValue(content.analysis),
    detailSections: detailSectionsValue(content.detailSections),
    sources: sourcesValue(resource.sources),
    sourceName: optionalStringValue(content.sourceName),
    sourceUrl: optionalStringValue(content.sourceUrl),
    readTime: optionalStringValue(content.readTime),
    rating: numberValue(content.rating),
    bestFor: optionalStringValue(content.bestFor),
    pros: stringArrayValue(content.pros),
    cons: stringArrayValue(content.cons),
    difficulty: optionalStringValue(content.difficulty),
    useCase: optionalStringValue(content.useCase),
    promptText: optionalStringValue(content.promptText),
    exampleInput: optionalStringValue(content.exampleInput),
    adaptationTips: stringArrayValue(content.adaptationTips),
    estimatedTime: optionalStringValue(content.estimatedTime),
    steps: stringArrayValue(content.steps),
    relatedTools: stringArrayValue(content.relatedTools),
    outcome: optionalStringValue(content.outcome),
    level: optionalStringValue(content.level),
  };
}

export async function getResourcesByType(
  type: ResourceTypeInput,
  options: ResourceQueryOptions = {}
): Promise<PublicResourceContent[]> {
  try {
    const take = safeLimit(options.limit);
    const args: Prisma.ResourceContentFindManyArgs = {
      where: {
        type: normalizeResourceType(type),
        status: ResourceStatus.published,
        ...(options.category ? { category: options.category } : {}),
      },
      orderBy: {
        publishedAt: "desc",
      },
      ...(take ? { take } : {}),
    };

    const resources = await prisma.resourceContent.findMany(args);
    return resources.map(toPublicResource);
  } catch {
    handleResourceError("getResourcesByType");
    return [];
  }
}

export async function getResourceBySlug(
  type: ResourceTypeInput,
  slug: string
): Promise<PublicResourceContent | null> {
  try {
    const resource = await prisma.resourceContent.findFirst({
      where: {
        type: normalizeResourceType(type),
        slug,
        status: ResourceStatus.published,
      },
    });

    return resource ? toPublicResource(resource) : null;
  } catch {
    handleResourceError("getResourceBySlug");
    return null;
  }
}

export async function getLatestResources(
  type: ResourceTypeInput,
  limit = 3
): Promise<PublicResourceContent[]> {
  return getResourcesByType(type, { limit });
}

export async function getHomepageResourcePreviews(
  limit = 3
): Promise<HomepageResourcePreviews> {
  try {
    const [
      latestNews,
      latestReviews,
      featuredPrompts,
      popularSkills,
      beginnerTutorials,
    ] = await Promise.all([
      getLatestResources(ResourceType.news, limit),
      getLatestResources(ResourceType.review, limit),
      getLatestResources(ResourceType.prompt, limit),
      getLatestResources(ResourceType.skill, limit),
      getLatestResources(ResourceType.tutorial, limit),
    ]);

    return {
      latestNews,
      latestReviews,
      featuredPrompts,
      popularSkills,
      beginnerTutorials,
    };
  } catch {
    handleResourceError("getHomepageResourcePreviews");
    return {
      latestNews: [],
      latestReviews: [],
      featuredPrompts: [],
      popularSkills: [],
      beginnerTutorials: [],
    };
  }
}
