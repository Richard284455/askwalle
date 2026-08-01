import { Prisma, ResourceSourceType, ResourceStatus, ResourceType, type ArticleStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * 人工审核与发布。
 *
 * 链路只有三步：**从指定信源获取 → 生成文章 → 人工审核后发布**。
 * 中间不做真实性核实，也不做重复性核实 —— 内容与历史文章重复不是拒绝理由。
 *
 * 审核者判断的是「这篇能不能发」，不是「信源说的对不对」。
 */

export type ReviewListItem = {
  id: number;
  sourceItemId: number;
  status: ArticleStatus;
  mode: string;
  qaVerdict: string | null;
  qaIssueCount: number;
  headline: string | null;
  shortSummary: string | null;
  body: string | null;
  publisher: string;
  sourceUrl: string;
  sourceTitle: string;
  sourcePublishedAt: string | null;
  factMapping: { fact: string; sourceEvidence: string }[];
  qaIssues: { code: string; detail: string }[];
  resourceContentId: number | null;
  reviewedBy: string | null;
  reviewNotes: string | null;
  generatedAt: string | null;
  publishedAt: string | null;
};

const REVIEWABLE: ArticleStatus[] = ["DRAFTED", "FAITHFULNESS_REVIEW", "READY_TO_PUBLISH"];

function toJsonArray<T>(value: Prisma.JsonValue | null): T[] {
  return Array.isArray(value) ? (value as unknown as T[]) : [];
}

export async function listArticlesForReview(filter?: {
  status?: ArticleStatus[];
  limit?: number;
}): Promise<ReviewListItem[]> {
  const rows = await prisma.generatedArticle.findMany({
    where: { status: { in: filter?.status?.length ? filter.status : undefined } },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: Math.min(filter?.limit ?? 100, 200),
  });
  return rows.map((a) => ({
    id: a.id,
    sourceItemId: a.source_item_id,
    status: a.status,
    mode: a.mode,
    qaVerdict: a.qa_verdict,
    qaIssueCount: toJsonArray(a.qa_issues_json).length,
    headline: a.headline,
    shortSummary: a.short_summary,
    body: a.body,
    publisher: a.source_publisher_snapshot,
    sourceUrl: a.source_url_snapshot,
    sourceTitle: a.source_title_snapshot,
    sourcePublishedAt: a.source_published_at?.toISOString() ?? null,
    factMapping: toJsonArray(a.fact_mapping_json),
    qaIssues: toJsonArray(a.qa_issues_json),
    resourceContentId: a.resource_content_id,
    reviewedBy: a.reviewed_by,
    reviewNotes: a.review_notes,
    generatedAt: a.generated_at?.toISOString() ?? null,
    publishedAt: a.published_at?.toISOString() ?? null,
  }));
}

export type ActionResult = { ok: true; status: ArticleStatus; message: string } | { ok: false; message: string };

/** 通过审核：只是标记可发布，**不**自动发布 */
export async function approveArticle(id: number, reviewer: string, notes?: string): Promise<ActionResult> {
  const a = await prisma.generatedArticle.findUnique({ where: { id } });
  if (!a) return { ok: false, message: "草稿不存在" };
  if (!REVIEWABLE.includes(a.status)) return { ok: false, message: `当前状态 ${a.status} 不可审核` };
  await prisma.generatedArticle.update({
    where: { id },
    data: { status: "READY_TO_PUBLISH", reviewed_by: reviewer, reviewed_at: new Date(), review_notes: notes ?? null },
  });
  return { ok: true, status: "READY_TO_PUBLISH", message: "已通过审核，等待发布" };
}

/** 退回：与 FAITHFULNESS_FAILED 分开记 —— 那是偏离来源，这是编辑不想发 */
export async function rejectArticle(id: number, reviewer: string, notes?: string): Promise<ActionResult> {
  const a = await prisma.generatedArticle.findUnique({ where: { id } });
  if (!a) return { ok: false, message: "草稿不存在" };
  if (a.status === "PUBLISHED") return { ok: false, message: "已发布的文章不能退回" };
  await prisma.generatedArticle.update({
    where: { id },
    data: { status: "REJECTED_BY_REVIEWER", reviewed_by: reviewer, reviewed_at: new Date(), review_notes: notes ?? null },
  });
  return { ok: true, status: "REJECTED_BY_REVIEWER", message: "已退回" };
}

/** slug：标题不可靠（可能是中文），用来源条目 id 兜底保证唯一 */
function slugFor(a: { id: number; headline: string | null; source_item_id: number }): string {
  const base = (a.headline ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base ? `${base}-si${a.source_item_id}` : `source-${a.source_item_id}-a${a.id}`;
}

/**
 * 发布：写 ResourceContent 并把文章置 PUBLISHED。
 *
 * **必须先通过人工审核**（READY_TO_PUBLISH）才能走到这里 —— 没有自动发布路径。
 * 已发布的重复调用返回既有记录，不写第二条。
 */
export async function publishArticle(
  id: number,
  reviewer: string,
  options?: { category?: string; tags?: string[] }
): Promise<ActionResult & { resourceContentId?: number }> {
  const a = await prisma.generatedArticle.findUnique({ where: { id } });
  if (!a) return { ok: false, message: "草稿不存在" };
  if (a.status === "PUBLISHED" && a.resource_content_id) {
    return { ok: true, status: "PUBLISHED", message: "已发布", resourceContentId: a.resource_content_id };
  }
  if (a.status !== "READY_TO_PUBLISH") {
    return { ok: false, message: `当前状态 ${a.status}，必须先通过人工审核` };
  }
  if (!a.headline || !a.short_summary || !a.body) {
    return { ok: false, message: "标题、摘要或正文缺失，无法发布" };
  }

  const slug = slugFor(a);
  try {
    const resourceId = await prisma.$transaction(async (tx) => {
      const resource = await tx.resourceContent.create({
        data: {
          type: ResourceType.news,
          slug,
          title: a.headline!,
          summary: a.short_summary!,
          category: options?.category?.trim() || "AI News",
          tags: (options?.tags ?? []) as unknown as Prisma.InputJsonValue,
          publishedAt: new Date(),
          status: ResourceStatus.published,
          // 内容源自指定信源，由我们改写 —— 不是原创研究，也不是转载
          sourceType: ResourceSourceType.source_informed,
          sources: [
            {
              url: a.source_url_snapshot,
              title: a.source_title_snapshot,
              publisher: a.source_publisher_snapshot,
              publishedAt: a.source_published_at?.toISOString().slice(0, 10) ?? null,
              accessedAt: a.source_captured_at?.toISOString().slice(0, 10) ?? null,
            },
          ] as unknown as Prisma.InputJsonValue,
          content: {
            analysis: a.short_summary,
            body: a.body,
            sourceUrl: a.source_url_snapshot,
            sourceName: a.source_publisher_snapshot,
            // 明确标注：内容忠实于信源，但我们不为信源陈述的真实性背书
            sourceNotice: `本文依据 ${a.source_publisher_snapshot} 的公开发布内容改写，事实以信源陈述为准。`,
          } as unknown as Prisma.InputJsonValue,
          seoTitle: a.headline!.slice(0, 120),
          seoDescription: a.short_summary!.slice(0, 200),
        },
      });
      await tx.generatedArticle.update({
        where: { id },
        data: {
          status: "PUBLISHED", published_at: new Date(),
          resource_content_id: resource.id,
          reviewed_by: a.reviewed_by ?? reviewer,
        },
      });
      return resource.id;
    });
    return { ok: true, status: "PUBLISHED", message: "已发布", resourceContentId: resourceId };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.generatedArticle.update({
      where: { id },
      data: { status: "PUBLICATION_FAILED", failure_reason: message.slice(0, 300) },
    }).catch(() => {});
    return {
      ok: false,
      message: message.includes("Unique constraint") ? `slug「${slug}」已存在，请修改标题后重试` : message.slice(0, 200),
    };
  }
}
