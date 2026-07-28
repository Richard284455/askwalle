/**
 * 把存量失败候选按新的加速规则重排 next_check_at。
 *
 *   npm run reschedule:failures            # dry-run，只打印
 *   npm run reschedule:failures -- --apply # 写库
 *
 * 幂等：重跑得到同样的结果（jitter 由 websiteId+stage 决定，与时间无关；
 * 排期基准是 first_fail_at 而不是 now）。
 *
 * 只改 tool_lifecycle_states.next_check_at 一个字段。
 * 不碰 Website、不碰判定字段、不写 ToolHealthEvent、不调 AI。
 */
import { prisma } from "@/lib/prisma";
import { computeNextCheck } from "@/lib/website/tool-lifecycle";
import { PROBE_VERSION } from "@/lib/website/probe/types";
import { shanghaiDate } from "@/lib/website/probe/classifier";

const APPLY = process.argv.includes("--apply");
const DAY = 86_400_000;

async function main() {
  const now = new Date();

  // 候选口径：有有效 v4 round + 失败链进行中 + 尚未判死
  const states = await prisma.toolLifecycleState.findMany({
    where: {
      probe_version: PROBE_VERSION,
      fail_family: { not: null },
      distinct_fail_dates: { gte: 1 },
      reach: { not: "dead" },
    },
    select: {
      website_id: true, tier: true, reach: true, fail_family: true,
      distinct_fail_dates: true, consecutive_fails: true, first_fail_at: true,
      last_error_kind: true, next_check_at: true, last_checked_at: true,
      website: { select: { title: true } },
    },
    orderBy: { website_id: "asc" },
  });

  // 双保险：必须真的有有效 v4 事件，否则不动它
  const events = await prisma.toolHealthEvent.findMany({
    where: { website_id: { in: states.map((s) => s.website_id) }, probe_version: PROBE_VERSION },
    select: { website_id: true, outcome: true, evidence: true },
  });
  const validEvent = new Map(
    events
      .filter((e) => (e.evidence as Record<string, unknown> | null)?.invalidated !== true)
      .map((e) => [e.website_id, e])
  );

  const candidates = states.filter((s) => validEvent.has(s.website_id) && s.first_fail_at !== null);
  const skipped = states.filter((s) => !validEvent.has(s.website_id) || s.first_fail_at === null);

  console.log(`候选 ${candidates.length} 条${skipped.length ? `（跳过 ${skipped.length} 条：无有效 v4 事件或缺 first_fail_at）` : ""}\n`);

  const byOutcome = new Map<string, number>();
  for (const s of candidates) {
    const o = validEvent.get(s.website_id)!.outcome;
    byOutcome.set(o, (byOutcome.get(o) ?? 0) + 1);
  }
  console.log(`按 outcome: ${[...byOutcome].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" · ")}\n`);

  console.log("  id   工具                     outcome     首次失败      独立日 streak  原排期(天) → 新排期(天)  stage jitter");
  console.log("  " + "─".repeat(116));

  const plan: { websiteId: number; next: Date; stage: number; jitterMs: number }[] = [];
  for (const s of candidates) {
    const r = computeNextCheck({
      websiteId: s.website_id,
      tier: s.tier,
      reach: s.reach as never,
      retryAfterMs: null,
      failFamily: s.fail_family,
      distinctFailDates: s.distinct_fail_dates,
      firstFailAt: s.first_fail_at,
      at: now,
    });
    plan.push({ websiteId: s.website_id, next: r.nextCheckAt, stage: r.stage, jitterMs: r.jitterMs });
    const oldD = s.next_check_at ? (s.next_check_at.getTime() - now.getTime()) / DAY : NaN;
    const newD = (r.nextCheckAt.getTime() - now.getTime()) / DAY;
    console.log(
      `  #${String(s.website_id).padStart(3)} ${(s.website.title ?? "?").slice(0, 22).padEnd(22)} ` +
        `${(validEvent.get(s.website_id)!.outcome).padEnd(11)} ` +
        `${shanghaiDate(s.first_fail_at!)}  ${String(s.distinct_fail_dates).padStart(3)}   ${String(s.consecutive_fails).padStart(3)}    ` +
        `${oldD.toFixed(1).padStart(6)} → ${newD.toFixed(2).padStart(6)}       ` +
        `${r.stage}    ${(r.jitterMs / 3600_000).toFixed(2)}h`
    );
  }

  // ── 排期健康度 ────────────────────────────────────────────────────
  const gaps = plan.map((p) => (p.next.getTime() - now.getTime()) / DAY).sort((a, b) => a - b);
  if (gaps.length) {
    console.log(`\n新排期分布: min ${gaps[0].toFixed(2)} · 中位 ${gaps[Math.floor(gaps.length / 2)].toFixed(2)} · max ${gaps[gaps.length - 1].toFixed(2)} 天`);
    const stage1 = plan.filter((p) => p.stage === 1).length;
    const stage2 = plan.filter((p) => p.stage === 2).length;
    console.log(`  stage=1（约第 7 天）${stage1} 条 · stage=2（约第 14 天）${stage2} 条`);
    // 同一分钟的尖峰
    const minutes = new Map<string, number>();
    for (const p of plan) minutes.set(p.next.toISOString().slice(0, 16), (minutes.get(p.next.toISOString().slice(0, 16)) ?? 0) + 1);
    const peak = Math.max(...minutes.values());
    console.log(`  同一分钟最多 ${peak} 条 ${peak <= 2 ? "✅ 无尖峰" : "⚠️ 有聚集"}`);
    const dates = new Map<string, number>();
    for (const p of plan) dates.set(shanghaiDate(p.next), (dates.get(shanghaiDate(p.next)) ?? 0) + 1);
    console.log(`  按自然日: ${[...dates].sort().map(([d, c]) => `${d}=${c}`).join(" · ")}`);
    // 第三轮兜底
    const third = candidates.map((s) => {
      const r2 = computeNextCheck({
        websiteId: s.website_id, tier: s.tier, reach: s.reach as never, retryAfterMs: null,
        failFamily: s.fail_family, distinctFailDates: 2, firstFailAt: s.first_fail_at, at: now,
      });
      return (r2.nextCheckAt.getTime() - s.first_fail_at!.getTime()) / DAY;
    });
    console.log(`  第三轮距首次失败: min ${Math.min(...third).toFixed(2)} 天 ${Math.min(...third) >= 14 ? "✅ ≥14" : "❌"}`);
  }

  // ── 不该被动到的集合 ──────────────────────────────────────────────
  const untouched = await prisma.toolLifecycleState.findMany({
    where: { website_id: { notIn: plan.map((p) => p.websiteId) } },
    select: { website_id: true, reach: true, next_check_at: true },
  });
  const byReach = new Map<string, number>();
  for (const u of untouched) byReach.set(u.reach, (byReach.get(u.reach) ?? 0) + 1);
  console.log(`\n不在候选内（保持原排期）${untouched.length} 条: ${[...byReach].map(([k, v]) => `${k}=${v}`).join(" · ")}`);

  if (!APPLY) {
    console.log("\n[dry-run] 加 --apply 才写库");
    return;
  }

  let updated = 0;
  for (const p of plan) {
    await prisma.toolLifecycleState.update({
      where: { website_id: p.websiteId },
      data: { next_check_at: p.next },
    });
    updated++;
  }
  console.log(`\n已重排 ${updated} 条 next_check_at`);

  // 复核：只有候选被改
  const after = await prisma.toolLifecycleState.findMany({
    where: { website_id: { in: plan.map((p) => p.websiteId) } },
    select: { website_id: true, next_check_at: true },
  });
  const want = new Map(plan.map((p) => [p.websiteId, p.next.getTime()]));
  const ok = after.every((a) => a.next_check_at?.getTime() === want.get(a.website_id));
  console.log(`写入校验: ${ok ? "✅ 全部与计划一致" : "❌ 有偏差"}`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
