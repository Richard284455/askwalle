/**
 * D4：round exactly-once 测试。
 *
 *   npm run test:round
 *
 * 走**真实的落库路径**（runHealthCheckRound + Postgres 唯一约束），
 * 但网络层注入内存 fixture：不访问任何真实工具、不调 AI。
 *
 * 覆盖：
 *   - 两个执行者并发写同一 round → 只留 1 条事件、只发生 1 次状态转移
 *   - worker 回收后重跑同一 round → 不重复累加 consecutive_fails
 *   - 唯一约束在数据库层真实存在
 *
 * 收尾会删掉本脚本自己刚建的事件并还原被借用工具的状态。
 * 删的是测试几秒前造的产物，不是探测历史。
 */
import { prisma } from "@/lib/prisma";
import { runHealthCheckRound } from "@/lib/website/tool-lifecycle";
import { createMockTransport, MOCK_HOST } from "./probe-mock-transport";
import { clearRobotsCache } from "@/lib/website/probe/robots";

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

// 一个不会与真实任务撞车的 job_id
const TEST_JOB_ID = -9001;

async function main() {
  const mock = createMockTransport();
  // 所有 fixture 主机都指向内存 transport；被借用工具的真实 URL 一个包都不会发出去
  const overrides = {
    url: `https://${MOCK_HOST}/ok`,
    resolve: mock.resolve,
    transport: mock.transport,
    lookupNs: async () => {
      throw new Error("ns unavailable");
    },
  };
  const failOverrides = { ...overrides, url: `https://${MOCK_HOST}/500` };

  // 借用 id 最小的工具，只碰它的 lifecycle 状态，不碰 Website 任何字段
  const site = await prisma.website.findFirstOrThrow({
    orderBy: { id: "asc" },
    select: { id: true, title: true, url: true, status: true, active: true },
  });
  const websiteId = site.id;
  console.log(`\n借用工具 #${websiteId} ${site.title}（只改 lifecycle 状态，Website 不动）\n`);

  const before = await prisma.toolLifecycleState.findUnique({ where: { website_id: websiteId } });
  const cleanup = async () => {
    await prisma.toolHealthEvent.deleteMany({ where: { job_id: TEST_JOB_ID } });
    if (before) {
      // 原样写回快照；drift_fields 是 Json?，Prisma 的读写类型不互通，只能断言
      await prisma.toolLifecycleState.update({
        where: { website_id: websiteId },
        data: before as never,
      });
    } else {
      await prisma.toolLifecycleState.deleteMany({ where: { website_id: websiteId } });
    }
  };

  try {
    // ── 0. 唯一约束确实在库里 ────────────────────────────────────────
    const idx = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'tool_health_events' AND indexdef ILIKE '%round_id%'
    `;
    check("D4.0", "round_id 唯一索引已建立",
      idx.some((i) => /UNIQUE/i.test(i.indexdef)),
      idx.map((i) => i.indexname).join(",") || "无");

    // ── 1. 并发：两个执行者同时写同一 round ─────────────────────────
    await prisma.toolHealthEvent.deleteMany({ where: { job_id: TEST_JOB_ID } });
    clearRobotsCache();
    const [a, b] = await Promise.all([
      runHealthCheckRound(websiteId, TEST_JOB_ID, overrides),
      runHealthCheckRound(websiteId, TEST_JOB_ID, overrides),
    ]);

    const events1 = await prisma.toolHealthEvent.findMany({
      where: { job_id: TEST_JOB_ID },
      select: { id: true, round_id: true },
    });
    check("D4.1", "并发两次 → 只留 1 条事件", events1.length === 1, `${events1.length} 条`);
    check("D4.2", "  └ 两个执行者拿到同一个 eventId",
      a.eventId === b.eventId, `${a.eventId} vs ${b.eventId}`);
    check("D4.3", "  └ 恰好一个被判定为重复轮次",
      [a, b].filter((r) => r.duplicateRound === true).length === 1,
      `duplicateRound: ${[a, b].map((r) => String(r.duplicateRound)).join(",")}`);

    // ── 2. worker 回收后重跑同一 round：失败不得重复累加 ─────────────
    await prisma.toolHealthEvent.deleteMany({ where: { job_id: TEST_JOB_ID } });
    await prisma.toolLifecycleState.update({
      where: { website_id: websiteId },
      data: {
        reach: "unknown", consecutive_fails: 0, distinct_fail_dates: 0,
        first_fail_at: null, last_fail_date: null, fail_family: null,
        last_error_kind: null, last_checked_at: null, probe_version: null,
      },
    });

    clearRobotsCache();
    const first = await runHealthCheckRound(websiteId, TEST_JOB_ID, failOverrides);
    const afterFirst = await prisma.toolLifecycleState.findUniqueOrThrow({
      where: { website_id: websiteId },
    });
    check("D4.4", "首次失败轮：streak=1",
      afterFirst.consecutive_fails === 1, `streak=${afterFirst.consecutive_fails} outcome=${first.outcome}`);

    // 模拟僵死回收：同一 job、同一天、同一工具再跑一遍
    clearRobotsCache();
    const second = await runHealthCheckRound(websiteId, TEST_JOB_ID, failOverrides);
    const afterSecond = await prisma.toolLifecycleState.findUniqueOrThrow({
      where: { website_id: websiteId },
    });
    check("D4.5", "回收后重跑 → 标记为重复轮次",
      second.duplicateRound === true, String(second.duplicateRound));
    check("D4.6", "  └ streak 仍为 1（没有重复累加）",
      afterSecond.consecutive_fails === 1, `streak=${afterSecond.consecutive_fails}`);
    check("D4.7", "  └ distinct_fail_dates 仍为 1",
      afterSecond.distinct_fail_dates === 1, `dates=${afterSecond.distinct_fail_dates}`);
    check("D4.8", "  └ 仍然只有 1 条事件",
      (await prisma.toolHealthEvent.count({ where: { job_id: TEST_JOB_ID } })) === 1);
    check("D4.9", "  └ last_checked_at 未被第二次覆盖",
      afterSecond.last_checked_at?.getTime() === afterFirst.last_checked_at?.getTime(),
      `${afterFirst.last_checked_at?.toISOString()} vs ${afterSecond.last_checked_at?.toISOString()}`);

    // ── 3. Website 一个字段都没动 ───────────────────────────────────
    const siteAfter = await prisma.website.findUniqueOrThrow({
      where: { id: websiteId },
      select: { url: true, status: true, active: true },
    });
    check("D4.10", "Website.url/status/active 未被修改",
      siteAfter.url === site.url && siteAfter.status === site.status && siteAfter.active === site.active,
      JSON.stringify(siteAfter));
  } finally {
    await cleanup();
    const leftover = await prisma.toolHealthEvent.count({ where: { job_id: TEST_JOB_ID } });
    const restored = await prisma.toolLifecycleState.findUnique({ where: { website_id: websiteId } });
    console.log(
      `\n收尾：测试事件残留 ${leftover} 条 ${leftover === 0 ? "✅" : "❌"} · ` +
        `工具 #${websiteId} 状态已还原为 reach=${restored?.reach} ` +
        `last_checked_at=${restored?.last_checked_at?.toISOString() ?? "null"}`
    );
  }

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) {
    console.log("\n失败用例:");
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
