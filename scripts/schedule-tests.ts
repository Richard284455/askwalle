/**
 * 失败候选加速重探排期 —— 单元测试。
 *
 *   npm run test:schedule
 *
 * 纯函数测试：不连数据库、不发网络请求、不调 AI。
 */
import {
  computeNextCheck,
  scheduleJitterMs,
  nextShanghaiDayStart,
  ScheduleInput,
} from "@/lib/website/tool-lifecycle";
import { applyRound, INITIAL_STATE, shanghaiDate } from "@/lib/website/probe/classifier";
import { PROBE_VERSION, ErrorFamily } from "@/lib/website/probe/types";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(id: string, name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    failures.push(`${id} ${name}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const DAY = 86_400_000;
const T0 = new Date("2026-07-28T06:00:00.000Z"); // 上海时间 14:00
const daysBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / DAY;

const base = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  websiteId: 12,
  tier: "longtail",
  reach: "unknown",
  retryAfterMs: null,
  failFamily: null,
  distinctFailDates: 0,
  firstFailAt: null,
  at: T0,
  ...over,
});

function main() {
  console.log("\n1. longtail 首轮 dns —— 不得排到 90 天后\n");
  {
    const r = computeNextCheck(base({
      failFamily: "network", distinctFailDates: 1, firstFailAt: T0,
    }));
    const d = daysBetween(T0, r.nextCheckAt);
    check("S1.1", "不再走 longtail 的 90 天", d < 30, `${d.toFixed(2)} 天`);
    check("S1.2", "落在 first_fail_at + 7 天窗口内", d >= 7 && d <= 7.5, `${d.toFixed(2)} 天`);
    check("S1.3", "stage=1", r.stage === 1, String(r.stage));
  }

  console.log("\n2. 首轮 http_404（FAILURE_WEIGHT=2）—— 仍走第 7 天，不跳到第 14 天\n");
  {
    // 走真实判定层拿到本轮之后的状态
    const st = applyRound(INITIAL_STATE, {
      outcome: "http_404", errorKind: "http_404", errorFamily: "gone",
      evidenceStrength: null, confidence: "high", domainMigrated: false,
      finalUrl: null, probeVersion: PROBE_VERSION, at: T0,
    });
    if (!st.ok) throw new Error("applyRound 意外 version_mismatch");
    check("S2.1", "consecutive_fails=2（权重生效）", st.next.consecutiveFails === 2, String(st.next.consecutiveFails));
    check("S2.2", "distinct_fail_dates=1", st.next.distinctFailDates === 1, String(st.next.distinctFailDates));

    const r = computeNextCheck(base({
      websiteId: 172,
      failFamily: st.next.failFamily, distinctFailDates: st.next.distinctFailDates,
      firstFailAt: st.next.firstFailAt,
    }));
    const d = daysBetween(T0, r.nextCheckAt);
    check("S2.3", "仍按 stage=1 排（约第 7 天），未因权重跳到第 14 天",
      r.stage === 1 && d >= 7 && d <= 7.5, `stage=${r.stage} ${d.toFixed(2)} 天`);
  }

  console.log("\n3. 第二个独立日期失败 —— 下一轮不早于 first_fail_at + 14 天\n");
  {
    const firstFail = T0;
    const round2At = new Date(T0.getTime() + 7 * DAY + 3 * 3600_000);
    const r = computeNextCheck(base({
      at: round2At, failFamily: "network", distinctFailDates: 2, firstFailAt: firstFail,
    }));
    const fromFirst = daysBetween(firstFail, r.nextCheckAt);
    check("S3.1", "stage=2", r.stage === 2, String(r.stage));
    check("S3.2", "距首次失败 ≥14 天", fromFirst >= 14, `${fromFirst.toFixed(2)} 天`);
    check("S3.3", "与本轮属于不同 Asia/Shanghai 自然日",
      shanghaiDate(r.nextCheckAt) !== shanghaiDate(round2At),
      `${shanghaiDate(round2At)} → ${shanghaiDate(r.nextCheckAt)}`);
  }

  console.log("\n4. 第二轮执行较晚（first_fail_at + 14 天已过）\n");
  {
    const firstFail = T0;
    const lateRound = new Date(T0.getTime() + 20 * DAY + 5 * 3600_000);
    const r = computeNextCheck(base({
      at: lateRound, failFamily: "network", distinctFailDates: 2, firstFailAt: firstFail,
    }));
    check("S4.1", "至少落到下一个上海自然日",
      r.nextCheckAt.getTime() >= nextShanghaiDayStart(lateRound).getTime(),
      `${r.nextCheckAt.toISOString()} vs ${nextShanghaiDayStart(lateRound).toISOString()}`);
    check("S4.2", "不与本轮同日（不会同日重复计轮）",
      shanghaiDate(r.nextCheckAt) !== shanghaiDate(lateRound),
      `${shanghaiDate(lateRound)} → ${shanghaiDate(r.nextCheckAt)}`);
    check("S4.3", "仍在未来", r.nextCheckAt > lateRound);
  }

  console.log("\n5. error family 改变 —— 失败链重置，排期回到约第 7 天\n");
  {
    // 先积累 network 族两轮
    let st = applyRound(INITIAL_STATE, {
      outcome: "timeout", errorKind: "timeout", errorFamily: "network",
      evidenceStrength: null, confidence: "high", domainMigrated: false,
      finalUrl: null, probeVersion: PROBE_VERSION, at: T0,
    });
    if (!st.ok) throw new Error("unexpected");
    st = applyRound(st.next, {
      outcome: "timeout", errorKind: "timeout", errorFamily: "network",
      evidenceStrength: null, confidence: "high", domainMigrated: false,
      finalUrl: null, probeVersion: PROBE_VERSION, at: new Date(T0.getTime() + 7 * DAY),
    });
    if (!st.ok) throw new Error("unexpected");
    check("S5.0", "network 族累计到 2 个独立日", st.next.distinctFailDates === 2, String(st.next.distinctFailDates));

    // 换成 gone 族
    const switched = applyRound(st.next, {
      outcome: "http_404", errorKind: "http_404", errorFamily: "gone",
      evidenceStrength: null, confidence: "high", domainMigrated: false,
      finalUrl: null, probeVersion: PROBE_VERSION, at: new Date(T0.getTime() + 14 * DAY),
    });
    if (!switched.ok) throw new Error("unexpected");
    check("S5.1", "族变更后 distinct_fail_dates 重置为 1",
      switched.next.distinctFailDates === 1, String(switched.next.distinctFailDates));

    const r = computeNextCheck(base({
      at: new Date(T0.getTime() + 14 * DAY),
      failFamily: switched.next.failFamily,
      distinctFailDates: switched.next.distinctFailDates,
      firstFailAt: switched.next.firstFailAt,
    }));
    const d = daysBetween(switched.next.firstFailAt!, r.nextCheckAt);
    check("S5.2", "排期重新从约第 7 天开始", r.stage === 1 && d >= 7 && d <= 7.5,
      `stage=${r.stage} ${d.toFixed(2)} 天`);
  }

  console.log("\n6. ok 恢复 —— 失败链清空，回到 tier 常规周期\n");
  {
    let st = applyRound(INITIAL_STATE, {
      outcome: "dns", errorKind: "dns", errorFamily: "network",
      evidenceStrength: null, confidence: "high", domainMigrated: false,
      finalUrl: null, probeVersion: PROBE_VERSION, at: T0,
    });
    if (!st.ok) throw new Error("unexpected");
    st = applyRound(st.next, {
      outcome: "ok", errorKind: null, errorFamily: null, evidenceStrength: null,
      confidence: "high", domainMigrated: false, finalUrl: null,
      probeVersion: PROBE_VERSION, at: new Date(T0.getTime() + 7 * DAY),
    });
    if (!st.ok) throw new Error("unexpected");
    check("S6.1", "失败链已清空",
      st.next.failFamily === null && st.next.distinctFailDates === 0 && st.next.consecutiveFails === 0,
      `family=${st.next.failFamily} dates=${st.next.distinctFailDates} streak=${st.next.consecutiveFails}`);

    const r = computeNextCheck(base({
      at: new Date(T0.getTime() + 7 * DAY), reach: "ok",
      failFamily: st.next.failFamily, distinctFailDates: st.next.distinctFailDates,
      firstFailAt: st.next.firstFailAt,
    }));
    const d = daysBetween(new Date(T0.getTime() + 7 * DAY), r.nextCheckAt);
    check("S6.2", "回到 longtail 的 90 天档（±10%）", r.stage === 0 && d >= 81 && d <= 99, `${d.toFixed(1)} 天`);
  }

  console.log("\n7. blocked / deferred —— 不使用失败加速\n");
  {
    const blocked = computeNextCheck(base({
      reach: "unverifiable", failFamily: null, distinctFailDates: 0,
    }));
    check("S7.1", "blocked/unsafe_target 保持 unverifiable 长周期（180 天）",
      blocked.stage === 0 && Math.round(daysBetween(T0, blocked.nextCheckAt)) === 180,
      `${daysBetween(T0, blocked.nextCheckAt).toFixed(1)} 天`);

    const deferred = computeNextCheck(base({ retryAfterMs: 24 * 3600_000 }));
    check("S7.2", "deferred 严格采用 Retry-After",
      deferred.stage === 0 && Math.abs(daysBetween(T0, deferred.nextCheckAt) - 1) < 1e-9,
      `${daysBetween(T0, deferred.nextCheckAt).toFixed(3)} 天`);

    // 即使带着失败链，deferred/unverifiable 也优先
    const deferredWithChain = computeNextCheck(base({
      retryAfterMs: 3_600_000, failFamily: "network", distinctFailDates: 1, firstFailAt: T0,
    }));
    check("S7.3", "有失败链时 deferred 仍优先，不被加速覆盖",
      deferredWithChain.stage === 0, `stage=${deferredWithChain.stage}`);
    const unverifiableWithChain = computeNextCheck(base({
      reach: "unverifiable", failFamily: "network", distinctFailDates: 1, firstFailAt: T0,
    }));
    check("S7.4", "有失败链时 unverifiable 仍优先",
      unverifiableWithChain.stage === 0 && Math.round(daysBetween(T0, unverifiableWithChain.nextCheckAt)) === 180,
      `stage=${unverifiableWithChain.stage}`);

    const dead = computeNextCheck(base({
      reach: "dead", failFamily: "gone", distinctFailDates: 1, firstFailAt: T0,
    }));
    check("S7.5", "dead 保持 30 天定期复检，不被加速覆盖",
      dead.stage === 0 && Math.round(daysBetween(T0, dead.nextCheckAt)) === 30,
      `${daysBetween(T0, dead.nextCheckAt).toFixed(1)} 天`);
  }

  console.log("\n8. jitter\n");
  {
    const a1 = scheduleJitterMs(42, 1);
    const a2 = scheduleJitterMs(42, 1);
    check("S8.1", "同一 (websiteId, stage) 结果稳定", a1 === a2, `${a1} vs ${a2}`);
    check("S8.2", "不同 stage 取值不同", scheduleJitterMs(42, 1) !== scheduleJitterMs(42, 2));

    const all = Array.from({ length: 429 }, (_, i) => scheduleJitterMs(i + 1, 1));
    check("S8.3", "全部非负", all.every((x) => x >= 0));
    check("S8.4", "全部落在 0–12 小时内", all.every((x) => x < 12 * 3600_000),
      `max=${(Math.max(...all) / 3600_000).toFixed(2)}h`);
    const buckets = new Set(all.map((x) => Math.floor(x / 3600_000)));
    check("S8.5", "分散在多个小时桶（不集中同一时刻）", buckets.size >= 10, `${buckets.size} 个桶`);
    const uniq = new Set(all).size;
    check("S8.6", "取值高度分散", uniq > 400, `${uniq}/429 唯一`);

    // jitter 不会把第三轮拉到 14 天以内
    const worst = Array.from({ length: 429 }, (_, i) => {
      const r = computeNextCheck(base({
        websiteId: i + 1, at: new Date(T0.getTime() + 7 * DAY),
        failFamily: "network", distinctFailDates: 2, firstFailAt: T0,
      }));
      return daysBetween(T0, r.nextCheckAt);
    });
    check("S8.7", "任何 jitter 下第三轮都不早于第 14 天",
      Math.min(...worst) >= 14, `min=${Math.min(...worst).toFixed(2)} 天`);
    check("S8.8", "且不晚于第 14.5 天", Math.max(...worst) <= 14.5,
      `max=${Math.max(...worst).toFixed(2)} 天`);
  }

  console.log("\n9. Probe v4 判定未受影响\n");
  {
    check("S9.1", "PROBE_VERSION 仍为 4", PROBE_VERSION === 4, String(PROBE_VERSION));
    // 三轮跨 14 天 → dead，与排期改动无关
    const r1 = applyRound(INITIAL_STATE, {
      outcome: "dns", errorKind: "dns", errorFamily: "network", evidenceStrength: null,
      confidence: "high", domainMigrated: false, finalUrl: null, probeVersion: PROBE_VERSION, at: T0,
    });
    if (!r1.ok) throw new Error("unexpected");
    const r2 = applyRound(r1.next, {
      outcome: "dns", errorKind: "dns", errorFamily: "network", evidenceStrength: null,
      confidence: "high", domainMigrated: false, finalUrl: null, probeVersion: PROBE_VERSION,
      at: new Date(T0.getTime() + 7 * DAY),
    });
    if (!r2.ok) throw new Error("unexpected");
    const r3 = applyRound(r2.next, {
      outcome: "dns", errorKind: "dns", errorFamily: "network", evidenceStrength: null,
      confidence: "high", domainMigrated: false, finalUrl: null, probeVersion: PROBE_VERSION,
      at: new Date(T0.getTime() + 14 * DAY + 3600_000),
    });
    if (!r3.ok) throw new Error("unexpected");
    check("S9.2", "7/14 天三轮恰好满足 dead 四条件", r3.next.reach === "dead",
      `reach=${r3.next.reach} streak=${r3.next.consecutiveFails} dates=${r3.next.distinctFailDates}`);
    const replayOld = applyRound(INITIAL_STATE, {
      outcome: "ok", errorKind: null, errorFamily: null, evidenceStrength: null,
      confidence: "high", domainMigrated: false, finalUrl: null, probeVersion: 3, at: T0,
    });
    check("S9.3", "v3 证据仍 version_mismatch", !replayOld.ok);
  }

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) {
    console.log("\n失败用例:");
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

main();
