import { Prisma, type AihotTaskStatus, type AihotTaskType } from "@prisma/client";

import { generateUnit, type GenerateUnitResult } from "@/lib/content/multilingual/generate";
import { autoReviewFamily, type AutoReviewResult } from "@/lib/content/publishing/auto-review";
import { latestSnapshotIds, hotTopicUnitKey } from "@/lib/content/publishing/eligibility";
import { freezeUnit, type FreezeResult } from "@/lib/content/publishing/freeze";
import { publishFamily, type PublishFamilyResult } from "@/lib/content/publishing/publish";
import { prisma } from "@/lib/prisma";

import type { AihotRetryEvent, AihotTransport } from "./client";
import { ingestDaily, ingestHotTopics, type IngestResult } from "./ingest";
import { ingestItemsAll, syncSelected } from "./sync";
import { acquireLease, LEASE_TTL_MS, newWorkerId, releaseLease, startHeartbeat } from "./lease";
import { ML_GENERATION_VERSION } from "./types";

/**
 * AI HOT 三类内容的定时运营。
 *
 * 一轮做六件事，**只做这六件**：
 *   取 → 生成四语言草稿 → 冻结成 revision → 自动审核 → 通过则发布 → 记审计。
 *
 * 明确不做：改已发布内容、删旧 revision、调 event clustering、
 * 建 AIEvent、外部事实核查。
 *
 * **「不自动发布」这条约束已经被产品决定取消了**（改为「AI 自动审核发布，
 * 人工可复核撤下」）。但那道对账没有跟着删掉，只是换了口径：
 * 本轮新增的发布数必须等于本轮**有意**发布的条数。
 * 对不上说明有别的路径在写发布记录 —— 照样硬失败。
 * 把对账整条删掉，等于把「发布只能从这一条路走」这件事变成无人看守。
 *
 * 三类**各自独立**：独立租约、独立审计、独立失败。
 * 热点接口挂了不该让日报也停摆 —— 那会把一次上游抖动放大成全线停更。
 */

/**
 * 各类内容的抓取节奏。
 *
 * **四条错峰**，不都压在整点：同时起跑会四个任务一起抢连接池，
 * 而它们各自都要跑生成，慢的那个会把快的堵住。
 * 分钟位错开就够了 —— 它们本来也不需要精确对齐。
 */
export const TASK_SCHEDULE: Record<AihotTaskType, { cron: string; everyMs: number; label: string }> = {
  HOT_TOPICS: { cron: "5 */6 * * *", everyMs: 6 * 60 * 60_000, label: "当前热点" },
  SELECTED: { cron: "25 */12 * * *", everyMs: 12 * 60 * 60_000, label: "精选资讯" },
  // 日报一天一期，早上七点半取当天的
  DAILY: { cron: "45 7 * * *", everyMs: 24 * 60 * 60_000, label: "AI 日报" },
  /*
   * 未筛选流没有增量契约，只能整段重取，而且只覆盖最近 window ——
   * 掉出窗口的条目就永远补不回来了。所以它必须**在窗口内**定期跑。
   * 每 6 小时一次、取 24h 窗口：既远小于 7 天的窗口上限（漏不掉），
   * 又不至于每半小时把两千条重扫一遍。
   *
   * 它不在「热点 6h / 精选 12h / 日报 24h」那三条里 —— 那三条是产品节奏，
   * 这条是接口契约给死的：拖长了就会真的丢数据。
   */
  ITEMS_ALL: { cron: "17 */6 * * *", everyMs: 6 * 60 * 60_000, label: "未筛选条目流" },
};

export const ALL_TASKS: AihotTaskType[] = ["HOT_TOPICS", "SELECTED", "DAILY", "ITEMS_ALL"];

/**
 * 单轮生成上限。
 *
 * 不设上限的批处理会在源端一次性放出大量新内容时把 provider 预算烧穿，
 * 而且那一轮会长到超过租约。剩下的留给下一轮，反正调度本来就在转。
 *
 * **节奏放慢之后这个数字的含义变了。** 以前精选每 10 分钟一轮，
 * 8 条/轮 等于一天一千多条的产能，实际上「有多少做多少」；
 * 现在 12 小时一轮，8 条/轮 就是一天 16 条 —— 而源端每天新增约 300 条精选，
 * 队列会永远追不上，越积越多。
 *
 * 所以上限跟着节奏一起抬。**但不抬到「全做」**：那是每天 300 条 × 四种语言
 * = 1200 个页面、约 1500 次 provider 调用，这笔账该由人来定，不该由默认值替人定。
 * 想放开就调 AIHOT_MAX_UNITS_*，不必改代码。
 */
const BASE_MAX_UNITS: Record<AihotTaskType, number> = {
  // 榜单本来就只有 10 条，取满即全覆盖
  HOT_TOPICS: 10,
  // 12 小时一轮 × 40 = 每天 80 条，约占源端新增量的四分之一
  SELECTED: 40,
  // 一天一期，留 2 条余量给补跑昨天
  DAILY: 2,
  // 未筛选流只入库，不出稿 —— 那些条目 AI HOT 自己都没选中
  ITEMS_ALL: 0,
};

function maxUnitsFor(taskType: AihotTaskType): number {
  const raw = process.env[`AIHOT_MAX_UNITS_${taskType}`];
  const n = Number(raw);
  // 0 是合法值（等于「只入库不出稿」），所以判的是有限数而不是真值
  return raw !== undefined && Number.isFinite(n) && n >= 0 ? Math.floor(n) : BASE_MAX_UNITS[taskType];
}

/**
 * 失败单元的冷却期。
 *
 * 有些单元会**稳定地**过不了忠实度 QA —— 比如信源摘要里点名了发布者，
 * 模型每次都照抄进正文，归因检查每次都拦下。输入不变的情况下重跑
 * 只是把同一份失败重演一遍。
 *
 * 没有这道冷却，调度会为同一个卡住的单元反复烧 provider 调用，
 * 而且它会一直排在候选队首，把真正的新内容挤掉。
 * 冷却期内跳过；输入一变（指纹变了）立刻重新入选，不受冷却影响。
 *
 * 冷却期要**长于最短的抓取间隔**，否则每一轮都会把上一轮的失败重演一遍，
 * 这道闸门就形同虚设。现在最短是热点的 6 小时，所以取 24 小时：
 * 卡住的单元一天重试一次，够了。
 */
const FAILURE_COOLDOWN_MS = 24 * 60 * 60_000;

/**
 * 精选内容的生成时效窗口。
 *
 * 库里有三千多条历史精选（全量回填的结果）。它们**该留着** ——
 * 热点的关联匹配、追溯、后台按需生成都要用。但它们不该被自动排队生成：
 * 三千条 × 每条约 5 次 provider 调用，是一笔没人批准过的开销，
 * 而且几个月前的条目也早就不是「资讯」了。
 *
 * 自动链路只覆盖这个窗口内的新内容；更早的历史条目要出稿，
 * 由人在审核台上显式触发。
 */
const SELECTED_RECENCY_MS = 7 * 24 * 60 * 60_000;

export type ScheduledRunOptions = {
  workerId?: string;
  /** 只取不写、不调用 provider */
  dryRun?: boolean;
  transport?: AihotTransport;
  wait?: (ms: number) => Promise<void>;
  ignoreEtag?: boolean;
  maxUnits?: number;
  /** 失败冷却期；设为 0 表示立刻重试（手工重跑时用） */
  failureCooldownMs?: number;
  generationVersion?: string;
  /** 注入生成/冻结/审核/发布，离线测试用；不注入则用真实实现 */
  generate?: (args: { kind: "SELECTED" | "HOT_TOPIC" | "DAILY"; id: number }) => Promise<GenerateUnitResult>;
  freeze?: (unitKey: string) => Promise<FreezeResult>;
  autoReview?: (familyId: number) => Promise<AutoReviewResult>;
  publish?: (familyId: number) => Promise<PublishFamilyResult>;
  /**
   * 关掉自动审核与发布，只到「冻结入队」为止。
   *
   * 保留这个开关不是为了对称：出事的时候需要一个不改代码就能
   * 让链路停止对外发布、但继续攒稿的位置。
   * 环境变量 AIHOT_AUTO_PUBLISH=off 是同一个开关的运维入口。
   */
  autoPublish?: boolean;
  leaseTtlMs?: number;
  heartbeatMs?: number;
};

/** 自动发布的运维开关。设成 off/0/false/no 即只生成、不发布 */
export function autoPublishEnabled(): boolean {
  const raw = (process.env.AIHOT_AUTO_PUBLISH ?? "").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(raw);
}

export type UnitDetail = {
  unitKey: string;
  generateStatus: string;
  providerCalls: number;
  drafted: number;
  qaFailed: number;
  freezeStatus: string | null;
  revisionsCreated: number;
  familyId: number | null;
  /** 自动审核结论；未走到审核这一步时为 null */
  autoReview: string | null;
  /** 未通过时的第一条理由，供审计里直接看出为什么没发 */
  autoReviewReason: string | null;
  publishStatus: string | null;
  published: number;
};

export type ScheduledRunResult = {
  runId: number | null;
  taskType: AihotTaskType;
  status: AihotTaskStatus;
  leaseConflict: boolean;
  durationMs: number;
  endpoint: string | null;
  fetched: number;
  created: number;
  updated: number;
  reused: number;
  notModified: number;
  rateLimited: number;
  serverError: number;
  providerCalls: number;
  unitsConsidered: number;
  unitsGenerated: number;
  unitsReused: number;
  translationsDrafted: number;
  qaPassed: number;
  qaFailed: number;
  familiesTouched: number;
  revisionsCreated: number;
  queuedForReview: number;
  autoReviewed: number;
  autoApproved: number;
  autoBlocked: number;
  llmVetoed: number;
  /** 本轮**有意**发布的条数。与 publicationsCreated 对账 */
  publicationsIntended: number;
  publicationsCreated: number;
  errorCode: string | null;
  message: string | null;
  details: UnitDetail[];
};

const KIND_OF: Record<AihotTaskType, "SELECTED" | "HOT_TOPIC" | "DAILY"> = {
  SELECTED: "SELECTED", HOT_TOPICS: "HOT_TOPIC", DAILY: "DAILY",
  // 只入库不出稿，这个映射用不到；给一个值只为类型完整
  ITEMS_ALL: "SELECTED",
};

// ── 候选单元 ──────────────────────────────────────────────────────────────

/**
 * 已经「做完」的单元：四种语言齐、全部 DRAFTED、且来源指纹与当前一致。
 *
 * 这只是**预筛**，省掉明显不用干的活；最终判断仍由 generateUnit 的
 * 输入哈希做（它比对的是完整输入，不只是来源指纹）。
 */
async function completedUnits(version: string): Promise<Map<string, string>> {
  const drafts = await prisma.multilingualDraft.findMany({
    where: { generation_version: version },
    select: { unit_key: true, language: true, status: true, source_snapshot_hash: true },
  });
  const byUnit = new Map<string, typeof drafts>();
  for (const d of drafts) byUnit.set(d.unit_key, [...(byUnit.get(d.unit_key) ?? []), d]);

  const done = new Map<string, string>();
  for (const [unitKey, ds] of byUnit) {
    const langs = new Set(ds.map((d) => d.language));
    if (langs.size !== 4) continue;
    if (!ds.every((d) => d.status === "DRAFTED")) continue;
    const hashes = new Set(ds.map((d) => d.source_snapshot_hash));
    if (hashes.size !== 1) continue;
    done.set(unitKey, [...hashes][0]);
  }
  return done;
}

/**
 * 冷却中的单元：**同一份输入**刚失败过，还没到重试时间。
 *
 * 键是 `unitKey|sourceSnapshotHash` —— 输入变了就是另一回事，
 * 新指纹自然不在这张表里，会立刻重新入选。
 */
async function coolingDown(version: string, now: Date, cooldownMs: number): Promise<Set<string>> {
  const since = new Date(now.getTime() - cooldownMs);
  const failed = await prisma.multilingualDraft.findMany({
    where: {
      generation_version: version,
      status: { in: ["QA_FAILED", "GENERATION_FAILED"] },
      updated_at: { gte: since },
    },
    select: { unit_key: true, source_snapshot_hash: true },
  });
  return new Set(failed.map((d) => `${d.unit_key}|${d.source_snapshot_hash}`));
}

type Candidate = { id: number; unitKey: string };

type Pick = { id: number; unitKey: string; hash: string };

function filterCandidates(
  rows: Pick[], done: Map<string, string>, cooling: Set<string>, max: number
): Candidate[] {
  const out: Candidate[] = [];
  for (const r of rows) {
    // 同一份输入已经四语言成稿 —— 不重跑（名次变化不改指纹，所以不会走到这里）
    if (done.get(r.unitKey) === r.hash) continue;
    // 同一份输入刚失败过 —— 冷却期内不重烧 provider
    if (cooling.has(`${r.unitKey}|${r.hash}`)) continue;
    out.push({ id: r.id, unitKey: r.unitKey });
    if (out.length >= max) break;
  }
  return out;
}

async function candidatesFor(
  taskType: AihotTaskType, version: string, max: number, cooldownMs: number
): Promise<Candidate[]> {
  const done = await completedUnits(version);
  const cooling = await coolingDown(version, new Date(), cooldownMs);

  if (taskType === "SELECTED") {
    const rows = await prisma.aihotSelectedItem.findMany({
      where: {
        // 已取消精选的不再出稿
        selected: true,
        // 只覆盖时效窗口内的新内容；历史条目留库，但要出稿得人工触发
        published_at: { gte: new Date(Date.now() - SELECTED_RECENCY_MS) },
      },
      orderBy: [{ published_at: "desc" }, { id: "desc" }],
      take: Math.max(max * 5, 50),
      select: { id: true, provider_item_id: true, source_snapshot_hash: true },
    });
    return filterCandidates(
      rows.map((r) => ({ id: r.id, unitKey: `selected:${r.provider_item_id}`, hash: r.source_snapshot_hash })),
      done, cooling, max
    );
  }

  // 未筛选流不出稿：那些条目 AI HOT 自己没选中，我们也不替它做这个判断
  if (taskType === "ITEMS_ALL") return [];

  if (taskType === "HOT_TOPICS") {
    const ids = await latestSnapshotIds();
    const rows = await prisma.aihotHotTopicSnapshot.findMany({
      where: { id: { in: ids } },
      orderBy: [{ rank: "asc" }, { id: "desc" }],
      select: { id: true, topic_id: true, source_snapshot_hash: true },
    });
    return filterCandidates(
      rows.map((r) => ({ id: r.id, unitKey: hotTopicUnitKey(r.topic_id), hash: r.source_snapshot_hash })),
      done, cooling, max
    );
  }

  const rows = await prisma.aihotDailyReport.findMany({
    orderBy: { report_date: "desc" },
    take: Math.max(max, 3),
    select: { id: true, report_date: true, source_snapshot_hash: true },
  });
  return filterCandidates(
    rows.map((r) => ({ id: r.id, unitKey: `daily:${r.report_date}`, hash: r.source_snapshot_hash })),
    done, cooling, max
  );
}

/**
 * 审核出异常时按「没通过」处理，并且不把异常抛出去。
 *
 * 方向很重要：审核这一步坏掉 → **不发布**。
 * 反过来（异常时放行）会让「审核挂了」变成「什么都不审直接发」——
 * 那正是这道闸门存在的意义所在。
 * 同时它也不能把整轮带走：一个 family 审不动，另外几十个还得继续。
 */
async function reviewSafely(
  review: (familyId: number) => Promise<AutoReviewResult>, familyId: number
): Promise<AutoReviewResult> {
  try {
    return await review(familyId);
  } catch (e) {
    return {
      familyId, unitKey: "", status: "BLOCKED", locales: [],
      llm: { ran: false, verdict: "UNAVAILABLE", issues: [], message: null, providerCalls: 0 },
      providerCalls: 0,
      message: `自动审核异常，按未通过处理：${e instanceof Error ? e.message.slice(0, 200) : "未知错误"}`,
    };
  }
}

// ── 一轮运行 ──────────────────────────────────────────────────────────────

const empty = (taskType: AihotTaskType): ScheduledRunResult => ({
  runId: null, taskType, status: "FAILED", leaseConflict: false, durationMs: 0, endpoint: null,
  fetched: 0, created: 0, updated: 0, reused: 0, notModified: 0, rateLimited: 0, serverError: 0,
  providerCalls: 0, unitsConsidered: 0, unitsGenerated: 0, unitsReused: 0,
  translationsDrafted: 0, qaPassed: 0, qaFailed: 0,
  familiesTouched: 0, revisionsCreated: 0, queuedForReview: 0,
  autoReviewed: 0, autoApproved: 0, autoBlocked: 0, llmVetoed: 0,
  publicationsIntended: 0, publicationsCreated: 0,
  errorCode: null, message: null, details: [],
});

/**
 * 跑一轮。**永不抛异常** —— 抛出去就会把同一个 cron tick 里的其它任务一起带走，
 * 而三类任务本来就该互不影响。所有失败都变成 FAILED 的审计行。
 */
export async function runScheduledTask(
  taskType: AihotTaskType, opts: ScheduledRunOptions = {}
): Promise<ScheduledRunResult> {
  const startedAt = Date.now();
  const workerId = opts.workerId ?? newWorkerId();
  const version = opts.generationVersion ?? ML_GENERATION_VERSION;
  const maxUnits = opts.maxUnits ?? maxUnitsFor(taskType);
  const out = empty(taskType);

  // ── 租约 ──
  const lease = await acquireLease(taskType, workerId, opts.leaseTtlMs);
  if (!lease.ok) {
    const run = await prisma.aihotTaskRun.create({
      data: {
        task_type: taskType, worker_id: workerId, status: "SKIPPED_LOCKED",
        lease_conflict: true, finished_at: new Date(), duration_ms: Date.now() - startedAt,
        message: `同类任务正在运行（持有者 ${lease.heldBy ?? "?"}），本轮跳过`,
      },
    });
    return {
      ...out, runId: run.id, status: "SKIPPED_LOCKED", leaseConflict: true,
      durationMs: Date.now() - startedAt, message: run.message,
    };
  }

  /*
   * 回收上一次崩溃留下的 RUNNING 审计行。
   *
   * worker 被杀掉时租约会自然过期（TTL 兜底），但审计行会永远停在 RUNNING ——
   * 事后看审计分不清「还在跑」和「跑到一半没了」，
   * 而「上一轮到底成没成」正是这张表存在的唯一理由。
   *
   * 只回收**本任务类型**、且早于租约期的行：既然此刻租约在我们手里，
   * 那些行的 worker 一定已经不在了。
   */
  const orphanBefore = new Date(Date.now() - (opts.leaseTtlMs ?? LEASE_TTL_MS));
  const reaped = await prisma.aihotTaskRun.updateMany({
    where: { task_type: taskType, status: "RUNNING", started_at: { lt: orphanBefore } },
    data: {
      status: "FAILED", error_code: "WORKER_LOST", finished_at: new Date(),
      message: "worker 未正常收尾（进程退出或被终止），由后续运行回收",
    },
  });
  if (reaped.count) {
    console.log(`[aihot] ${taskType} 回收了 ${reaped.count} 条崩溃遗留的运行记录`);
  }

  const run = await prisma.aihotTaskRun.create({
    data: { task_type: taskType, worker_id: workerId, status: "RUNNING" },
  });
  out.runId = run.id;

  let leaseLost = false;
  const stopHeartbeat = startHeartbeat(
    taskType, workerId, () => { leaseLost = true; }, opts.heartbeatMs, opts.leaseTtlMs
  );

  // 「不自动发布」不是靠自觉：跑之前记下来，跑完对一遍
  const publicationsBefore = await prisma.articlePublication.count();

  try {
    // ── 1. 取 ──
    const observe = (ev: AihotRetryEvent) => {
      if (ev.kind === "rate_limited") out.rateLimited++;
      else if (ev.kind === "server_error") out.serverError++;
    };
    const fetchOpts = {
      dryRun: opts.dryRun, ignoreEtag: opts.ignoreEtag,
      transport: opts.transport, wait: opts.wait, observe,
    };

    let ingest: IngestResult;
    if (taskType === "SELECTED") {
      /*
       * 精选走**水位增量**，不再按「最近 24 小时」抓。
       *
       * 时间窗口有两个躲不掉的毛病：源端补录一条三天前的内容就永远看不到；
       * 而每轮都把窗口内的全部条目重取一遍，绝大多数是已经入库的。
       * 水位是流水账位置，只给「上次之后真正变化过的」，
       * 还能告诉我们哪些条目被取消了精选 —— 时间窗口表达不了「删除」。
       */
      const { result, bootstrapped } = await syncSelected(fetchOpts);
      /*
       * 水位查完一轮、一条变更都没有 —— 语义上就是「源端未变化」，
       * 与另外两类的 304 同义。记成 OK 会让审计里满屏「成功」，
       * 分不清哪一轮真的带回了东西。
       */
      const nothingChanged = result.status === "OK" && result.fetched === 0
        && result.created === 0 && result.updated === 0 && result.removed === 0;
      ingest = {
        endpoint: bootstrapped ? "/api/v1/selected/snapshot" : "/api/v1/selected/changes",
        status: result.status !== "OK" ? "FAILED" : nothingChanged ? "NOT_MODIFIED" : "OK",
        fetched: result.fetched,
        created: result.created,
        // 取消精选算一次内容变更，计入 updated（它确实改了库里的行）
        updated: result.updated + result.removed,
        unchanged: result.unchanged,
        skipped: [],
        message: bootstrapped
          ? `水位不可用，已自动回落全量快照（${result.pages} 页）${result.message ? ` — ${result.message}` : ""}`
          : result.message,
      };
    } else if (taskType === "ITEMS_ALL") {
      const r = await ingestItemsAll({ ...fetchOpts, window: "24h" });
      ingest = {
        endpoint: "/api/v1/items?mode=all",
        status: r.status,
        fetched: r.fetched, created: r.created, updated: r.updated, unchanged: r.unchanged,
        skipped: [],
        message: r.status === "OK"
          ? `${r.pages} 页 · 其中 AI HOT 已入选 ${r.selectedSeen} 条`
          : r.message,
      };
    } else if (taskType === "HOT_TOPICS") ingest = await ingestHotTopics(fetchOpts);
    else ingest = await ingestDaily(fetchOpts);

    out.endpoint = ingest.endpoint;
    out.fetched = ingest.fetched;
    out.created = ingest.created;
    out.updated = ingest.updated;
    out.reused = ingest.unchanged;

    if (ingest.status === "FAILED") {
      out.status = "FAILED";
      out.errorCode = "INGEST_FAILED";
      out.message = ingest.message ?? "抓取失败";
      return await finish(out, run.id, startedAt, publicationsBefore);
    }
    if (ingest.status === "NOT_MODIFIED") {
      out.notModified = 1;
      /*
       * 304 = 源端未变化 → **入库零写入**（ingest 已经保证了）。
       *
       * 但仍然继续走生成：库里可能还躺着上一轮没做完的单元
       * （QA 未过、语言不全、规则升版）。那些活的输入早就在库里，
       * 补做它们并不违反「零写入」—— 零写入约束的是抓取侧。
       */
    }

    if (opts.dryRun) {
      out.status = ingest.status === "NOT_MODIFIED" ? "NOT_MODIFIED" : "OK";
      out.message = "dry-run：未生成、未冻结";
      return await finish(out, run.id, startedAt, publicationsBefore);
    }

    // ── 2. 生成四语言草稿 ──
    const candidates = await candidatesFor(
      taskType, version, maxUnits, opts.failureCooldownMs ?? FAILURE_COOLDOWN_MS
    );
    out.unitsConsidered = candidates.length;

    const generate = opts.generate ?? ((a) => generateUnit({ ...a, generationVersion: version }));
    const freeze = opts.freeze ?? ((unitKey) => freezeUnit(unitKey, { generationVersion: version }));
    const autoReview = opts.autoReview ?? ((familyId: number) => autoReviewFamily(familyId));
    const publish = opts.publish ?? ((familyId: number) => publishFamily({ familyId }));
    const doPublish = (opts.autoPublish ?? autoPublishEnabled()) && !opts.dryRun;

    for (const c of candidates) {
      if (leaseLost) {
        out.errorCode = "LEASE_LOST";
        out.message = "租约已被接管，本轮提前收尾";
        break;
      }
      const g = await generate({ kind: KIND_OF[taskType], id: c.id });
      out.providerCalls += g.providerCalls;
      const drafted = g.languages.filter((l) => l.status === "DRAFTED").length;
      const failed = g.languages.filter((l) => l.status !== "DRAFTED").length;
      out.translationsDrafted += g.status === "EXISTING" ? 0 : drafted;
      out.qaPassed += drafted;
      out.qaFailed += failed;
      if (g.status === "EXISTING") out.unitsReused++;
      else if (g.status === "OK") out.unitsGenerated++;

      const detail: UnitDetail = {
        unitKey: g.unitKey, generateStatus: g.status, providerCalls: g.providerCalls,
        drafted, qaFailed: failed, freezeStatus: null, revisionsCreated: 0,
        familyId: null, autoReview: null, autoReviewReason: null, publishStatus: null, published: 0,
      };

      // ── 3. 冻结成 revision ──
      if (g.status === "OK" || g.status === "EXISTING") {
        const f = await freeze(g.unitKey);
        detail.freezeStatus = f.status;
        detail.revisionsCreated = f.created.length;
        detail.familyId = f.familyId;
        if (f.status === "OK") {
          out.familiesTouched++;
          out.revisionsCreated += f.created.length;
          if (f.created.length) out.queuedForReview++;
        }

        // ── 4. 自动审核 → 5. 通过才发布 ──
        if (doPublish && f.status === "OK" && f.familyId) {
          /*
           * **人撤下过的内容，自动链路不再自己送上去。**
           *
           * 没有这道判断，「取消上线」只能撑到下一次来源变动：
           * 源端一改，重新生成 → 自动审核 → 又发出去了。
           * 人做过的判断被一个定时任务无声地推翻，而且没人会知道。
           *
           * 但也不是永久封杀 —— 撤下的理由可能是一次性的。
           * 所以仍然生成、仍然审核、仍然进队列，只是**不自动发布**：
           * 要不要再上线，交回给人。
           */
          const everWithdrawn = await prisma.articlePublication.count({
            where: { status: "WITHDRAWN", translation: { family_id: f.familyId } },
          });
          if (everWithdrawn > 0) {
            detail.autoReview = "SKIPPED_WITHDRAWN";
            detail.autoReviewReason = "该内容被人工撤下过，需人工决定是否重新上线";
            out.details.push(detail);
            continue;
          }

          const r = await reviewSafely(autoReview, f.familyId);
          out.providerCalls += r.providerCalls;
          out.autoReviewed++;
          detail.autoReview = r.status;
          if (r.llm.verdict === "BLOCK") out.llmVetoed++;

          if (r.status === "APPROVED") {
            out.autoApproved++;
            /*
             * 先把「打算发几条」记下来，再真的去发。
             * 顺序反过来的话，发布过程中崩掉就会留下
             * 「发了但没记打算发」的审计行 —— 而那正好长得像一次越权发布。
             */
            const pre = out.publicationsIntended;
            const p = await publish(f.familyId);
            detail.publishStatus = p.ok ? "OK" : "BLOCKED";
            const newly = p.outcomes.filter((o) => o.status === "PUBLISHED").length;
            detail.published = newly;
            out.publicationsIntended = pre + newly;
            if (!p.ok && p.blocked.length) {
              detail.autoReviewReason = `发布被预检拦下：${p.blocked[0].code} ${p.blocked[0].detail}`.slice(0, 300);
            }
          } else {
            out.autoBlocked++;
            const firstFailure = r.locales.flatMap((l) => l.failures)[0];
            detail.autoReviewReason = firstFailure
              ? `${firstFailure.key}：${firstFailure.detail}`.slice(0, 300)
              : r.message;
          }
        }
      }
      out.details.push(detail);
    }

    out.status = out.errorCode === "LEASE_LOST" ? "FAILED"
      : ingest.status === "NOT_MODIFIED" ? "NOT_MODIFIED" : "OK";
    return await finish(out, run.id, startedAt, publicationsBefore);
  } catch (e) {
    out.status = "FAILED";
    out.errorCode = out.errorCode ?? "UNEXPECTED";
    // 不回显完整异常：上游报错可能带 requestId 之类的内部信息
    out.message = e instanceof Error ? e.message.slice(0, 300) : "任务异常";
    return await finish(out, run.id, startedAt, publicationsBefore);
  } finally {
    stopHeartbeat();
    await releaseLease(taskType, workerId, out.status).catch(() => undefined);
  }
}

async function finish(
  out: ScheduledRunResult, runId: number, startedAt: number, publicationsBefore: number
): Promise<ScheduledRunResult> {
  out.durationMs = Date.now() - startedAt;

  const publicationsAfter = await prisma.articlePublication.count().catch(() => publicationsBefore);
  out.publicationsCreated = publicationsAfter - publicationsBefore;
  if (out.publicationsCreated !== out.publicationsIntended) {
    /*
     * 发布记录的增量对不上本轮**有意**发布的条数。
     *
     * 产品规则从「定时任务一律不得发布」改成了「自动审核通过即发布」，
     * 但对账没有取消，只是换了口径：多出来的那些是**没经过这条链路**
     * 写进去的发布记录 —— 要么有第二条发布路径，要么并发的另一个 worker
     * 在同时发（租约本该挡住它）。
     *
     * 如实记成失败，不做「大概是别的进程」这种猜测：
     * 报警宁可多响一次，也不能把绕过审核的发布解释过去。
     */
    out.status = "FAILED";
    out.errorCode = "UNEXPECTED_PUBLICATION";
    out.message = `本轮发布记录 +${out.publicationsCreated}，但有意发布 ${out.publicationsIntended} 条，差额 ${out.publicationsCreated - out.publicationsIntended} 条来路不明`;
  }

  await prisma.aihotTaskRun.update({
    where: { id: runId },
    data: {
      status: out.status,
      finished_at: new Date(),
      duration_ms: out.durationMs,
      endpoint: out.endpoint,
      fetched: out.fetched, created: out.created, updated: out.updated,
      reused: out.reused, not_modified: out.notModified,
      rate_limited: out.rateLimited, server_error: out.serverError,
      provider_calls: out.providerCalls,
      units_considered: out.unitsConsidered, units_generated: out.unitsGenerated,
      units_reused: out.unitsReused, translations_drafted: out.translationsDrafted,
      qa_passed: out.qaPassed, qa_failed: out.qaFailed,
      families_touched: out.familiesTouched, revisions_created: out.revisionsCreated,
      queued_for_review: out.queuedForReview,
      auto_reviewed: out.autoReviewed, auto_approved: out.autoApproved,
      auto_blocked: out.autoBlocked, llm_vetoed: out.llmVetoed,
      publications_intended: out.publicationsIntended,
      publications_created: out.publicationsCreated,
      lease_conflict: out.leaseConflict,
      error_code: out.errorCode, message: out.message,
      detail_json: out.details as unknown as Prisma.InputJsonValue,
    },
  }).catch(() => undefined);

  return out;
}

/**
 * 依次跑全部三类。
 *
 * **一类失败不影响另外两类** —— 每一类都各自 catch 到底，
 * 循环本身不可能因为某一类而中断。
 */
export async function runAllScheduledTasks(
  opts: ScheduledRunOptions = {}
): Promise<ScheduledRunResult[]> {
  const out: ScheduledRunResult[] = [];
  for (const t of ALL_TASKS) {
    try {
      out.push(await runScheduledTask(t, opts));
    } catch (e) {
      out.push({
        ...empty(t), status: "FAILED", errorCode: "UNEXPECTED",
        message: e instanceof Error ? e.message.slice(0, 200) : "任务异常",
      });
    }
  }
  return out;
}

/** 最近若干轮的运行审计 */
export async function recentRuns(taskType?: AihotTaskType, limit = 20) {
  return prisma.aihotTaskRun.findMany({
    where: taskType ? { task_type: taskType } : undefined,
    orderBy: { started_at: "desc" },
    take: limit,
  });
}
