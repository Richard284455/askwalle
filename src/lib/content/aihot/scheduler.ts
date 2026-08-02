import { Prisma, type AihotTaskStatus, type AihotTaskType } from "@prisma/client";

import { generateUnit, type GenerateUnitResult } from "@/lib/content/multilingual/generate";
import { latestSnapshotIds, hotTopicUnitKey } from "@/lib/content/publishing/eligibility";
import { freezeUnit, type FreezeResult } from "@/lib/content/publishing/freeze";
import { prisma } from "@/lib/prisma";

import type { AihotRetryEvent, AihotTransport } from "./client";
import { ingestDaily, ingestHotTopics, ingestSelected, type IngestResult } from "./ingest";
import { acquireLease, LEASE_TTL_MS, newWorkerId, releaseLease, startHeartbeat } from "./lease";
import { ML_GENERATION_VERSION } from "./types";

/**
 * AI HOT 三类内容的定时运营。
 *
 * 一轮做四件事，**只做这四件**：
 *   取 → 生成四语言草稿 → 冻结成 revision → 进审核队列。
 *
 * 明确不做：审核、批准、发布、改已发布内容、删旧 revision、
 * 调 event clustering、建 AIEvent、外部事实核查。
 * 「不发布」不是靠自觉：每一轮跑完都会核对发布记录数，变了就是硬失败。
 *
 * 三类**各自独立**：独立租约、独立审计、独立失败。
 * 热点接口挂了不该让日报也停摆 —— 那会把一次上游抖动放大成全线停更。
 */

export const TASK_SCHEDULE: Record<AihotTaskType, { cron: string; everyMs: number; label: string }> = {
  // 热点变化最快，查得最勤；日报一天一期，半小时看一次已经绰绰有余
  HOT_TOPICS: { cron: "*/5 * * * *", everyMs: 5 * 60_000, label: "当前热点" },
  SELECTED: { cron: "*/10 * * * *", everyMs: 10 * 60_000, label: "精选资讯" },
  DAILY: { cron: "*/30 * * * *", everyMs: 30 * 60_000, label: "AI 日报" },
};

export const ALL_TASKS: AihotTaskType[] = ["HOT_TOPICS", "SELECTED", "DAILY"];

/**
 * 单轮生成上限。
 *
 * 不设上限的批处理会在源端一次性放出大量新内容时把 provider 预算烧穿，
 * 而且那一轮会长到超过租约。剩下的留给下一轮，反正调度本来就在转。
 */
const DEFAULT_MAX_UNITS: Record<AihotTaskType, number> = {
  HOT_TOPICS: 10,
  SELECTED: 8,
  DAILY: 2,
};

/**
 * 失败单元的冷却期。
 *
 * 有些单元会**稳定地**过不了忠实度 QA —— 比如信源摘要里点名了发布者，
 * 模型每次都照抄进正文，归因检查每次都拦下。输入不变的情况下重跑
 * 只是把同一份失败重演一遍。
 *
 * 没有这道冷却，调度会每 10 分钟为同一个卡住的单元烧 2 次 provider 调用，
 * 一天就是近三百次 —— 而且它会一直排在候选队首，把真正的新内容挤掉。
 * 冷却期内跳过；输入一变（指纹变了）立刻重新入选，不受冷却影响。
 */
const FAILURE_COOLDOWN_MS = 6 * 60 * 60_000;

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
  /** 注入生成/冻结，离线测试用；不注入则用真实实现 */
  generate?: (args: { kind: "SELECTED" | "HOT_TOPIC" | "DAILY"; id: number }) => Promise<GenerateUnitResult>;
  freeze?: (unitKey: string) => Promise<FreezeResult>;
  leaseTtlMs?: number;
  heartbeatMs?: number;
};

export type UnitDetail = {
  unitKey: string;
  generateStatus: string;
  providerCalls: number;
  drafted: number;
  qaFailed: number;
  freezeStatus: string | null;
  revisionsCreated: number;
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
  publicationsCreated: number;
  errorCode: string | null;
  message: string | null;
  details: UnitDetail[];
};

const KIND_OF: Record<AihotTaskType, "SELECTED" | "HOT_TOPIC" | "DAILY"> = {
  SELECTED: "SELECTED", HOT_TOPICS: "HOT_TOPIC", DAILY: "DAILY",
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
      orderBy: [{ published_at: "desc" }, { id: "desc" }],
      take: Math.max(max * 5, 50),
      select: { id: true, provider_item_id: true, source_snapshot_hash: true },
    });
    return filterCandidates(
      rows.map((r) => ({ id: r.id, unitKey: `selected:${r.provider_item_id}`, hash: r.source_snapshot_hash })),
      done, cooling, max
    );
  }

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

// ── 一轮运行 ──────────────────────────────────────────────────────────────

const empty = (taskType: AihotTaskType): ScheduledRunResult => ({
  runId: null, taskType, status: "FAILED", leaseConflict: false, durationMs: 0, endpoint: null,
  fetched: 0, created: 0, updated: 0, reused: 0, notModified: 0, rateLimited: 0, serverError: 0,
  providerCalls: 0, unitsConsidered: 0, unitsGenerated: 0, unitsReused: 0,
  translationsDrafted: 0, qaPassed: 0, qaFailed: 0,
  familiesTouched: 0, revisionsCreated: 0, queuedForReview: 0, publicationsCreated: 0,
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
  const maxUnits = opts.maxUnits ?? DEFAULT_MAX_UNITS[taskType];
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
    if (taskType === "SELECTED") ingest = await ingestSelected({ window: "24h", limit: 100, ...fetchOpts });
    else if (taskType === "HOT_TOPICS") ingest = await ingestHotTopics(fetchOpts);
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
      };

      // ── 3. 冻结成 revision，进审核队列 ──
      if (g.status === "OK" || g.status === "EXISTING") {
        const f = await freeze(g.unitKey);
        detail.freezeStatus = f.status;
        detail.revisionsCreated = f.created.length;
        if (f.status === "OK") {
          out.familiesTouched++;
          out.revisionsCreated += f.created.length;
          if (f.created.length) out.queuedForReview++;
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
  if (out.publicationsCreated !== 0) {
    /*
     * 定时任务写出了发布记录 —— 这条链路里没有任何代码路径应该做到这件事。
     * 如实记成失败，不做「大概是别的进程」这种猜测：
     * 报警宁可多响一次，也不能把自动发布这种事解释过去。
     */
    out.status = "FAILED";
    out.errorCode = "AUTO_PUBLICATION_DETECTED";
    out.message = `本轮期间发布记录变化 ${out.publicationsCreated} 条，定时任务不得发布`;
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
