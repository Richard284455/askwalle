import {
  Prisma,
  PrismaClient,
  ResourceSourceType,
  ResourceStatus,
  ResourceType,
} from "@prisma/client";

import { newsItems } from "../src/data/resources/news";
import { promptItems } from "../src/data/resources/prompts";
import { reviewItems } from "../src/data/resources/reviews";
import { skillItems } from "../src/data/resources/skills";
import { tutorialItems } from "../src/data/resources/tutorials";
import type {
  BaseResourceItem,
  NewsItem,
  PromptItem,
  ReviewItem,
  SkillItem,
  TutorialItem,
} from "../src/data/resources/types";

const prisma = new PrismaClient();
const overwrite = process.argv.includes("--overwrite");

type ImportRecord = {
  type: ResourceType;
  slug: string;
  title: string;
  summary: string;
  category: string;
  tags: Prisma.InputJsonValue;
  publishedAt: Date;
  status: ResourceStatus;
  sourceType: ResourceSourceType;
  sources?: Prisma.InputJsonValue;
  content: Prisma.InputJsonValue;
  seoTitle: string;
  seoDescription: string;
};

type ImportStats = {
  inserted: number;
  skipped: number;
  updated: number;
};

function sourceTypeFor(item: BaseResourceItem) {
  if (!item.sources?.length) return ResourceSourceType.original;

  return item.sources.some((source) => source.publisher !== "AskWalle")
    ? ResourceSourceType.source_informed
    : ResourceSourceType.original;
}

function baseRecord(
  type: ResourceType,
  sectionName: string,
  item: BaseResourceItem,
  content: Record<string, unknown>
): ImportRecord {
  return {
    type,
    slug: item.slug,
    title: item.title,
    summary: item.summary,
    category: item.category,
    tags: item.tags,
    publishedAt: new Date(item.publishedAt),
    status: ResourceStatus.published,
    sourceType: sourceTypeFor(item),
    sources: item.sources as Prisma.InputJsonValue | undefined,
    content: content as Prisma.InputJsonValue,
    seoTitle: `${item.title} - ${sectionName} | AskWalle AI Hub`,
    seoDescription: item.summary,
  };
}

function newsRecord(item: NewsItem) {
  return baseRecord(ResourceType.news, "AI News", item, {
    analysis: item.analysis,
    detailSections: item.detailSections,
    readTime: item.readTime,
    sourceName: item.sourceName,
    sourceUrl: item.sourceUrl,
  });
}

function reviewRecord(item: ReviewItem) {
  return baseRecord(ResourceType.review, "AI Tool Reviews", item, {
    analysis: item.analysis,
    detailSections: item.detailSections,
    sourceName: item.sourceName,
    sourceUrl: item.sourceUrl,
    rating: item.rating,
    bestFor: item.bestFor,
    pros: item.pros,
    cons: item.cons,
  });
}

function promptRecord(item: PromptItem) {
  return baseRecord(ResourceType.prompt, "Prompt Library", item, {
    analysis: item.analysis,
    detailSections: item.detailSections,
    difficulty: item.difficulty,
    useCase: item.useCase,
    promptText: item.promptText,
    exampleInput: item.exampleInput,
    adaptationTips: item.adaptationTips,
  });
}

function skillRecord(item: SkillItem) {
  return baseRecord(ResourceType.skill, "Skills Library", item, {
    analysis: item.analysis,
    detailSections: item.detailSections,
    difficulty: item.difficulty,
    estimatedTime: item.estimatedTime,
    steps: item.steps,
    relatedTools: item.relatedTools,
    outcome: item.outcome,
  });
}

function tutorialRecord(item: TutorialItem) {
  return baseRecord(ResourceType.tutorial, "AI Tutorials", item, {
    analysis: item.analysis,
    detailSections: item.detailSections,
    level: item.level,
    estimatedTime: item.estimatedTime,
    steps: item.steps,
    outcome: item.outcome,
    sourceName: item.sourceName,
    sourceUrl: item.sourceUrl,
  });
}

function toPrismaData(record: ImportRecord) {
  const { sources, ...data } = record;

  return {
    ...data,
    ...(sources ? { sources } : {}),
  };
}

async function importRecord(record: ImportRecord, stats: ImportStats) {
  const where = {
    type_slug: {
      type: record.type,
      slug: record.slug,
    },
  };

  const existing = await prisma.resourceContent.findUnique({ where });

  if (existing && !overwrite) {
    stats.skipped++;
    return;
  }

  if (existing) {
    await prisma.resourceContent.update({
      where,
      data: toPrismaData(record),
    });
    stats.updated++;
    return;
  }

  await prisma.resourceContent.create({
    data: toPrismaData(record),
  });
  stats.inserted++;
}

function redactPotentialSecrets(message: string) {
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(DATABASE_URL|DIRECT_URL|JWT_SECRET|ADMIN_PASSWORD)=\S+/gi, "$1=[redacted]");
}

async function main() {
  const records: ImportRecord[] = [
    ...newsItems.map(newsRecord),
    ...reviewItems.map(reviewRecord),
    ...promptItems.map(promptRecord),
    ...skillItems.map(skillRecord),
    ...tutorialItems.map(tutorialRecord),
  ];

  const stats: ImportStats = {
    inserted: 0,
    skipped: 0,
    updated: 0,
  };

  for (const record of records) {
    await importRecord(record, stats);
  }

  console.log(
    `Resource import complete. Inserted: ${stats.inserted}. Skipped: ${stats.skipped}. Updated: ${stats.updated}.`
  );
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Resource import failed: ${redactPotentialSecrets(message)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode ?? 0);
  });
