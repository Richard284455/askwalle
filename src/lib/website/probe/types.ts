/**
 * Reachability Probe 判定契约 v1.0 —— 共享类型与常量。
 *
 * ★ PROBE_VERSION：任何影响 outcome / reach 的判定改动都必须递增。
 *   证据里存着它；判定层重放时版本不匹配会返回 version_mismatch 而不是静默混算。
 *   相似度闸门改口径那次，正是因为没有版本号，12 条草稿的状态悄悄漂移了。
 */
export const PROBE_VERSION = 2;

/**
 * 深度内容检查周期（天）。
 *
 * v1 的问题：HEAD 2xx 短路时不取正文，正常体积的 soft-404 / 停放页永远进不了
 * 内容分类 —— 只有小页面、HEAD 不可用、跨域跳转这三条路会取正文。
 * v2 增加「按 tier 周期性强制 GET」，保证每个工具都会被完整看一遍。
 */
export const CONTENT_CHECK_INTERVAL_DAYS: Record<string, number> = {
  featured: 7,
  featured_candidate: 7,
  standard: 30,
  longtail: 90,
};

export function contentCheckIntervalDays(tier: string): number {
  return CONTENT_CHECK_INTERVAL_DAYS[tier] ?? CONTENT_CHECK_INTERVAL_DAYS.standard;
}

/**
 * 是否到期做深度内容检查。纯函数，可单测。
 * 从未做过（null）一律返回 true —— A8 首轮基线因此会对每个 HTML 工具至少 GET 一次。
 */
export function isContentCheckDue(
  lastContentCheckedAt: Date | null,
  tier: string,
  now: Date = new Date()
): boolean {
  if (!lastContentCheckedAt) return true;
  const elapsedDays =
    (now.getTime() - lastContentCheckedAt.getTime()) / 86_400_000;
  return elapsedDays >= contentCheckIntervalDays(tier);
}

export type ProbeOutcome =
  | "ok"
  | "dns"
  | "timeout"
  | "tls"
  | "http_5xx"
  | "http_404"
  | "http_410"
  | "soft_404"
  | "parked"
  | "blocked"
  | "deferred"
  | "unsafe_target"
  | "unknown";

export type ErrorFamily = "network" | "server" | "gone";

export type Reach = "ok" | "dead" | "unverifiable" | "unknown";

export type ChangeFlag =
  | "domain_migrated"
  | "recovered"
  | "state_changed"
  | "needs_manual_check"
  | "archive_found";

export type ContentVerdict =
  | "normal"
  | "spa_shell"
  | "non_html"
  | "truncated"
  | "undecodable";

/** 契约 §2.1：哪些 outcome 属于生命周期失败（参与消抖），哪些只是探测结果 */
export const LIFECYCLE_FAILURES: ProbeOutcome[] = [
  "dns",
  "timeout",
  "tls",
  "http_5xx",
  "http_404",
  "http_410",
  "soft_404",
  "parked",
];

/** 既不计消抖也不触发熔断 */
export const NON_FAILURE_OUTCOMES: ProbeOutcome[] = [
  "blocked",
  "deferred",
  "unsafe_target",
  "unknown",
];

export const ERROR_FAMILY: Record<string, ErrorFamily> = {
  dns: "network",
  timeout: "network",
  redirect_loop: "network",
  tls: "network",
  http_5xx: "server",
  http_404: "gone",
  http_410: "gone",
  soft_404: "gone",
  parked: "gone",
};

/** 契约 §6.2：404/410 权重加倍 */
export const FAILURE_WEIGHT: Record<string, number> = {
  http_404: 2,
  http_410: 2,
};

/** 契约 §6.3 dead 四条件 */
export const DEAD_THRESHOLDS = {
  minConsecutiveFails: 3,
  minDistinctFailDates: 3,
  minSpanDays: 14,
} as const;

/** 熔断器只统计这些 —— blocked/deferred/unsafe/4xx 一律不计（契约 §6.5） */
export const BREAKER_COUNTED: ProbeOutcome[] = ["dns", "timeout", "tls", "http_5xx"];

export function isLifecycleFailure(outcome: ProbeOutcome): boolean {
  return LIFECYCLE_FAILURES.includes(outcome);
}

export function countsTowardBreaker(outcome: ProbeOutcome): boolean {
  return BREAKER_COUNTED.includes(outcome);
}

/** 探针输出：一个 scheduled round 恰好产出一个 */
export type ProbeResult = {
  probeVersion: number;
  outcome: ProbeOutcome;
  errorKind: string | null;
  errorFamily: ErrorFamily | null;
  evidenceStrength: "strong" | "weak" | null;
  confidence: "high" | "low";
  contentVerdict: ContentVerdict | null;
  finalStatus: number | null;
  finalUrl: string | null;
  latencyMs: number;
  /** deferred 时的建议重试延迟 */
  retryAfterMs: number | null;
  domainMigrated: boolean;
  unsafeReason: string | null;
  /** 本轮是否真的完成了正文分类（决定要不要推进 last_content_checked_at） */
  contentChecked: boolean;
  evidence: ProbeEvidence;
};

/** 契约 §7：必须足以离线重判 */
export type ProbeEvidence = {
  probeVersion: number;
  requestedUrl: string;
  scheme: string | null;
  host: string | null;
  port: number | null;
  resolvedIps: string[];
  pinnedIp: string | null;
  redirectChain: {
    hop: number;
    status: number;
    location: string | null;
    host: string;
    resolvedIp: string | null;
    ssrfOk: boolean;
  }[];
  methodSequence: ("HEAD" | "GET")[];
  finalStatus: number | null;
  finalUrl: string | null;
  finalRegistrableDomain: string | null;
  headersSubset: Record<string, string>;
  tlsError: string | null;
  networkError: string | null;
  bytesRead: number;
  truncated: boolean;
  contentType: string | null;
  contentVerdict: ContentVerdict | null;
  visibleTextLen: number;
  textBlockCount: number;
  internalLinkCount: number;
  titleExcerpt: string | null;
  h1Excerpt: string | null;
  matchedSignatures: {
    ruleId: string;
    layer: string;
    source: string;
    blockIndex: number | null;
    matchedText: string;
  }[];
  weakSignals: string[];
  exclusionsHit: string[];
  robotsDecision: "allow" | "disallow" | "deferred";
  robotsRule: string | null;
  retryAfterSeconds: number | null;
  unsafeReason: string | null;
  nsRecords: string[] | null;
  nsLookupFailed: boolean;
  latency: { dnsMs: number | null; headMs: number | null; getMs: number | null; totalMs: number };
};
