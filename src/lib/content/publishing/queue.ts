import type {
  AihotContentKind, DraftLanguage, HotTopicBriefMode, MultilingualContentForm,
  PublishStatus, ReviewDecision, ReviewerType,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";

import {
  dateKeys, modelTokens, numberSet, numberTokens, properTokens, type Lang,
} from "../multilingual/linguistics";

import { LOCALES, publicPath } from "./types";

/**
 * 编辑审核队列的数据层。
 *
 * 这一页是**内部**视图：实际来源名称、来源指纹、QA 明细都要看得见 ——
 * 公开页把它们藏起来是产品决定，审核台把它们藏起来只会让审核无从下手。
 *
 * 但**只读 AI HOT 原始输入**。队列可以改审核状态、造新 revision、手工发布，
 * 唯独不能改信源给的字段：那等于一边引用别人，一边替别人改口。
 */

export const QUEUE_TABS = [
  "NEEDS_REVIEW", "QA_FAILED", "APPROVED", "PUBLISHED", "REJECTED",
  "SELECTED", "HOT_TOPICS", "DAILY", "ALL",
] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];

export const TAB_LABEL: Record<QueueTab, string> = {
  NEEDS_REVIEW: "待审核", QA_FAILED: "QA 未过", APPROVED: "已批准",
  PUBLISHED: "已发布", REJECTED: "已拒绝",
  SELECTED: "精选", HOT_TOPICS: "热点", DAILY: "日报", ALL: "全部",
};

export type LocaleState = {
  locale: DraftLanguage;
  translationId: number | null;
  status: PublishStatus | "MISSING";
  currentRevisionId: number | null;
  currentRevisionNumber: number | null;
  approvedRevisionId: number | null;
  approvedIsCurrent: boolean;
  publishedRevisionId: number | null;
  publishedPath: string | null;
  qaVerdict: string | null;
  qaIssues: { code: string; detail: string }[];
  lastReviewerType: ReviewerType | null;
  lastReviewerId: string | null;
  lastReviewerName: string | null;
  lastDecision: ReviewDecision | null;
  lastReviewedAt: Date | null;
  lastNotes: string | null;
  reviewCount: number;
};

export type QueueRow = {
  familyId: number;
  unitKey: string;
  slug: string;
  reportDate: string | null;
  contentKind: AihotContentKind;
  contentForm: MultilingualContentForm;
  hotTopicMode: HotTopicBriefMode | null;
  familyStatus: PublishStatus;
  categorySlug: string | null;
  /** 英文母版标题 —— 队列列表用它做人可读标识 */
  masterHeadline: string | null;
  // ── 内部来源元数据 ──
  attributionName: string;
  attributionUrl: string;
  originalSourceName: string | null;
  originalSourceUrl: string | null;
  sourceSnapshotHash: string;
  sourcePublishedAt: Date | null;
  capturedAt: Date | null;
  /** 来源外键。带在行上，详情页就不必为了拿它们再查一次 family */
  selectedItemId: number | null;
  hotTopicSnapshotId: number | null;
  dailyReportId: number | null;
  locales: LocaleState[];
  publishedCount: number;
  qaIssueCount: number;
  updatedAt: Date;
};

function parseIssues(raw: unknown): { code: string; detail: string }[] {
  if (!Array.isArray(raw)) return [];
  return (raw as { code?: unknown; detail?: unknown }[]).map((i) => ({
    code: typeof i?.code === "string" ? i.code : "UNKNOWN",
    detail: typeof i?.detail === "string" ? i.detail : "",
  }));
}

/** 队列行的分类：一个 family 只落在一个「状态」栏目里，按最坏情况取 */
export function tabOf(row: QueueRow): Exclude<QueueTab, "SELECTED" | "HOT_TOPICS" | "DAILY" | "ALL"> {
  if (row.locales.some((l) => l.status === "REJECTED")) return "REJECTED";
  if (row.locales.some((l) => l.qaVerdict && l.qaVerdict !== "PASSED")) return "QA_FAILED";
  if (row.publishedCount === LOCALES.length) return "PUBLISHED";
  if (row.locales.every((l) => l.status !== "MISSING" && l.approvedIsCurrent)) return "APPROVED";
  return "NEEDS_REVIEW";
}

/**
 * 把 family 行装配成队列行。**一次库读取，多处复用。**
 *
 * 以前列表、计数、详情各自读一遍全量 —— 打开一次审核台要跑三遍同样的
 * 深层嵌套查询，加上并发的定时任务，连接池直接被打满，页面报 P1001，
 * 看起来像「数据库挂了」，其实是我们自己把池占满了。
 */
async function loadRows(where: { content_kind?: AihotContentKind; id?: number }, limit: number): Promise<QueueRow[]> {
  const families = await prisma.articleFamily.findMany({
    where: Object.keys(where).length ? where : undefined,
    orderBy: { updated_at: "desc" },
    take: limit,
    include: {
      translations: {
        include: {
          /*
           * **只取列表用得到的字段。**
           *
           * 默认 include 会把整篇正文一起拉回来 —— 34 个家族 × 4 种语言
           * 就是 136 篇全文，只为了在列表里显示一个版本号和 QA 结论。
           * 实测这么一改，队列查询从 7 秒降到 1 秒出头，
           * 连接也不会被长时间占着（那正是把池拖垮的原因之一）。
           * 正文只在详情页按需读。
           */
          revisions: {
            orderBy: { revision_number: "desc" }, take: 1,
            select: { id: true, revision_number: true, headline: true, qa_verdict: true, qa_issues_json: true },
          },
          reviews: {
            orderBy: { reviewed_at: "desc" }, take: 1,
            select: {
              reviewer: true, reviewer_type: true, reviewer_id: true, reviewer_name: true,
              decision: true, notes: true, reviewed_at: true, issue_categories_json: true,
            },
          },
          publications: {
            where: { status: "PUBLISHED" }, orderBy: { published_at: "desc" }, take: 1,
            select: { revision_id: true, path: true },
          },
          _count: { select: { reviews: true } },
        },
      },
    },
  });

  const snapIds = families.map((f) => f.hot_topic_snapshot_id).filter((x): x is number => x !== null);
  const snaps = snapIds.length
    ? await prisma.aihotHotTopicSnapshot.findMany({
        where: { id: { in: snapIds } }, select: { id: true, captured_at: true },
      })
    : [];
  const capturedById = new Map(snaps.map((s) => [s.id, s.captured_at]));

  const rows: QueueRow[] = families.map((f) => {
    const locales: LocaleState[] = LOCALES.map((locale) => {
      const t = f.translations.find((x) => x.locale === locale);
      if (!t) {
        return {
          locale, translationId: null, status: "MISSING" as const,
          currentRevisionId: null, currentRevisionNumber: null,
          approvedRevisionId: null, approvedIsCurrent: false,
          publishedRevisionId: null, publishedPath: null,
          qaVerdict: null, qaIssues: [],
          lastReviewerType: null, lastReviewerId: null, lastReviewerName: null,
          lastDecision: null, lastReviewedAt: null, lastNotes: null, reviewCount: 0,
        };
      }
      const rev = t.revisions[0];
      const review = t.reviews[0];
      const pub = t.publications[0];
      return {
        locale, translationId: t.id, status: t.status,
        currentRevisionId: t.current_revision_id,
        currentRevisionNumber: rev?.revision_number ?? null,
        approvedRevisionId: t.approved_revision_id,
        approvedIsCurrent: Boolean(t.approved_revision_id && t.approved_revision_id === t.current_revision_id),
        publishedRevisionId: pub?.revision_id ?? null,
        publishedPath: pub?.path ?? null,
        qaVerdict: rev?.qa_verdict ?? null,
        qaIssues: parseIssues(rev?.qa_issues_json),
        lastReviewerType: review?.reviewer_type ?? null,
        lastReviewerId: review?.reviewer_id ?? review?.reviewer ?? null,
        lastReviewerName: review?.reviewer_name ?? null,
        lastDecision: review?.decision ?? null,
        lastReviewedAt: review?.reviewed_at ?? null,
        lastNotes: review?.notes ?? null,
        reviewCount: t._count.reviews,
      };
    });

    const master = f.translations.find((t) => t.locale === "EN_US");
    return {
      familyId: f.id, unitKey: f.unit_key, slug: f.slug, reportDate: f.report_date,
      contentKind: f.content_kind, contentForm: f.content_form, hotTopicMode: f.hot_topic_mode,
      familyStatus: f.status, categorySlug: f.category_slug,
      masterHeadline: master?.revisions[0]?.headline ?? null,
      attributionName: f.attribution_name, attributionUrl: f.attribution_url,
      originalSourceName: f.original_source_name, originalSourceUrl: f.original_source_url,
      sourceSnapshotHash: f.source_snapshot_hash, sourcePublishedAt: f.source_published_at,
      capturedAt: f.hot_topic_snapshot_id ? capturedById.get(f.hot_topic_snapshot_id) ?? null : null,
      selectedItemId: f.selected_item_id,
      hotTopicSnapshotId: f.hot_topic_snapshot_id,
      dailyReportId: f.daily_report_id,
      locales,
      publishedCount: locales.filter((l) => l.publishedPath).length,
      qaIssueCount: locales.reduce((n, l) => n + l.qaIssues.length, 0),
      updatedAt: f.updated_at,
    };
  });

  return rows;
}

function kindOfTab(tab: QueueTab): AihotContentKind | undefined {
  return tab === "SELECTED" ? "SELECTED"
    : tab === "HOT_TOPICS" ? "HOT_TOPIC"
    : tab === "DAILY" ? "DAILY" : undefined;
}

export function countRows(rows: QueueRow[]): Record<QueueTab, number> {
  const counts = Object.fromEntries(QUEUE_TABS.map((t) => [t, 0])) as Record<QueueTab, number>;
  for (const r of rows) {
    counts[tabOf(r)]++;
    counts.ALL++;
    if (r.contentKind === "SELECTED") counts.SELECTED++;
    else if (r.contentKind === "HOT_TOPIC") counts.HOT_TOPICS++;
    else counts.DAILY++;
  }
  return counts;
}

export function filterByTab(rows: QueueRow[], tab: QueueTab): QueueRow[] {
  const kind = kindOfTab(tab);
  if (kind) return rows.filter((r) => r.contentKind === kind);
  if (tab === "ALL") return rows;
  return rows.filter((r) => tabOf(r) === tab);
}

/**
 * 队列页需要的全部数据。
 *
 * **一次读取**同时得出当前栏目的行与所有栏目的计数 ——
 * 计数不该再跑一遍全量查询：那是同一份数据读两遍，
 * 而两遍之间还可能因为定时任务写入而对不上。
 */
export async function loadQueue(
  opts: { tab?: QueueTab; limit?: number } = {}
): Promise<{ tab: QueueTab; rows: QueueRow[]; counts: Record<QueueTab, number> }> {
  const tab = opts.tab ?? "NEEDS_REVIEW";
  const all = await loadRows({}, opts.limit ?? 500);
  return { tab, rows: filterByTab(all, tab), counts: countRows(all) };
}

/** 兼容既有调用方；内部同样只读一次 */
export async function listQueue(opts: { tab?: QueueTab; limit?: number } = {}): Promise<QueueRow[]> {
  const tab = opts.tab ?? "NEEDS_REVIEW";
  const kind = kindOfTab(tab);
  // 体裁栏目能在 SQL 里直接筛，不必把全部家族拉回来
  const rows = await loadRows(kind ? { content_kind: kind } : {}, opts.limit ?? 500);
  return kind ? rows : filterByTab(rows, tab);
}

export async function queueCounts(): Promise<Record<QueueTab, number>> {
  return countRows(await loadRows({}, 1000));
}

// ── 详情：四语言并排 + 来源事实 + 对照 ────────────────────────────────────

export type LocaleContent = LocaleState & {
  headline: string | null;
  summary: string | null;
  body: string | null;
  sections: { label: string; body: string }[];
  /** 该语言若已批准，公开后会落在哪个路径 */
  targetPath: string;
};

export type SourceFact = { label: string; value: string; volatile: boolean };

export type ComparisonRow = {
  dimension: "NUMBER" | "DATE" | "MODEL" | "ENTITY";
  /** 母版里的值 */
  master: string;
  /** 逐语言是否覆盖到 */
  present: Record<string, boolean>;
};

export type FamilyDetail = {
  row: QueueRow;
  /** AI HOT 原始输入的只读快照 —— 队列不提供任何修改入口 */
  source: {
    kind: AihotContentKind;
    title: string;
    summary: string | null;
    facts: SourceFact[];
    sourceNames: string[];
    aihotUrl: string;
    originalUrl: string | null;
    snapshotHash: string;
    capturedAt: Date | null;
    /** 日报的栏目顺序，用于人工核对「顺序没被改」 */
    sectionLabels: string[];
  } | null;
  contents: LocaleContent[];
  comparison: ComparisonRow[];
};

const LANG_OF: Record<DraftLanguage, Lang> = {
  EN_US: "EN_US", ES_ES: "ES_ES", PT_BR: "PT_BR", JA_JP: "JA_JP",
};

function deriveSections(body: string | null): { label: string; body: string }[] {
  if (!body) return [];
  const parts = body.split(/^##\s+/m).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return [];
  return parts.map((p) => {
    const nl = p.indexOf("\n");
    return nl < 0 ? { label: p, body: "" } : { label: p.slice(0, nl).trim(), body: p.slice(nl + 1).trim() };
  });
}

/**
 * 数字 / 日期 / 模型 / 实体的跨语言对照。
 *
 * 这不是第二道 QA —— 确定性 QA 已经在生成时跑过了。这里是给**人**看的：
 * 把母版里的每个关键 token 摊开，让审核者一眼看出哪种语言丢了哪一项，
 * 而不是逐字读四篇文章去找。
 */
export function buildComparison(contents: LocaleContent[]): ComparisonRow[] {
  const master = contents.find((c) => c.locale === "EN_US");
  if (!master) return [];
  const masterText = `${master.headline ?? ""}\n${master.summary ?? ""}\n${master.body ?? ""}`;

  const others = contents.filter((c) => c.locale !== "EN_US");
  const texts = new Map(others.map((c) => [
    c.locale, `${c.headline ?? ""}\n${c.summary ?? ""}\n${c.body ?? ""}`,
  ]));

  const rows: ComparisonRow[] = [];

  // 数字：按数值比，不按写法比（1,500 / 1.500 / 1500 是同一个数）
  const masterNums = [...numberSet(masterText, "EN_US")].sort((a, b) => b - a).slice(0, 24);
  const numSets = new Map(others.map((c) => [c.locale, numberSet(texts.get(c.locale) ?? "", LANG_OF[c.locale])]));
  for (const n of masterNums) {
    rows.push({
      dimension: "NUMBER", master: String(n),
      present: Object.fromEntries(others.map((c) => [c.locale, numSets.get(c.locale)!.has(n)])),
    });
  }

  const masterDates = [...dateKeys(masterText)].sort().slice(0, 16);
  const dateSets = new Map(others.map((c) => [c.locale, dateKeys(texts.get(c.locale) ?? "")]));
  for (const d of masterDates) {
    rows.push({
      dimension: "DATE", master: d,
      present: Object.fromEntries(others.map((c) => [c.locale, dateSets.get(c.locale)!.has(d)])),
    });
  }

  // 模型/版本号必须逐字出现 —— 翻译不该把 GPT-5.6 写成别的写法
  const masterModels = [...new Set(modelTokens(masterText))].slice(0, 16);
  for (const m of masterModels) {
    rows.push({
      dimension: "MODEL", master: m,
      present: Object.fromEntries(others.map((c) => [
        c.locale, (texts.get(c.locale) ?? "").toLowerCase().includes(m.toLowerCase()),
      ])),
    });
  }

  const masterEntities = [...new Set(properTokens(masterText))].slice(0, 20);
  for (const e of masterEntities) {
    rows.push({
      dimension: "ENTITY", master: e,
      present: Object.fromEntries(others.map((c) => [
        c.locale, (texts.get(c.locale) ?? "").toLowerCase().includes(e.toLowerCase()),
      ])),
    });
  }

  return rows;
}

async function loadSource(row: QueueRow): Promise<FamilyDetail["source"]> {
  // 外键已经随行带过来了 —— 不再为了读三个 id 多跑一趟远程查询
  const fam = {
    selected_item_id: row.selectedItemId,
    hot_topic_snapshot_id: row.hotTopicSnapshotId,
    daily_report_id: row.dailyReportId,
  };

  if (fam.selected_item_id) {
    const s = await prisma.aihotSelectedItem.findUnique({ where: { id: fam.selected_item_id } });
    if (!s) return null;
    const facts: SourceFact[] = [];
    if (s.source_name) facts.push({ label: "原始来源", value: s.source_name, volatile: false });
    if (s.category) facts.push({ label: "AI HOT 分类", value: s.category, volatile: false });
    if (s.score !== null) facts.push({ label: "AI HOT 评分", value: String(s.score), volatile: true });
    if (s.published_at) facts.push({ label: "发布时间", value: s.published_at.toISOString(), volatile: false });
    if (s.original_title) facts.push({ label: "原标题", value: s.original_title, volatile: false });
    return {
      kind: "SELECTED", title: s.title, summary: s.summary,
      facts, sourceNames: s.source_name ? [s.source_name] : [],
      aihotUrl: s.aihot_url, originalUrl: s.original_url,
      snapshotHash: s.source_snapshot_hash, capturedAt: s.last_seen_at, sectionLabels: [],
    };
  }

  if (fam.hot_topic_snapshot_id) {
    const t = await prisma.aihotHotTopicSnapshot.findUnique({ where: { id: fam.hot_topic_snapshot_id } });
    if (!t) return null;
    const names = Array.isArray(t.source_names_json) ? (t.source_names_json as string[]) : [];
    const facts: SourceFact[] = [];
    // 名次标 volatile：它变了只更新榜单卡片，不触发重写
    if (t.rank !== null) facts.push({ label: "榜单名次", value: String(t.rank), volatile: true });
    if (t.source_count !== null) facts.push({ label: "涉及来源数", value: String(t.source_count), volatile: false });
    if (t.signal_count !== null) facts.push({ label: "信号条数", value: String(t.signal_count), volatile: false });
    if (names.length) facts.push({ label: "来源名单", value: names.join("、"), volatile: false });
    if (t.source_name) facts.push({ label: "代表来源", value: t.source_name, volatile: false });
    if (t.latest_at) facts.push({ label: "榜单最近更新", value: t.latest_at.toISOString(), volatile: false });
    facts.push({ label: "抓取时间", value: t.captured_at.toISOString(), volatile: false });
    return {
      kind: "HOT_TOPIC", title: t.title, summary: t.summary, facts, sourceNames: names,
      aihotUrl: t.aihot_url, originalUrl: t.original_url,
      snapshotHash: t.source_snapshot_hash, capturedAt: t.captured_at, sectionLabels: [],
    };
  }

  if (fam.daily_report_id) {
    const d = await prisma.aihotDailyReport.findUnique({ where: { id: fam.daily_report_id } });
    if (!d) return null;
    const sections = (Array.isArray(d.sections_json) ? d.sections_json : []) as unknown as
      { order: number; label: string | null; items: unknown[] }[];
    const ordered = [...sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const facts: SourceFact[] = [
      { label: "日报日期", value: d.report_date, volatile: false },
      { label: "栏目数", value: String(ordered.length), volatile: false },
      { label: "条目数", value: String(ordered.reduce((n, s) => n + (s.items?.length ?? 0), 0)), volatile: false },
    ];
    if (d.generated_at) facts.push({ label: "生成时间", value: d.generated_at.toISOString(), volatile: false });
    return {
      kind: "DAILY", title: d.title ?? `AI HOT Daily ${d.report_date}`, summary: d.summary,
      facts, sourceNames: [], aihotUrl: d.aihot_url, originalUrl: null,
      snapshotHash: d.source_snapshot_hash, capturedAt: d.captured_at,
      sectionLabels: ordered.map((s, i) => `${i + 1}. ${s.label ?? "（无标题栏目）"}`),
    };
  }
  return null;
}

export async function familyDetail(familyId: number): Promise<FamilyDetail | null> {
  // 只查这一个 family —— 以前是把全部家族拉回来再 find，
  // 每打开一次详情就重跑一遍全量深层嵌套查询
  const row = (await loadRows({ id: familyId }, 1))[0];
  if (!row) return null;

  const revIds = row.locales.map((l) => l.currentRevisionId).filter((x): x is number => x !== null);
  const revs = revIds.length
    ? await prisma.articleRevision.findMany({ where: { id: { in: revIds } } })
    : [];
  const revById = new Map(revs.map((r) => [r.id, r]));

  const contents: LocaleContent[] = row.locales.map((l) => {
    const rev = l.currentRevisionId ? revById.get(l.currentRevisionId) : undefined;
    const body = rev?.body ?? null;
    return {
      ...l,
      headline: rev?.headline ?? null,
      summary: rev?.summary ?? null,
      body,
      sections: deriveSections(body),
      targetPath: publicPath({
        locale: l.locale, contentForm: row.contentForm, slug: row.slug, reportDate: row.reportDate,
      }),
    };
  });

  return { row, source: await loadSource(row), contents, comparison: buildComparison(contents) };
}

/** 母版正文里出现过、但译文一个都没有的 token —— 供 UI 直接高亮 */
export function missingInAll(comparison: ComparisonRow[]): ComparisonRow[] {
  return comparison.filter((r) => Object.values(r.present).every((v) => !v));
}

export { numberTokens };
