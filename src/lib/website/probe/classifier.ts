import {
  ChangeFlag,
  DEAD_THRESHOLDS,
  ERROR_FAMILY,
  ErrorFamily,
  FAILURE_WEIGHT,
  PROBE_VERSION,
  ProbeOutcome,
  Reach,
  isLifecycleFailure,
} from "./types";

/**
 * 判定层（契约 §6）——**纯函数**。
 *
 * 不发网络请求、不读库、不看时钟以外的任何外部状态：给定同样的 (state, round)
 * 必然得出同样的结论。这条是硬要求 —— 相似度闸门那次能查清 12 条草稿为什么漂移，
 * 靠的就是能拿生产函数对存量证据重跑。
 */

/** Asia/Shanghai 日期（与 cron 时区一致，不用 UTC 以免跨日错位） */
export function shanghaiDate(at: Date): string {
  const shifted = new Date(at.getTime() + 8 * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}

export type DebounceState = {
  reach: Reach;
  reachSince: Date | null;
  consecutiveFails: number;
  distinctFailDates: number;
  firstFailAt: Date | null;
  lastFailDate: string | null;
  failFamily: ErrorFamily | null;
  lastErrorKind: string | null;
  lastOkAt: Date | null;
  needsManualCheck: boolean;
  finalUrl: string | null;
};

export type RoundInput = {
  outcome: ProbeOutcome;
  errorKind: string | null;
  /** 探针给出的族；缺省时由 errorKind 推导 */
  errorFamily?: ErrorFamily | null;
  evidenceStrength: "strong" | "weak" | null;
  confidence: "high" | "low";
  domainMigrated: boolean;
  finalUrl: string | null;
  probeVersion: number;
  at: Date;
};

export type Decision =
  | {
      ok: true;
      next: DebounceState;
      changeFlags: ChangeFlag[];
      reachFrom: Reach;
      reachTo: Reach;
      stateChanged: boolean;
    }
  | { ok: false; reason: "version_mismatch"; expected: number; got: number };

export const INITIAL_STATE: DebounceState = {
  reach: "unknown",
  reachSince: null,
  consecutiveFails: 0,
  distinctFailDates: 0,
  firstFailAt: null,
  lastFailDate: null,
  failFamily: null,
  lastErrorKind: null,
  lastOkAt: null,
  needsManualCheck: false,
  finalUrl: null,
};

function familyOf(round: RoundInput): ErrorFamily | null {
  if (round.errorFamily !== undefined && round.errorFamily !== null) return round.errorFamily;
  return round.errorKind ? ERROR_FAMILY[round.errorKind] ?? null : null;
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 86_400_000;
}

/**
 * 应用一个 check round。
 *
 * 版本不匹配直接拒绝：混算不同分类器版本的结论，等于把「站点变了」和
 * 「我们的规则变了」搅在一起，事后无法分辨。
 */
export function applyRound(state: DebounceState, round: RoundInput): Decision {
  if (round.probeVersion !== PROBE_VERSION) {
    return {
      ok: false,
      reason: "version_mismatch",
      expected: PROBE_VERSION,
      got: round.probeVersion,
    };
  }

  const from = state.reach;
  const next: DebounceState = { ...state };
  const flags: ChangeFlag[] = [];
  const roundDate = shanghaiDate(round.at);

  if (round.finalUrl) next.finalUrl = round.finalUrl;
  if (round.domainMigrated) {
    flags.push("domain_migrated");
    // 契约决策：不自动改 Website.url，只标人工复核
    next.needsManualCheck = true;
  }

  if (round.outcome === "ok") {
    // 任意成功清零
    next.consecutiveFails = 0;
    next.distinctFailDates = 0;
    next.firstFailAt = null;
    next.lastFailDate = null;
    next.failFamily = null;
    next.lastErrorKind = null;
    next.lastOkAt = round.at;
    next.reach = "ok";
    if (from !== "ok") flags.push("recovered");
  } else if (round.outcome === "deferred" || round.outcome === "unknown") {
    // 不改任何消抖字段，reach 保持
    next.lastErrorKind = state.lastErrorKind;
  } else if (round.outcome === "blocked" || round.outcome === "unsafe_target") {
    // 契约 §2 修订：已 dead 的保持 dead，只记事件；其余转 unverifiable
    if (from !== "dead") next.reach = "unverifiable";
    next.lastErrorKind = round.errorKind;
    if (round.outcome === "unsafe_target") next.needsManualCheck = true;
  } else if (isLifecycleFailure(round.outcome)) {
    const family = familyOf(round);
    next.lastErrorKind = round.errorKind;

    // parked 强证据：单次即 dead，绕过全部消抖条件
    if (round.outcome === "parked" && round.evidenceStrength === "strong") {
      next.consecutiveFails = Math.max(1, state.consecutiveFails);
      next.distinctFailDates = Math.max(1, state.distinctFailDates);
      next.firstFailAt = state.firstFailAt ?? round.at;
      next.lastFailDate = roundDate;
      next.failFamily = family;
      next.reach = "dead";
    } else if (state.lastFailDate === roundDate && state.failFamily === family) {
      // 同日重复失败不计新轮次（人工重跑任务会触发这条）
      next.failFamily = family;
    } else if (state.failFamily !== null && state.failFamily !== family) {
      // 族变更：重新计数
      next.consecutiveFails = FAILURE_WEIGHT[round.errorKind ?? ""] ?? 1;
      next.distinctFailDates = 1;
      next.firstFailAt = round.at;
      next.lastFailDate = roundDate;
      next.failFamily = family;
    } else {
      next.consecutiveFails =
        state.consecutiveFails + (FAILURE_WEIGHT[round.errorKind ?? ""] ?? 1);
      next.distinctFailDates = state.distinctFailDates + 1;
      next.firstFailAt = state.firstFailAt ?? round.at;
      next.lastFailDate = roundDate;
      next.failFamily = family;
    }

    // 四条件同时成立才判 dead
    if (next.reach !== "dead") {
      const spanOk =
        next.firstFailAt !== null &&
        daysBetween(next.firstFailAt, round.at) >= DEAD_THRESHOLDS.minSpanDays;
      const shouldDie =
        next.consecutiveFails >= DEAD_THRESHOLDS.minConsecutiveFails &&
        next.distinctFailDates >= DEAD_THRESHOLDS.minDistinctFailDates &&
        spanOk;
      if (shouldDie) next.reach = "dead";
      else if (from === "dead") next.reach = "dead"; // 已 dead 不因新失败回退
      else next.reach = from === "unverifiable" ? "unverifiable" : from;
    }
  }

  const stateChanged = next.reach !== from;
  if (stateChanged) {
    flags.push("state_changed");
    next.reachSince = round.at;
  }
  if (next.needsManualCheck && !state.needsManualCheck) flags.push("needs_manual_check");

  return { ok: true, next, changeFlags: flags, reachFrom: from, reachTo: next.reach, stateChanged };
}

/**
 * 离线重放：从初始状态起按时间顺序回放一串 round，得到最终状态。
 * 用于「改了阈值之后，历史数据会变成什么样」这类回溯分析。
 */
export function replay(
  rounds: RoundInput[],
  from: DebounceState = INITIAL_STATE
): { state: DebounceState; steps: Decision[]; versionMismatches: number } {
  let state = from;
  const steps: Decision[] = [];
  let versionMismatches = 0;
  for (const round of rounds) {
    const decision = applyRound(state, round);
    steps.push(decision);
    if (!decision.ok) {
      versionMismatches++;
      continue; // 不静默混算：跳过该轮，但计数并上报
    }
    state = decision.next;
  }
  return { state, steps, versionMismatches };
}
