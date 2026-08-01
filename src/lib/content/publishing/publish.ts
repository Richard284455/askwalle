import { createHash } from "crypto";

import { Prisma, type DraftLanguage } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { httpUrlOrNull } from "../aihot/types";

import { assessHotTopic } from "./eligibility";
import { LOCALES, publicPath } from "./types";

/**
 * 受控发布。
 *
 * 发布是**对外可见**的动作，所以先做一次只读 preflight，任何一条不成立
 * 就整单元不发。preflight 不写库、不调 provider、不发外部请求。
 *
 * 幂等靠数据库约束，不靠「先查再写」—— 超时重试与并发面前，
 * 查询与写入之间的那个窗口一定会被撞上。
 */

export type PreflightIssue = { code: string; detail: string };

export type PreflightResult = {
  familyId: number;
  unitKey: string;
  slug: string;
  contentForm: string;
  ok: boolean;
  issues: PreflightIssue[];
  targets: { locale: DraftLanguage; translationId: number; revisionId: number; path: string }[];
  /** 同一 revision 已经发布过的语言。**不是错误** —— 重发本来就该返回「已存在」 */
  alreadyPublished: { locale: DraftLanguage; translationId: number; revisionId: number; path: string }[];
  clusteringCounters: { runs: number; edges: number; candidates: number; members: number };
};

/**
 * 幂等键。
 *
 * 由 (translation, revision) 决定，不带时间戳或随机数 ——
 * 重试必须算出**同一个**键，否则幂等就是假的。
 */
export function publicationIdempotencyKey(translationId: number, revisionId: number): string {
  return createHash("sha256").update(`publication:v1:${translationId}:${revisionId}`).digest("hex").slice(0, 40);
}

async function clusteringCounters() {
  const [runs, edges, candidates, members] = await Promise.all([
    prisma.eventClusteringRun.count(), prisma.eventSimilarityEdge.count(),
    prisma.eventClusterCandidate.count(), prisma.eventClusterCandidateMember.count(),
  ]);
  return { runs, edges, candidates, members };
}

/** 只读预检。不写任何东西 */
export async function preflight(familyId: number): Promise<PreflightResult | null> {
  const family = await prisma.articleFamily.findUnique({
    where: { id: familyId },
    include: { translations: { include: { revisions: { orderBy: { revision_number: "desc" } } } } },
  });
  if (!family) return null;

  const issues: PreflightIssue[] = [];
  const targets: PreflightResult["targets"] = [];
  const alreadyPublished: PreflightResult["alreadyPublished"] = [];

  // ── 归因链接 ──
  if (!httpUrlOrNull(family.attribution_url)) {
    issues.push({ code: "ATTRIBUTION_URL_INVALID", detail: `AI HOT 链接非法：${family.attribution_url}` });
  }
  if (family.original_source_url !== null && !httpUrlOrNull(family.original_source_url)) {
    issues.push({ code: "SOURCE_URL_INVALID", detail: `原始来源链接非法：${family.original_source_url}` });
  }

  // ── 来源快照未变 ──
  const currentHash = await currentSourceHash(family);
  if (currentHash === null) {
    issues.push({ code: "SOURCE_ROW_MISSING", detail: "找不到对应的 AI HOT 来源记录" });
  } else if (currentHash !== family.source_snapshot_hash) {
    issues.push({
      code: "SOURCE_SNAPSHOT_CHANGED",
      detail: "AI HOT 侧内容已变化，冻结的这一版不再对应当前来源，需重新生成后再审",
    });
  }

  // ── 热点专属门槛 ──
  if (family.content_form === "HOT_TOPIC_BRIEF") {
    if (!family.hot_topic_snapshot_id) {
      issues.push({ code: "HOT_TOPIC_SNAPSHOT_MISSING", detail: "热点 family 未关联快照" });
    } else {
      const eligible = await assessHotTopic(family.hot_topic_snapshot_id);
      if (!eligible.publishable) {
        issues.push({ code: eligible.reason, detail: eligible.missing.join("；") });
      }
    }
  }

  if (family.content_form === "DAILY_BRIEF" && !family.report_date) {
    issues.push({ code: "DAILY_DATE_MISSING", detail: "日报缺少 report_date，无法生成路径" });
  }

  // ── 四种语言 ──
  for (const locale of LOCALES) {
    const t = family.translations.find((x) => x.locale === locale);
    if (!t) { issues.push({ code: "LOCALE_MISSING", detail: `缺少语言 ${locale}` }); continue; }

    const approvedId = t.approved_revision_id;
    if (!approvedId) { issues.push({ code: "NOT_APPROVED", detail: `${locale} 尚未通过人工审核` }); continue; }
    if (t.status !== "APPROVED" && t.status !== "PUBLISHED") {
      issues.push({ code: "NOT_APPROVED", detail: `${locale} 状态为 ${t.status}` });
      continue;
    }
    if (t.current_revision_id && t.current_revision_id !== approvedId) {
      issues.push({ code: "APPROVED_NOT_CURRENT", detail: `${locale} 批准的不是最新一版，需重新审核` });
      continue;
    }

    const rev = t.revisions.find((r) => r.id === approvedId);
    if (!rev) { issues.push({ code: "REVISION_MISSING", detail: `${locale} 找不到已批准的 revision` }); continue; }
    if (rev.qa_verdict !== "PASSED") {
      issues.push({ code: "QA_NOT_PASSED", detail: `${locale} revision #${rev.revision_number} QA 未通过` });
      continue;
    }
    if (!rev.headline?.trim() || !rev.body?.trim()) {
      issues.push({ code: "EMPTY_CONTENT", detail: `${locale} revision 内容为空` });
      continue;
    }

    const path = publicPath({
      locale, contentForm: family.content_form, slug: family.slug, reportDate: family.report_date,
    });

    // ── 同一版已发布？同一路径被别人占了？ ──
    const existing = await prisma.articlePublication.findUnique({
      where: { translation_id_revision_id: { translation_id: t.id, revision_id: rev.id } },
      select: { id: true, status: true },
    });
    if (existing && existing.status === "PUBLISHED") {
      alreadyPublished.push({ locale, translationId: t.id, revisionId: rev.id, path });
      continue;
    }
    const pathTaken = await prisma.articlePublication.findUnique({
      where: { locale_path: { locale, path } },
      select: { id: true, translation_id: true },
    });
    if (pathTaken && pathTaken.translation_id !== t.id) {
      issues.push({ code: "PATH_CONFLICT", detail: `${locale} 路径 ${path} 已被译本 #${pathTaken.translation_id} 占用` });
      continue;
    }

    targets.push({ locale, translationId: t.id, revisionId: rev.id, path });
  }

  return {
    familyId: family.id, unitKey: family.unit_key, slug: family.slug,
    contentForm: family.content_form,
    // 已发布的语言算「达成」，不算缺口
    ok: issues.length === 0 && targets.length + alreadyPublished.length === LOCALES.length,
    issues, targets, alreadyPublished,
    clusteringCounters: await clusteringCounters(),
  };
}

async function currentSourceHash(family: {
  content_form: string; selected_item_id: number | null;
  hot_topic_snapshot_id: number | null; daily_report_id: number | null;
}): Promise<string | null> {
  if (family.selected_item_id) {
    const r = await prisma.aihotSelectedItem.findUnique({
      where: { id: family.selected_item_id }, select: { source_snapshot_hash: true } });
    return r?.source_snapshot_hash ?? null;
  }
  if (family.hot_topic_snapshot_id) {
    const r = await prisma.aihotHotTopicSnapshot.findUnique({
      where: { id: family.hot_topic_snapshot_id }, select: { source_snapshot_hash: true } });
    return r?.source_snapshot_hash ?? null;
  }
  if (family.daily_report_id) {
    const r = await prisma.aihotDailyReport.findUnique({
      where: { id: family.daily_report_id }, select: { source_snapshot_hash: true } });
    return r?.source_snapshot_hash ?? null;
  }
  return null;
}

// ── 发布 ──────────────────────────────────────────────────────────────────

export type PublishOutcome = {
  locale: DraftLanguage;
  status: "PUBLISHED" | "ALREADY_PUBLISHED" | "FAILED";
  publicationId: number | null;
  path: string | null;
  message: string | null;
};

export type PublishFamilyResult = {
  familyId: number;
  unitKey: string;
  ok: boolean;
  outcomes: PublishOutcome[];
  blocked: PreflightIssue[];
};

/**
 * 发布单个语言版本。
 *
 * 幂等键相同 → 返回 ALREADY_PUBLISHED，**不创建第二条记录**。
 * 唯一约束冲突（P2002）同样按「已存在」处理：那正是并发重试撞上的情形，
 * 把它当错误报出去，调用方就会去重试一个本已成功的操作。
 */
export async function publishTranslation(args: {
  translationId: number; revisionId: number; locale: DraftLanguage; path: string;
}): Promise<PublishOutcome> {
  const key = publicationIdempotencyKey(args.translationId, args.revisionId);

  const existing = await prisma.articlePublication.findUnique({ where: { idempotency_key: key } });
  if (existing) {
    return {
      locale: args.locale,
      status: existing.status === "PUBLISHED" ? "ALREADY_PUBLISHED" : "FAILED",
      publicationId: existing.id, path: existing.path,
      message: existing.status === "PUBLISHED" ? "同一 revision 已发布，未重复创建" : existing.failure_reason,
    };
  }

  try {
    const pub = await prisma.$transaction(async (tx) => {
      const created = await tx.articlePublication.create({
        data: {
          translation_id: args.translationId,
          revision_id: args.revisionId,
          idempotency_key: key,
          locale: args.locale,
          path: args.path,
          status: "PUBLISHED",
        },
      });
      await tx.articleTranslation.update({
        where: { id: args.translationId },
        data: { status: "PUBLISHED", published_revision_id: args.revisionId },
      });
      return created;
    });
    return { locale: args.locale, status: "PUBLISHED", publicationId: pub.id, path: pub.path, message: null };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const again = await prisma.articlePublication.findUnique({ where: { idempotency_key: key } });
      if (again) {
        return { locale: args.locale, status: "ALREADY_PUBLISHED", publicationId: again.id,
          path: again.path, message: "并发重复请求，已存在同一条发布记录" };
      }
    }
    return { locale: args.locale, status: "FAILED", publicationId: null, path: args.path,
      message: e instanceof Error ? e.message.slice(0, 200) : "发布失败" };
  }
}

/**
 * 发布一个 family。
 *
 * 默认**先发英文**：英文页面渲染、canonical、归因结构有问题时，
 * 其余三种语言一律不发 —— 同一个结构性错误没必要犯四遍。
 */
export async function publishFamily(args: {
  familyId: number;
  /** 只发英文，用于先验证渲染 */
  masterOnly?: boolean;
  dryRun?: boolean;
}): Promise<PublishFamilyResult> {
  const pre = await preflight(args.familyId);
  if (!pre) return { familyId: args.familyId, unitKey: "", ok: false, outcomes: [], blocked: [{ code: "FAMILY_MISSING", detail: "family 不存在" }] };

  if (pre.issues.length) {
    return { familyId: pre.familyId, unitKey: pre.unitKey, ok: false, outcomes: [], blocked: pre.issues };
  }

  const targets = args.masterOnly ? pre.targets.filter((t) => t.locale === "EN_US") : pre.targets;
  /*
   * 已经发布过的语言如实回报 ALREADY_PUBLISHED，而不是静默跳过。
   * 静默跳过时，调用方分不清「这次发成功了」和「本来就已经在」——
   * 超时重试的人只会以为什么都没发生，然后再点一次。
   */
  const priorOutcomes: PublishOutcome[] = (args.masterOnly
    ? pre.alreadyPublished.filter((t) => t.locale === "EN_US")
    : pre.alreadyPublished
  ).map((t) => ({
    locale: t.locale, status: "ALREADY_PUBLISHED" as const, publicationId: null,
    path: t.path, message: "同一 revision 已发布，未重复创建",
  }));
  if (args.dryRun) {
    return {
      familyId: pre.familyId, unitKey: pre.unitKey, ok: true, blocked: [],
      outcomes: [...priorOutcomes, ...targets.map((t) => ({ locale: t.locale, status: "PUBLISHED" as const,
        publicationId: null, path: t.path, message: "dry-run，未写库" }))],
    };
  }

  const outcomes: PublishOutcome[] = [...priorOutcomes];
  for (const t of targets) {
    outcomes.push(await publishTranslation(t));
  }

  const failed = outcomes.filter((o) => o.status === "FAILED");
  if (!failed.length && !args.masterOnly) {
    await prisma.articleFamily.update({ where: { id: pre.familyId }, data: { status: "PUBLISHED" } });
  }
  if (failed.length) {
    await prisma.articleFamily.update({ where: { id: pre.familyId }, data: { status: "PUBLICATION_FAILED" } });
  }

  return { familyId: pre.familyId, unitKey: pre.unitKey, ok: failed.length === 0, outcomes, blocked: [] };
}
