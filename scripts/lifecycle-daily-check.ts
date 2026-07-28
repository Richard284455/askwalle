/**
 * 观察期每日只读检查。
 *
 *   npm run check:lifecycle
 *
 * 纯只读：不写任何表、不发探测请求、不调 AI。
 * 只查异常与到期任务，**不对 429 条做全量人工查询**。
 *
 * 全部统计只计入有效 probe_version=4 事件（v2/v3 历史保留但不混算）。
 */
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { PROBE_VERSION, ErrorFamily } from "@/lib/website/probe/types";
import { applyRound, INITIAL_STATE, shanghaiDate } from "@/lib/website/probe/classifier";

// 冻结基线（b07108f 时刻）
const BASELINE = {
  urlFingerprint: "19efe15357ceac38",
  statusActiveFingerprint: "c0816c45fc79a6a9",
  v4Rounds: 429,
  websites: 429,
};
const TERMINAL = ["completed", "completed_with_errors", "failed", "canceled"];
const STALE_HOURS = 24;

let alerts = 0;
const line = (ok: boolean, name: string, detail: string) => {
  if (!ok) alerts++;
  console.log(`  ${ok ? "✅" : "🚨"} ${name.padEnd(34)} ${detail}`);
};

async function main() {
  const now = new Date();
  console.log(`观察期每日检查 · ${shanghaiDate(now)} (Asia/Shanghai)\n`);

  // ── 1. 服务与调度 ─────────────────────────────────────────────────
  console.log("1. 服务与任务\n");
  const activeJobs = await prisma.bulkJob.findMany({
    where: { status: { notIn: TERMINAL } },
    select: { id: true, type: true, status: true, total_count: true, processed_count: true, locked_by: true, locked_until: true },
  });
  const health = activeJobs.filter((j) => j.type === "health_check");
  line(health.length <= 1, "未终结 health_check job", health.length === 0 ? "无" : JSON.stringify(health));
  line(activeJobs.length === health.length, "无其它未终结任务",
    activeJobs.length ? JSON.stringify(activeJobs.map((j) => `#${j.id}:${j.type}:${j.status}`)) : "无");

  const items = await prisma.bulkJobItem.groupBy({
    by: ["status"], where: { status: { in: ["queued", "running"] } }, _count: true,
  });
  const openItems = items.reduce((a, b) => a + b._count, 0);
  line(true, "queued/running item", openItems ? JSON.stringify(items.map((i) => `${i.status}=${i._count}`)) : "0");

  // 僵死：running 且超过 30 分钟没刷新
  const stalled = await prisma.bulkJobItem.count({
    where: { status: "running", updated_at: { lt: new Date(now.getTime() - 30 * 60_000) } },
  });
  line(stalled === 0, "僵死 item（running >30 分钟）", String(stalled));

  const leases = await prisma.bulkJob.findMany({
    where: { locked_by: { not: null } },
    select: { id: true, locked_by: true, locked_until: true, status: true },
  });
  const staleLease = leases.filter((l) => TERMINAL.includes(l.status) || (l.locked_until && l.locked_until < now));
  line(staleLease.length === 0, "残留/过期租约",
    leases.length === 0 ? "无" : `持有 ${leases.length}，其中异常 ${staleLease.length}`);

  // ── 2. 数据正确性 ─────────────────────────────────────────────────
  console.log("\n2. 数据正确性（只看有效 v4）\n");
  const raw = await prisma.toolHealthEvent.findMany({
    where: { probe_version: PROBE_VERSION },
    select: {
      id: true, website_id: true, round_id: true, outcome: true, error_kind: true,
      error_family: true, evidence_strength: true, confidence: true, change_flags: true,
      final_url: true, probe_version: true, created_at: true, reach_to: true, evidence: true,
    },
  });
  const v4 = raw.filter((e) => (e.evidence as Record<string, unknown> | null)?.invalidated !== true);
  const rounds = v4.map((e) => e.round_id);
  line(rounds.length === new Set(rounds).size, "round_id 唯一",
    `${rounds.length} 条 / ${new Set(rounds).size} 唯一`);

  const perSite = new Map<number, number>();
  for (const e of v4) perSite.set(e.website_id, (perSite.get(e.website_id) ?? 0) + 1);
  const dupSite = [...perSite].filter(([, c]) => c > 1);
  line(dupSite.length === 0, "同一工具同轮无重复",
    dupSite.length ? dupSite.map(([i, c]) => `#${i}×${c}`).join(",") : "0");

  const internal = v4.filter((e) => (e.evidence as Record<string, unknown> | null)?.clientInternalError === true);
  line(internal.length === 0, "clientInternalError",
    internal.length ? internal.map((e) => "#" + e.website_id).join(",") : "0");

  // replay 抽查：最近 40 条
  let mismatch = 0;
  for (const e of v4.slice(-40)) {
    const d = applyRound(INITIAL_STATE, {
      outcome: e.outcome as never, errorKind: e.error_kind,
      errorFamily: (e.error_family as ErrorFamily | null) ?? null,
      evidenceStrength: (e.evidence_strength as "strong" | "weak" | null) ?? null,
      confidence: e.confidence as "high" | "low",
      domainMigrated: e.change_flags.includes("domain_migrated"),
      finalUrl: e.final_url, probeVersion: e.probe_version, at: e.created_at,
    });
    // 首轮事件才能用 INITIAL_STATE 重放；多轮的只校验版本可用
    if (!d.ok) mismatch++;
  }
  line(mismatch === 0, "replay 版本一致（抽查最近 40 条）", `${mismatch} 条 mismatch`);

  const wrongVer = raw.filter((e) => e.probe_version !== PROBE_VERSION).length;
  line(wrongVer === 0, `全部事件 probe_version=${PROBE_VERSION}`, String(wrongVer));

  // ── 3. Website 指纹 ───────────────────────────────────────────────
  console.log("\n3. Website 指纹（必须与冻结基线一致）\n");
  const sites = await prisma.website.findMany({
    select: { id: true, status: true, active: true, url: true }, orderBy: { id: "asc" },
  });
  const urlFp = createHash("sha256").update(sites.map((s) => `${s.id}:${s.url}`).join("\n")).digest("hex").slice(0, 16);
  const saFp = createHash("sha256")
    .update(JSON.stringify(sites.map((s) => ({ id: s.id, status: s.status, active: s.active }))))
    .digest("hex").slice(0, 16);
  line(sites.length === BASELINE.websites, "Website 总数", `${sites.length}`);
  line(urlFp === BASELINE.urlFingerprint, "url 指纹", `${urlFp} (基线 ${BASELINE.urlFingerprint})`);
  line(saFp === BASELINE.statusActiveFingerprint, "status/active 指纹", `${saFp} (基线 ${BASELINE.statusActiveFingerprint})`);

  // ── 4. 排期健康度 ─────────────────────────────────────────────────
  console.log("\n4. 排期\n");
  const states = await prisma.toolLifecycleState.findMany({
    select: {
      website_id: true, reach: true, next_check_at: true, last_checked_at: true,
      fail_family: true, distinct_fail_dates: true, consecutive_fails: true, first_fail_at: true,
    },
  });
  const probed = states.filter((s) => s.last_checked_at !== null).length;
  line(probed >= BASELINE.v4Rounds, "已探测工具数", `${probed}/${BASELINE.websites}`);

  const due = states.filter((s) => s.next_check_at === null || s.next_check_at <= now);
  const overdue = due.filter(
    (s) => s.next_check_at !== null && s.next_check_at < new Date(now.getTime() - STALE_HOURS * 3600_000)
  );
  line(overdue.length === 0, `到期超 ${STALE_HOURS} 小时未处理`,
    overdue.length ? `${overdue.length} 条: ${overdue.slice(0, 10).map((s) => "#" + s.website_id).join(",")}` : "0");
  console.log(`     当前到期待处理: ${due.length} 条`);

  const chain = states.filter((s) => s.fail_family !== null && s.reach !== "dead");
  const byStage = new Map<number, number>();
  for (const s of chain) byStage.set(s.distinct_fail_dates, (byStage.get(s.distinct_fail_dates) ?? 0) + 1);
  console.log(`     失败链进行中: ${chain.length} 条 · 按独立失败日 ${[...byStage].sort().map(([k, v]) => `${k}日=${v}`).join(" · ")}`);

  const nextDates = new Map<string, number>();
  for (const s of chain) if (s.next_check_at) nextDates.set(shanghaiDate(s.next_check_at), (nextDates.get(shanghaiDate(s.next_check_at)) ?? 0) + 1);
  console.log(`     失败候选下轮日期: ${[...nextDates].sort().map(([d, c]) => `${d}=${c}`).join(" · ") || "无"}`);

  const reachDist = new Map<string, number>();
  for (const s of states) reachDist.set(s.reach, (reachDist.get(s.reach) ?? 0) + 1);
  console.log(`     reach: ${[...reachDist].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" · ")}`);

  // ── 5. 结论 ──────────────────────────────────────────────────────
  console.log(`\n${alerts === 0 ? "✅ 无异常" : `🚨 ${alerts} 项需要处理`}`);
  if (alerts > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("检查失败（多半是数据库瞬断，请重试）:", e instanceof Error ? e.message.split("\n")[0] : e);
    process.exitCode = 2;
  })
  .finally(async () => { await prisma.$disconnect(); });
