import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { probeReachability, ProbeInput } from "@/lib/website/probe/reachability-probe";
import {
  applyRound,
  DebounceState,
  INITIAL_STATE,
  shanghaiDate,
} from "@/lib/website/probe/classifier";
import {
  ChangeFlag,
  ErrorFamily,
  ProbeResult,
  PROBE_VERSION,
  Reach,
  contentCheckIntervalDays,
  isContentCheckDue,
} from "@/lib/website/probe/types";
import { registrableDomainOf } from "@/lib/website/probe/registrable-domain";

/**
 * 生命周期服务层：一个 scheduled check round 的完整落地。
 *
 * P0a 的边界：只写 tool_lifecycle_states / tool_health_events 两张表。
 * **不碰** Website.status、不碰 Website.active、不碰公开页。
 */

// 探测按 tier 分层（契约 §2.2）
const CHECK_INTERVAL_DAYS: Record<string, number> = {
  featured: 7,
  featured_candidate: 14,
  standard: 30,
  longtail: 90,
};
const DEAD_RECHECK_DAYS = 30;
const UNVERIFIABLE_RECHECK_DAYS = 180;

// 同 registrable domain 的最小请求间隔（契约 §5.5 抓取礼仪）
const SAME_DOMAIN_MIN_INTERVAL_MS = 2_000;
const DOMAIN_CLOCK = Symbol.for("askwalle.probeDomainClock");
type ClockGlobal = typeof globalThis & { [DOMAIN_CLOCK]?: Map<string, number> };

function domainClock(): Map<string, number> {
  const g = globalThis as ClockGlobal;
  if (!g[DOMAIN_CLOCK]) g[DOMAIN_CLOCK] = new Map();
  return g[DOMAIN_CLOCK]!;
}

async function throttleSameDomain(url: string): Promise<void> {
  const domain = registrableDomainOf(url);
  if (!domain) return;
  const clock = domainClock();
  const last = clock.get(domain);
  const now = Date.now();
  if (last !== undefined) {
    const wait = SAME_DOMAIN_MIN_INTERVAL_MS - (now - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  clock.set(domain, Date.now());
}

function nextCheckDelayMs(tier: string, reach: Reach, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return retryAfterMs;
  if (reach === "dead") return DEAD_RECHECK_DAYS * 86_400_000;
  if (reach === "unverifiable") return UNVERIFIABLE_RECHECK_DAYS * 86_400_000;
  const days = CHECK_INTERVAL_DAYS[tier] ?? CHECK_INTERVAL_DAYS.standard;
  // ±10% 抖动，避免整批同时到期
  return days * 86_400_000 * (0.9 + Math.random() * 0.2);
}

export type RoundOutcome = {
  websiteId: number;
  outcome: string;
  reachFrom: Reach;
  reachTo: Reach;
  changeFlags: ChangeFlag[];
  eventId: number;
  versionMismatch?: boolean;
};

/** 取到期的工作集；无 state 的（新工具）视为立即到期 */
export async function selectDueWebsites(limit: number): Promise<number[]> {
  const due = await prisma.toolLifecycleState.findMany({
    where: { OR: [{ next_check_at: null }, { next_check_at: { lte: new Date() } }] },
    orderBy: [{ next_check_at: "asc" }, { website_id: "asc" }],
    take: limit,
    select: { website_id: true },
  });
  return due.map((d) => d.website_id);
}

function toDebounceState(row: {
  reach: string;
  reach_since: Date | null;
  consecutive_fails: number;
  distinct_fail_dates: number;
  first_fail_at: Date | null;
  last_fail_date: string | null;
  fail_family: string | null;
  last_error_kind: string | null;
  last_ok_at: Date | null;
  needs_manual_check: boolean;
  final_url: string | null;
} | null): DebounceState {
  if (!row) return INITIAL_STATE;
  return {
    reach: row.reach as Reach,
    reachSince: row.reach_since,
    consecutiveFails: row.consecutive_fails,
    distinctFailDates: row.distinct_fail_dates,
    firstFailAt: row.first_fail_at,
    lastFailDate: row.last_fail_date,
    failFamily: (row.fail_family as ErrorFamily | null) ?? null,
    lastErrorKind: row.last_error_kind,
    lastOkAt: row.last_ok_at,
    needsManualCheck: row.needs_manual_check,
    finalUrl: row.final_url,
  };
}

/**
 * 执行一轮 check round 并落库。
 *
 * 每一轮都写一条事件（契约修订 §1）：ok 存轻量证据，异常/状态变化存完整证据。
 * 这样任意历史轮次都能离线重放 —— 判定层是纯函数，喂回同样的证据必得同样结论。
 */
export async function runHealthCheckRound(
  websiteId: number,
  jobId: number | null,
  overrides: Partial<ProbeInput> = {}
): Promise<RoundOutcome> {
  const site = await prisma.website.findUnique({
    where: { id: websiteId },
    select: {
      id: true,
      url: true,
      title: true,
      category: { select: { name: true, slug: true } },
      lifecycleState: true,
    },
  });
  if (!site) throw new Error(`website #${websiteId} 不存在`);

  const state = toDebounceState(site.lifecycleState);
  const tier = site.lifecycleState?.tier ?? "standard";

  // 深度内容检查是否到期：从未做过一律为真，A8 首轮基线因此每个工具都会 GET 一次
  const forceContentCheck = isContentCheckDue(
    site.lifecycleState?.last_content_checked_at ?? null,
    tier
  );

  await throttleSameDomain(site.url);

  const isDomainCategory = /domain|建站|域名/i.test(
    `${site.category?.name ?? ""} ${site.category?.slug ?? ""}`
  );

  let probe: ProbeResult;
  try {
    probe = await probeReachability({
      url: site.url,
      title: site.title,
      isDomainCategory,
      forceContentCheck,
      ...overrides,
    });
  } catch (error) {
    // 探针自身异常：既不是站点的错，也不能当成功。按 unknown 记账，不影响 reach。
    probe = {
      probeVersion: PROBE_VERSION,
      outcome: "unknown",
      errorKind: null,
      errorFamily: null,
      evidenceStrength: null,
      confidence: "low",
      contentVerdict: null,
      finalStatus: null,
      finalUrl: null,
      latencyMs: 0,
      retryAfterMs: null,
      domainMigrated: false,
      unsafeReason: null,
      contentChecked: false,
      evidence: {
        probeVersion: PROBE_VERSION,
        requestedUrl: site.url,
        scheme: null, host: null, port: null,
        resolvedIps: [], pinnedIp: null, redirectChain: [], methodSequence: [],
        finalStatus: null, finalUrl: null, finalRegistrableDomain: null,
        headersSubset: {}, tlsError: null,
        networkError: error instanceof Error ? error.message.slice(0, 300) : "probe threw",
        bytesRead: 0, truncated: false, contentType: null, contentVerdict: null,
        visibleTextLen: 0, textBlockCount: 0, internalLinkCount: 0,
        titleExcerpt: null, h1Excerpt: null, matchedSignatures: [], weakSignals: [],
        exclusionsHit: [], robotsDecision: "allow", robotsRule: null,
        retryAfterSeconds: null, unsafeReason: null, nsRecords: null, nsLookupFailed: false,
        latency: { dnsMs: null, headMs: null, getMs: null, totalMs: 0 },
      },
    };
  }

  const at = new Date();
  const roundDate = shanghaiDate(at);
  const roundId = `${jobId ?? "manual"}:${websiteId}:${roundDate}`;

  const decision = applyRound(state, {
    outcome: probe.outcome,
    errorKind: probe.errorKind,
    errorFamily: probe.errorFamily,
    evidenceStrength: probe.evidenceStrength,
    confidence: probe.confidence,
    domainMigrated: probe.domainMigrated,
    finalUrl: probe.finalUrl,
    probeVersion: probe.probeVersion,
    at,
  });

  if (!decision.ok) {
    // 版本不匹配：只记事件，绝不静默混算进状态
    const event = await prisma.toolHealthEvent.create({
      data: {
        website_id: websiteId,
        round_id: roundId,
        probe_version: probe.probeVersion,
        job_id: jobId,
        round_date: roundDate,
        outcome: probe.outcome,
        error_kind: "version_mismatch",
        confidence: probe.confidence,
        change_flags: [],
        evidence: probe.evidence as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return {
      websiteId,
      outcome: probe.outcome,
      reachFrom: state.reach,
      reachTo: state.reach,
      changeFlags: [],
      eventId: event.id,
      versionMismatch: true,
    };
  }

  const next = decision.next;
  const anomaly = probe.outcome !== "ok" || decision.stateChanged || decision.changeFlags.length > 0;

  // 只有真的完成了正文分类才推进内容检查排期；
  // blocked / deferred / 网络失败都不算，否则会把「没看过」记成「看过了」
  const contentFields = probe.contentChecked
    ? {
        last_content_checked_at: at,
        next_content_check_at: new Date(
          at.getTime() + contentCheckIntervalDays(tier) * 86_400_000
        ),
      }
    : {};

  const [event] = await prisma.$transaction([
    prisma.toolHealthEvent.create({
      data: {
        website_id: websiteId,
        round_id: roundId,
        probe_version: probe.probeVersion,
        job_id: jobId,
        round_date: roundDate,
        outcome: probe.outcome,
        error_kind: probe.errorKind,
        error_family: probe.errorFamily,
        evidence_strength: probe.evidenceStrength,
        confidence: probe.confidence,
        change_flags: decision.changeFlags,
        reach_from: decision.reachFrom,
        reach_to: decision.reachTo,
        final_status: probe.finalStatus,
        final_url: probe.finalUrl,
        latency_ms: probe.latencyMs,
        content_verdict: probe.contentVerdict,
        // ok 轮次只存轻量字段；异常与状态变化存完整证据
        evidence: anomaly
          ? (probe.evidence as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
      },
      select: { id: true },
    }),
    prisma.toolLifecycleState.upsert({
      where: { website_id: websiteId },
      create: {
        website_id: websiteId,
        tier,
        reach: next.reach,
        reach_since: next.reachSince,
        last_ok_at: next.lastOkAt,
        last_checked_at: at,
        next_check_at: new Date(
          at.getTime() + nextCheckDelayMs(tier, next.reach, probe.retryAfterMs)
        ),
        consecutive_fails: next.consecutiveFails,
        distinct_fail_dates: next.distinctFailDates,
        first_fail_at: next.firstFailAt,
        last_fail_date: next.lastFailDate,
        fail_family: next.failFamily,
        last_error_kind: next.lastErrorKind,
        final_url: next.finalUrl,
        needs_manual_check: next.needsManualCheck,
        probe_version: probe.probeVersion,
        ...contentFields,
      },
      update: {
        reach: next.reach,
        reach_since: next.reachSince,
        last_ok_at: next.lastOkAt,
        last_checked_at: at,
        next_check_at: new Date(
          at.getTime() + nextCheckDelayMs(tier, next.reach, probe.retryAfterMs)
        ),
        consecutive_fails: next.consecutiveFails,
        distinct_fail_dates: next.distinctFailDates,
        first_fail_at: next.firstFailAt,
        last_fail_date: next.lastFailDate,
        fail_family: next.failFamily,
        last_error_kind: next.lastErrorKind,
        final_url: next.finalUrl,
        needs_manual_check: next.needsManualCheck,
        probe_version: probe.probeVersion,
        ...contentFields,
      },
    }),
  ]);

  return {
    websiteId,
    outcome: probe.outcome,
    reachFrom: decision.reachFrom,
    reachTo: decision.reachTo,
    changeFlags: decision.changeFlags,
    eventId: event.id,
  };
}

export type LifecycleStats = {
  ok: number;
  dead: number;
  unverifiable: number;
  unknown: number;
  needsManualCheck: number;
  neverChecked: number;
  dueNow: number;
};

export async function getLifecycleStats(): Promise<LifecycleStats> {
  const byReach = await prisma.toolLifecycleState.groupBy({
    by: ["reach"],
    _count: { _all: true },
  });
  const pick = (reach: string) =>
    byReach.find((r) => r.reach === reach)?._count._all ?? 0;

  const [needsManualCheck, neverChecked, dueNow] = await Promise.all([
    prisma.toolLifecycleState.count({ where: { needs_manual_check: true } }),
    prisma.toolLifecycleState.count({ where: { last_checked_at: null } }),
    prisma.toolLifecycleState.count({
      where: { OR: [{ next_check_at: null }, { next_check_at: { lte: new Date() } }] },
    }),
  ]);

  return {
    ok: pick("ok"),
    dead: pick("dead"),
    unverifiable: pick("unverifiable"),
    unknown: pick("unknown"),
    needsManualCheck,
    neverChecked,
    dueNow,
  };
}

// ---------------------------------------------------------------------------
// 只读查询（A7 观察页）
// ---------------------------------------------------------------------------

export type LifecycleListFilter = {
  reach?: string;
  errorKind?: string;
  tier?: string;
  needsManualCheck?: boolean;
  search?: string;
};

export type LifecycleListItem = {
  websiteId: number;
  title: string;
  slug: string | null;
  url: string;
  tier: string;
  reach: string;
  lastErrorKind: string | null;
  consecutiveFails: number;
  distinctFailDates: number;
  firstFailAt: string | null;
  lastOkAt: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  finalUrl: string | null;
  needsManualCheck: boolean;
};

export const LIFECYCLE_PAGE_SIZE_MAX = 200;

function lifecycleWhere(filter: LifecycleListFilter): Prisma.ToolLifecycleStateWhereInput {
  const where: Prisma.ToolLifecycleStateWhereInput = {};
  if (filter.reach) where.reach = filter.reach;
  if (filter.errorKind) where.last_error_kind = filter.errorKind;
  if (filter.tier) where.tier = filter.tier;
  if (filter.needsManualCheck) where.needs_manual_check = true;
  if (filter.search) {
    const q = filter.search.trim();
    where.website = {
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { slug: { contains: q, mode: "insensitive" } },
        { url: { contains: q, mode: "insensitive" } },
      ],
    };
  }
  return where;
}

export async function getLifecycleList(
  filter: LifecycleListFilter,
  pagination?: { page?: number; pageSize?: number }
): Promise<{ items: LifecycleListItem[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(pagination?.pageSize ?? 50, 1), LIFECYCLE_PAGE_SIZE_MAX);
  const page = Math.max(pagination?.page ?? 1, 1);
  const where = lifecycleWhere(filter);

  const total = await prisma.toolLifecycleState.count({ where });
  const rows = await prisma.toolLifecycleState.findMany({
    where,
    orderBy: [{ reach: "asc" }, { website_id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
    include: { website: { select: { title: true, slug: true, url: true } } },
  });

  return {
    total,
    page,
    pageSize,
    items: rows.map((row) => ({
      websiteId: row.website_id,
      title: row.website.title,
      slug: row.website.slug,
      url: row.website.url,
      tier: row.tier,
      reach: row.reach,
      lastErrorKind: row.last_error_kind,
      consecutiveFails: row.consecutive_fails,
      distinctFailDates: row.distinct_fail_dates,
      firstFailAt: row.first_fail_at?.toISOString() ?? null,
      lastOkAt: row.last_ok_at?.toISOString() ?? null,
      lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
      nextCheckAt: row.next_check_at?.toISOString() ?? null,
      finalUrl: row.final_url,
      needsManualCheck: row.needs_manual_check,
    })),
  };
}

export type LifecycleEvent = {
  id: number;
  roundId: string;
  roundDate: string;
  probeVersion: number;
  jobId: number | null;
  outcome: string;
  errorKind: string | null;
  errorFamily: string | null;
  evidenceStrength: string | null;
  confidence: string;
  changeFlags: string[];
  reachFrom: string | null;
  reachTo: string | null;
  finalStatus: number | null;
  finalUrl: string | null;
  latencyMs: number | null;
  contentVerdict: string | null;
  evidence: unknown;
  createdAt: string;
};

export async function getLifecycleTimeline(
  websiteId: number,
  limit = 20
): Promise<LifecycleEvent[]> {
  const rows = await prisma.toolHealthEvent.findMany({
    where: { website_id: websiteId },
    orderBy: { id: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
  });
  return rows.map((row) => ({
    id: row.id,
    roundId: row.round_id,
    roundDate: row.round_date,
    probeVersion: row.probe_version,
    jobId: row.job_id,
    outcome: row.outcome,
    errorKind: row.error_kind,
    errorFamily: row.error_family,
    evidenceStrength: row.evidence_strength,
    confidence: row.confidence,
    changeFlags: row.change_flags,
    reachFrom: row.reach_from,
    reachTo: row.reach_to,
    finalStatus: row.final_status,
    finalUrl: row.final_url,
    latencyMs: row.latency_ms,
    contentVerdict: row.content_verdict,
    evidence: row.evidence,
    createdAt: row.created_at.toISOString(),
  }));
}

/** 导出 dead 清单（CSV），供人工逐条核对 */
export async function exportDeadList(): Promise<string> {
  const rows = await prisma.toolLifecycleState.findMany({
    where: { reach: "dead" },
    orderBy: { website_id: "asc" },
    include: { website: { select: { title: true, slug: true, url: true } } },
  });
  const escape = (v: string | null) =>
    v === null ? "" : `"${v.replace(/"/g, '""')}"`;
  const header =
    "website_id,title,slug,url,final_url,last_error_kind,consecutive_fails,distinct_fail_dates,first_fail_at,last_ok_at,reach_since";
  const lines = rows.map((r) =>
    [
      r.website_id,
      escape(r.website.title),
      escape(r.website.slug),
      escape(r.website.url),
      escape(r.final_url),
      escape(r.last_error_kind),
      r.consecutive_fails,
      r.distinct_fail_dates,
      escape(r.first_fail_at?.toISOString() ?? null),
      escape(r.last_ok_at?.toISOString() ?? null),
      escape(r.reach_since?.toISOString() ?? null),
    ].join(",")
  );
  return [header, ...lines].join("\n");
}

/** 错误类型分布，观察期用 */
export async function getErrorKindBreakdown(): Promise<{ errorKind: string; count: number }[]> {
  const rows = await prisma.toolLifecycleState.groupBy({
    by: ["last_error_kind"],
    _count: { _all: true },
    where: { last_error_kind: { not: null } },
  });
  return rows
    .map((r) => ({ errorKind: r.last_error_kind ?? "unknown", count: r._count._all }))
    .sort((a, b) => b.count - a.count);
}
