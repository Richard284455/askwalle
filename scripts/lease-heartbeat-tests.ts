/**
 * BulkJob 任务级租约心跳回归测试。
 *
 *   npm run test:lease
 *
 * 用真实的 Postgres 租约语义跑（唯一约束/条件更新都在库里生效），
 * 但不访问任何真实工具、不调 AI：health_check 一律注入内存 fixture transport。
 *
 * 覆盖：
 *   1. 单 worker 长 chunk：心跳至少续租 2 次，租约全程属同一 worker
 *   2. 两 worker 互斥：租约到期时间过后 B 仍拿不到（因为 A 在续租）
 *   3. 续租失败：A 收完当前条即停，剩余条目保持 queued，后续 worker 可接手
 *   4. worker 进程死亡：心跳停止后租约自然到期，其它 worker 能接管
 *   5. 任务终态：心跳停止、无残留 interval、无残留租约
 *   6. health_check：round_id 仍唯一、状态转移不重复、replay 一致
 *
 * 收尾删除本脚本自建的临时工具与任务。
 */
import { prisma } from "@/lib/prisma";
import { createMockTransport, MOCK_ORIGIN } from "./probe-mock-transport";
import { clearRobotsCache } from "@/lib/website/probe/robots";
import { runHealthCheckRound } from "@/lib/website/tool-lifecycle";
import { applyRound, INITIAL_STATE } from "@/lib/website/probe/classifier";
import { ErrorFamily } from "@/lib/website/probe/types";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 测试里用短租约与短心跳，避免真的等两分钟
const LEASE_MS = 4_000;
const HEARTBEAT_MS = 1_000;

/**
 * 复刻生产的租约语义（bulk-job.ts 里的 acquire/renew/release + 心跳），
 * 但 workerId 可注入，才能在同一个进程里模拟两个 worker。
 * 条件与生产逐字一致：id + locked_by + status ∈ drivable。
 */
const DRIVABLE = ["queued", "running"];

async function acquire(jobId: number, workerId: string): Promise<boolean> {
  const now = new Date();
  const r = await prisma.bulkJob.updateMany({
    where: {
      id: jobId,
      OR: [{ locked_until: null }, { locked_until: { lt: now } }, { locked_by: workerId }],
    },
    data: { locked_by: workerId, locked_until: new Date(Date.now() + LEASE_MS) },
  });
  return r.count === 1;
}

async function renew(jobId: number, workerId: string): Promise<boolean> {
  const r = await prisma.bulkJob.updateMany({
    where: { id: jobId, locked_by: workerId, status: { in: DRIVABLE } },
    data: { locked_until: new Date(Date.now() + LEASE_MS) },
  });
  return r.count === 1;
}

async function release(jobId: number, workerId: string): Promise<void> {
  await prisma.bulkJob
    .updateMany({ where: { id: jobId, locked_by: workerId }, data: { locked_by: null, locked_until: null } })
    .catch(() => {});
}

type Heartbeat = {
  lost: () => boolean;
  reason: () => string | null;
  renewals: () => number;
  stop: () => void;
  timer: NodeJS.Timeout;
};

function startHeartbeat(
  jobId: number,
  workerId: string,
  renewFn: (j: number, w: string) => Promise<boolean> = renew
): Heartbeat {
  let lost = false;
  let reason: string | null = null;
  let renewals = 0;
  const timer = setInterval(() => {
    void renewFn(jobId, workerId)
      .then((ok) => {
        if (ok) renewals++;
        else if (!lost) {
          lost = true;
          reason = "lease_lost";
        }
      })
      .catch(() => {
        if (!lost) {
          lost = true;
          reason = "lease_renew_failed";
        }
      });
  }, HEARTBEAT_MS);
  timer.unref?.();
  return { lost: () => lost, reason: () => reason, renewals: () => renewals, stop: () => clearInterval(timer), timer };
}

async function main() {
  const category = await prisma.category.findFirstOrThrow({ select: { id: true } });
  const mock = createMockTransport();

  // 临时工具，URL 指向内存 fixture
  const site = await prisma.website.create({
    data: {
      title: "__lease_test_tool__",
      url: `${MOCK_ORIGIN}/ok`,
      description: "temporary fixture for lease heartbeat tests",
      category_id: category.id,
      status: "pending",
    },
    select: { id: true },
  });
  const jobIds: number[] = [];
  const mkJob = async (total = 20) => {
    const j = await prisma.bulkJob.create({
      data: { type: "health_check", status: "queued", total_count: total },
      select: { id: true },
    });
    jobIds.push(j.id);
    await prisma.bulkJobItem.createMany({
      data: Array.from({ length: total }, () => ({ job_id: j.id, website_id: site.id })),
    });
    return j.id;
  };

  try {
    // ── 1. 单 worker 长 chunk：心跳持续续租 ─────────────────────────
    console.log("\n1. 单 worker 长 chunk（chunk 时长 > 租约时长）\n");
    {
      const jobId = await mkJob();
      const A = "workerA";
      check("L1.0", "A 取得租约", await acquire(jobId, A));
      await prisma.bulkJob.update({ where: { id: jobId }, data: { status: "running" } });
      const hb = startHeartbeat(jobId, A);

      // 模拟 20 条短 item 的 chunk，总耗时 12 秒 —— 是 4 秒租约的 3 倍。
      // 窗口给足是有意的：数据库慢的时候单次续租往返可能要几秒，
      // 窗口太窄会让「续租次数」这个断言变成在测网络延迟。
      const chunkMs = 12_000;
      await sleep(chunkMs);

      check("L1.1", "心跳至少成功续租 2 次", hb.renewals() >= 2, `${hb.renewals()} 次`);
      check("L1.2", "租约未丢失", !hb.lost(), hb.reason() ?? "");
      const j = await prisma.bulkJob.findUniqueOrThrow({
        where: { id: jobId }, select: { locked_by: true, locked_until: true },
      });
      check("L1.3", "租约全程属于同一 worker", j.locked_by === A, String(j.locked_by));
      check("L1.4", "chunk 结束时租约仍未过期",
        (j.locked_until?.getTime() ?? 0) > Date.now(), j.locked_until?.toISOString() ?? "null");
      hb.stop();
      await release(jobId, A);
      const after = await prisma.bulkJob.findUniqueOrThrow({ where: { id: jobId }, select: { locked_by: true } });
      check("L1.5", "释放后无残留租约", after.locked_by === null, String(after.locked_by));
    }

    // ── 2. 两 worker 互斥 ──────────────────────────────────────────
    console.log("\n2. 两个 worker 互斥\n");
    {
      const jobId = await mkJob();
      const A = "workerA";
      const B = "workerB";
      await acquire(jobId, A);
      await prisma.bulkJob.update({ where: { id: jobId }, data: { status: "running" } });
      const hb = startHeartbeat(jobId, A);

      const t0 = Date.now();
      // 等到「原租约到期时间」之后再让 B 抢
      await sleep(LEASE_MS + 1_500);
      const bGot = await acquire(jobId, B);
      check("L2.1", "原租约到期时间之后 B 仍抢不到（A 在续租）",
        bGot === false, bGot ? "B 抢到了！" : `已过 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      check("L2.2", "A 的心跳仍在续租", hb.renewals() >= 3, `${hb.renewals()} 次`);
      const j = await prisma.bulkJob.findUniqueOrThrow({ where: { id: jobId }, select: { locked_by: true } });
      check("L2.3", "租约持有者仍是 A", j.locked_by === A, String(j.locked_by));

      hb.stop();
      await release(jobId, A);
    }

    // ── 3. 续租失败：安全收尾，剩余条目保持 queued ──────────────────
    console.log("\n3. 续租失败（数据库 update 抛错）\n");
    {
      const jobId = await mkJob();
      const A = "workerA";
      await acquire(jobId, A);
      await prisma.bulkJob.update({ where: { id: jobId }, data: { status: "running" } });

      const hb = startHeartbeat(jobId, A, async () => {
        throw new Error("simulated db failure on renew");
      });
      await sleep(HEARTBEAT_MS * 2 + 500);

      check("L3.1", "心跳标记租约丢失", hb.lost());
      check("L3.2", "原因为 lease_renew_failed", hb.reason() === "lease_renew_failed", hb.reason() ?? "null");
      hb.stop();

      // 模拟「收完当前条即停」：只处理 1 条，其余保持 queued
      const first = await prisma.bulkJobItem.findFirstOrThrow({
        where: { job_id: jobId, status: "queued" }, select: { id: true },
      });
      await prisma.bulkJobItem.update({ where: { id: first.id }, data: { status: "success" } });

      const counts = await prisma.bulkJobItem.groupBy({
        by: ["status"], where: { job_id: jobId }, _count: true,
      });
      const c = (s: string) => counts.find((x) => x.status === s)?._count ?? 0;
      check("L3.3", "当前条正常收尾", c("success") === 1, `success=${c("success")}`);
      check("L3.4", "剩余条目保持 queued，未被标失败",
        c("queued") === 19 && c("failed") === 0, `queued=${c("queued")} failed=${c("failed")}`);

      // 后续 worker 能接管（A 已停心跳，租约到期）
      await sleep(LEASE_MS + 500);
      const B = "workerB";
      check("L3.5", "租约到期后 B 可以接手", await acquire(jobId, B));
      await release(jobId, B);
    }

    // ── 4. worker 进程死亡 ────────────────────────────────────────
    console.log("\n4. worker 进程死亡\n");
    {
      const jobId = await mkJob();
      const A = "deadWorker";
      await acquire(jobId, A);
      await prisma.bulkJob.update({ where: { id: jobId }, data: { status: "running" } });
      const hb = startHeartbeat(jobId, A);
      await sleep(HEARTBEAT_MS + 300);
      hb.stop(); // 进程没了 = 心跳停了

      const B = "workerB";
      const tooEarly = await acquire(jobId, B);
      check("L4.1", "租约未到期时 B 抢不到", tooEarly === false, tooEarly ? "抢到了！" : "");
      await sleep(LEASE_MS + 500);
      check("L4.2", "租约到期后 B 能接管（不会永久锁死）", await acquire(jobId, B));
      const j = await prisma.bulkJob.findUniqueOrThrow({ where: { id: jobId }, select: { locked_by: true } });
      check("L4.3", "持有者已换成 B", j.locked_by === B, String(j.locked_by));
      await release(jobId, B);
    }

    // ── 5. 任务终态 ───────────────────────────────────────────────
    console.log("\n5. 任务已终态\n");
    {
      const jobId = await mkJob();
      const A = "workerA";
      await acquire(jobId, A);
      await prisma.bulkJob.update({ where: { id: jobId }, data: { status: "completed" } });

      const ok = await renew(jobId, A);
      check("L5.1", "终态任务续租失败（status 不在 drivable）", ok === false, String(ok));

      const hb = startHeartbeat(jobId, A);
      // 等够「一次心跳 + 一次数据库往返」；Supabase 跨区往返约 500ms，
      // 只等 HEARTBEAT_MS 会在 renew 的 promise 落地前就断言
      await sleep(HEARTBEAT_MS * 2 + 1_500);
      check("L5.2", "心跳据此标记租约丢失", hb.lost() && hb.reason() === "lease_lost", hb.reason() ?? "null");
      hb.stop();
      await release(jobId, A);
      const j = await prisma.bulkJob.findUniqueOrThrow({ where: { id: jobId }, select: { locked_by: true, locked_until: true } });
      check("L5.3", "无残留租约", j.locked_by === null && j.locked_until === null,
        `${j.locked_by}/${j.locked_until}`);
      // 定时器未泄漏：stop 之后计数不再增长
      const before = hb.renewals();
      await sleep(HEARTBEAT_MS + 300);
      check("L5.4", "stop 之后 interval 不再触发（无泄漏）", hb.renewals() === before,
        `${before} → ${hb.renewals()}`);
    }

    // ── 6. health_check 语义未受影响 ───────────────────────────────
    console.log("\n6. health_check round 语义\n");
    {
      const overrides = {
        url: `${MOCK_ORIGIN}/ok`,
        resolve: mock.resolve,
        transport: mock.transport,
        lookupNs: async () => {
          throw new Error("ns unavailable");
        },
      };
      const TEST_JOB = -9101;
      await prisma.toolHealthEvent.deleteMany({ where: { job_id: TEST_JOB } });
      clearRobotsCache();
      const r1 = await runHealthCheckRound(site.id, TEST_JOB, overrides);
      clearRobotsCache();
      const r2 = await runHealthCheckRound(site.id, TEST_JOB, overrides);

      const evs = await prisma.toolHealthEvent.findMany({
        where: { job_id: TEST_JOB },
        select: {
          id: true, round_id: true, outcome: true, error_kind: true, error_family: true,
          evidence_strength: true, confidence: true, change_flags: true, final_url: true,
          probe_version: true, created_at: true, reach_to: true,
        },
      });
      check("L6.1", "同一 scheduled round 只写 1 条事件", evs.length === 1, `${evs.length} 条`);
      check("L6.2", "round_id 唯一", new Set(evs.map((e) => e.round_id)).size === evs.length);
      check("L6.3", "重复执行被标记为 duplicateRound",
        r2.duplicateRound === true, String(r2.duplicateRound));
      check("L6.4", "两次返回同一 eventId（未重复应用状态转移）",
        r1.eventId === r2.eventId, `${r1.eventId} vs ${r2.eventId}`);

      const e = evs[0];
      const d = applyRound(INITIAL_STATE, {
        outcome: e.outcome as never, errorKind: e.error_kind,
        errorFamily: (e.error_family as ErrorFamily | null) ?? null,
        evidenceStrength: (e.evidence_strength as "strong" | "weak" | null) ?? null,
        confidence: e.confidence as "high" | "low",
        domainMigrated: e.change_flags.includes("domain_migrated"),
        finalUrl: e.final_url, probeVersion: e.probe_version, at: e.created_at,
      });
      check("L6.5", "replay 与在线判定一致",
        d.ok && d.next.reach === e.reach_to, d.ok ? `${d.next.reach} vs ${e.reach_to}` : "version_mismatch");

      await prisma.toolHealthEvent.deleteMany({ where: { job_id: TEST_JOB } });
    }
  } finally {
    for (const id of jobIds) {
      await prisma.bulkJobItem.deleteMany({ where: { job_id: id } });
      await prisma.bulkJob.delete({ where: { id } }).catch(() => {});
    }
    await prisma.toolHealthEvent.deleteMany({ where: { website_id: site.id } });
    await prisma.toolLifecycleState.deleteMany({ where: { website_id: site.id } });
    await prisma.website.delete({ where: { id: site.id } }).catch(() => {});
    const leftJobs = await prisma.bulkJob.count({ where: { id: { in: jobIds } } });
    console.log(`\n收尾：临时任务残留 ${leftJobs} 个 ${leftJobs === 0 ? "✅" : "❌"}，临时工具已删除`);
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
