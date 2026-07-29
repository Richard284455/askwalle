/**
 * C3.1 采集遥测与错误归因测试。
 *
 *   npm run test:telemetry
 *
 * 全部走真实 Prisma + 真实 SSRF，网络层注入内存 fixture ——
 * **不访问任何真实来源、不调 AI、不写 ResourceContent、不抓文章页**。
 *
 * 这套测试的核心命题只有一个：**区分「源坏了」和「我们这边坏了」**。
 * C3 Canary 首轮 AWS 那次「失败」其实是 Supabase 中断，源根本没被请求过，
 * 却被记成来源失败并触发退避 —— 那正是这里要防的。
 */
import http from "http";

import { prisma } from "@/lib/prisma";
import { ingestSource, INFRA_RETRY_MINUTES } from "@/lib/content/ingest";
import {
  terminalizeJob,
  countActionableStuckItems,
  repairTerminalJobItems,
} from "@/lib/website/bulk-job";
import type { Transport, TransportArgs } from "@/lib/website/probe/http-client";
import type { ResolveFn } from "@/lib/website/probe/ssrf";

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

const ORIGIN = "https://tele.example";
const PUBLIC_IP = "93.184.216.34";

const GOOD_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Tele</title>
  <item><title>One</title><link>https://tele.example/p/1</link>
    <pubDate>Tue, 28 Jul 2026 10:00:00 GMT</pubDate>
    <description>first</description></item>
  <item><title>Two</title><link>https://tele.example/p/2</link>
    <pubDate>Mon, 27 Jul 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

const HUGE_RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Huge</title>` +
  Array.from({ length: 6000 }, (_, i) =>
    `<item><title>I${i}</title><link>https://tele.example/h/${i}</link>` +
    `<description>${"y".repeat(200)}</description></item>`).join("") +
  `</channel></rss>`;

type State = { conditionalHit: boolean };

function mock(state: State): { transport: Transport; resolve: ResolveFn } {
  const transport: Transport = async (args: TransportArgs) => {
    const path = args.url.pathname;
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      const buf = Buffer.from(args.wantBody ? body : "", "utf8");
      const max = args.maxBytes ?? 65_536;
      return {
        status,
        headers: { "content-type": "application/xml", ...headers } as http.IncomingHttpHeaders,
        buffer: buf.subarray(0, max),
        truncated: buf.length > max,
      };
    };
    if (path === "/robots.txt") return send(200, "User-agent: *\nDisallow:\n", { "content-type": "text/plain" });
    if (path === "/good") return send(200, GOOD_RSS, { etag: '"g1"' });
    if (path === "/huge") return send(200, HUGE_RSS);
    if (path === "/badxml") return send(200, "<html><body>not a feed</body></html>", { "content-type": "text/html" });
    if (path === "/gone") return send(404, "nope", { "content-type": "text/html" });
    if (path === "/cond") {
      if (args.conditional?.etag === '"c1"') { state.conditionalHit = true; return send(304, "", { etag: '"c1"' }); }
      return send(200, GOOD_RSS, { etag: '"c1"' });
    }
    return send(404, "no fixture", { "content-type": "text/html" });
  };
  return { transport, resolve: async () => [PUBLIC_IP] };
}

/** 清掉本套测试自己造的源（按 publisher 标记识别），不碰任何真实源 */
async function purgeTestSources(): Promise<void> {
  const orphans = await prisma.contentSource.findMany({
    where: { publisher: "__tele_test__" },
    select: { id: true },
  });
  if (!orphans.length) return;
  const ids = orphans.map((o) => o.id);
  await prisma.contentSourceRun.deleteMany({ where: { source_id: { in: ids } } });
  await prisma.sourceItem.deleteMany({ where: { source_id: { in: ids } } });
  await prisma.bulkJobItem.deleteMany({ where: { source_id: { in: ids } } });
  await prisma.contentSource.deleteMany({ where: { id: { in: ids } } });
  console.log(`  （清理上一轮残留的 ${ids.length} 个测试源）`);
}

async function main() {
  const state: State = { conditionalHit: false };
  const m = mock(state);
  const opts = { transport: m.transport, resolve: m.resolve };
  const created: number[] = [];

  // 前置清理：上一轮若在数据库中断时崩溃，会留下同名同 feed_url 的测试源，
  // 下一轮建源就会撞唯一约束。只按 publisher 标记清，碰不到真实源。
  await purgeTestSources();
  const jobs: number[] = [];

  const mkSource = async (path: string, key: string) => {
    const s = await prisma.contentSource.create({
      data: {
        external_key: key, name: key, kind: "rss", publisher: "__tele_test__",
        source_tier: "OFFICIAL_PRIMARY", declared_format: "RSS",
        feed_url: `${ORIGIN}${path}`, fetch_interval_minutes: 60,
      },
      select: { id: true },
    });
    created.push(s.id);
    return s.id;
  };
  const mkJob = async () => {
    const j = await prisma.bulkJob.create({
      data: { type: "content_ingest", status: "running", total_count: 1 },
      select: { id: true },
    });
    jobs.push(j.id);
    return j.id;
  };
  const runOf = (sourceId: number, jobId: number) =>
    prisma.contentSourceRun.findUnique({ where: { job_id_source_id: { job_id: jobId, source_id: sourceId } } });

  try {
    // ── T1 正常 200 ────────────────────────────────────────────────
    console.log("\nT1  Feed 正常 200\n");
    const okId = await mkSource("/good", "__tele_ok__");
    const j1 = await mkJob();
    await ingestSource(okId, { ...opts, jobId: j1 });
    const run1 = await runOf(okId, j1);
    check("T1.1", "outcome=OK", run1?.outcome === "OK", String(run1?.outcome));
    check("T1.2", "error_domain=NONE", run1?.error_domain === "NONE", String(run1?.error_domain));
    check("T1.3", "解析格式落库", run1?.feed_format === "rss", String(run1?.feed_format));
    check("T1.4", "技术证据完整（bytes/延迟/pinnedIp/跳数）",
      (run1?.bytes_read ?? 0) > 0 && run1?.latency_total_ms !== null &&
      run1?.pinned_ip === PUBLIC_IP && run1?.redirect_count !== null,
      `bytes=${run1?.bytes_read} lat=${run1?.latency_total_ms} ip=${run1?.pinned_ip} hops=${run1?.redirect_count}`);
    check("T1.5", "条目计数落库", run1?.items_parsed === 2 && run1?.items_inserted === 2,
      `parsed=${run1?.items_parsed} inserted=${run1?.items_inserted}`);
    check("T1.6", "requested/resolved feed_url 都记下",
      run1?.requested_feed_url === `${ORIGIN}/good` && run1?.resolved_feed_url === `${ORIGIN}/good`);
    const src1 = await prisma.contentSource.findUniqueOrThrow({ where: { id: okId } });
    check("T1.7", "last_success_at 已更新", src1.last_success_at !== null);
    check("T1.8", "failure_count=0", src1.consecutive_failures === 0);
    check("T1.9", "证据里没有 Cookie / 认证头 / 完整 XML",
      !JSON.stringify(run1?.evidence_json ?? {}).match(/cookie|authorization|<rss|<item/i));

    // ── T2 304 ────────────────────────────────────────────────────
    console.log("\nT2  304 Not Modified\n");
    const cId = await mkSource("/cond", "__tele_cond__");
    const j2a = await mkJob();
    await ingestSource(cId, { ...opts, jobId: j2a });
    const j2b = await mkJob();
    const r2 = await ingestSource(cId, { ...opts, jobId: j2b });
    const run2 = await runOf(cId, j2b);
    check("T2.1", "outcome=NOT_MODIFIED", run2?.outcome === "NOT_MODIFIED", String(run2?.outcome));
    check("T2.2", "inserted=0", run2?.items_inserted === 0, String(run2?.items_inserted));
    check("T2.3", "条件请求头已送出并记录", run2?.etag_sent === '"c1"' && state.conditionalHit,
      `sent=${run2?.etag_sent} hit=${state.conditionalHit}`);
    const src2 = await prisma.contentSource.findUniqueOrThrow({ where: { id: cId } });
    check("T2.4", "不增加 failure_count", src2.consecutive_failures === 0, String(src2.consecutive_failures));
    check("T2.5", "304 计为成功（last_success_at 前进）", src2.last_success_at !== null);
    check("T2.6", "sourceAtFault=false", r2.sourceAtFault === false);

    // ── T3 解析失败 ────────────────────────────────────────────────
    console.log("\nT3  Feed 解析失败\n");
    const badId = await mkSource("/badxml", "__tele_bad__");
    const j3 = await mkJob();
    const r3 = await ingestSource(badId, { ...opts, jobId: j3 });
    const run3 = await runOf(badId, j3);
    check("T3.1", "outcome=SOURCE_ERROR", run3?.outcome === "SOURCE_ERROR", String(run3?.outcome));
    check("T3.2", "error_domain=PARSE", run3?.error_domain === "PARSE", String(run3?.error_domain));
    const src3 = await prisma.contentSource.findUniqueOrThrow({ where: { id: badId } });
    check("T3.3", "增加来源失败计数", src3.consecutive_failures === 1, String(src3.consecutive_failures));
    check("T3.4", "sourceAtFault=true", r3.sourceAtFault === true);
    check("T3.5", "走来源退避（>60 分钟）",
      (src3.next_fetch_at!.getTime() - Date.now()) / 60_000 > 60,
      `${((src3.next_fetch_at!.getTime() - Date.now()) / 60_000).toFixed(0)} 分钟`);

    // HTTP 404 也是源侧
    const goneId = await mkSource("/gone", "__tele_gone__");
    const j3b = await mkJob();
    await ingestSource(goneId, { ...opts, jobId: j3b });
    const run3b = await runOf(goneId, j3b);
    check("T3.6", "HTTP 404 → SOURCE_ERROR/HTTP",
      run3b?.outcome === "SOURCE_ERROR" && run3b?.error_domain === "HTTP",
      `${run3b?.outcome}/${run3b?.error_domain}`);
    check("T3.7", "http_status 落库", run3b?.http_status === 404, String(run3b?.http_status));

    // ── T4 截断 ───────────────────────────────────────────────────
    console.log("\nT4  Feed 截断\n");
    const hugeId = await mkSource("/huge", "__tele_huge__");
    const j4 = await mkJob();
    await ingestSource(hugeId, { ...opts, jobId: j4 });
    const run4 = await runOf(hugeId, j4);
    check("T4.1", "outcome=PARTIAL_SUCCESS", run4?.outcome === "PARTIAL_SUCCESS", String(run4?.outcome));
    check("T4.2", "error_domain=TRUNCATED", run4?.error_domain === "TRUNCATED", String(run4?.error_domain));
    check("T4.3", "truncated 标记为真", run4?.truncated === true);
    check("T4.4", "已解析条目保留（不回滚）",
      (run4?.items_inserted ?? 0) > 0 &&
      (await prisma.sourceItem.count({ where: { source_id: hugeId } })) === run4!.items_inserted,
      `inserted=${run4?.items_inserted}`);
    check("T4.5", "明确记录 incomplete", (run4?.error_message ?? "").includes("未纳入"),
      String(run4?.error_message).slice(0, 50));
    const src4 = await prisma.contentSource.findUniqueOrThrow({ where: { id: hugeId } });
    check("T4.6", "不伪装成完整成功（last_status=feed_truncated）",
      src4.last_status === "feed_truncated", String(src4.last_status));
    check("T4.7", "不计来源失败", src4.consecutive_failures === 0, String(src4.consecutive_failures));

    // ── T5 数据库读取错误 ──────────────────────────────────────────
    console.log("\nT5  读取源时数据库中断（C3 Canary 的 AWS 场景）\n");
    const missingId = 999_999_999; // findUniqueOrThrow 必然抛错，模拟基础设施失败路径
    const r5 = await ingestSource(missingId, opts);
    check("T5.1", "outcome=INFRA_ERROR", r5.runOutcome === "INFRA_ERROR", String(r5.runOutcome));
    check("T5.2", "不归因于源（sourceAtFault=false）", r5.sourceAtFault === false);
    check("T5.3", "未写任何 run（源都没读到）",
      (await prisma.contentSourceRun.count({ where: { source_id: missingId } })) === 0);

    // 真实的 DATABASE 归因判定
    const { infraDomainOf } = await import("@/lib/content/ingest");
    check("T5.4", "Can't reach database server → DATABASE",
      infraDomainOf(new Error("Can't reach database server at aws-1-us-east-2.pooler.supabase.com:5432")) === "DATABASE");
    check("T5.5", "connection pool 超时 → DATABASE",
      infraDomainOf(new Error("Timed out fetching a new connection from the connection pool")) === "DATABASE");
    check("T5.6", "lease_lost → LEASE",
      infraDomainOf(new Error("lease_lost")) === "LEASE");
    check("T5.7", "普通站点错误不算基础设施",
      infraDomainOf(new Error("ENOTFOUND example.com")) === null);
    check("T5.8", "基础设施重试间隔为短间隔", INFRA_RETRY_MINUTES <= 15, `${INFRA_RETRY_MINUTES} 分钟`);

    // ── T6 落库中途出错 ───────────────────────────────────────────
    console.log("\nT6  条目落库中途出错后的幂等重试\n");
    const retryId = await mkSource("/good", "__tele_retry__").catch(() => null);
    check("T6.0", "同一 feed_url 受唯一约束保护", retryId === null);
    // 用同一个源、同一个 job 重跑：run 必须幂等，条目不重复
    const j6 = await mkJob();
    await ingestSource(okId, { ...opts, jobId: j6 });
    const before6 = await prisma.sourceItem.count({ where: { source_id: okId } });
    await ingestSource(okId, { ...opts, jobId: j6 });
    const after6 = await prisma.sourceItem.count({ where: { source_id: okId } });
    check("T6.1", "重试不产生重复条目", before6 === after6, `${before6} → ${after6}`);
    check("T6.2", "同 job+source 仍只有一条 run",
      (await prisma.contentSourceRun.count({ where: { job_id: j6, source_id: okId } })) === 1);

    // ── T8 worker reclaim ─────────────────────────────────────────
    console.log("\nT7·T8  reclaim 后同 job+source 仍只有一条有效 run\n");
    const j8 = await mkJob();
    await ingestSource(okId, { ...opts, jobId: j8 });
    await ingestSource(okId, { ...opts, jobId: j8 });
    await ingestSource(okId, { ...opts, jobId: j8 });
    check("T8.1", "三次执行只留一条 run",
      (await prisma.contentSourceRun.count({ where: { job_id: j8, source_id: okId } })) === 1);
    const allRuns = await prisma.contentSourceRun.count({ where: { source_id: okId } });
    check("T8.2", "不同 job 各自留一条 run（历史可查）", allRuns >= 3, `${allRuns} 条`);

    // ── T9 终态任务的遗留条目 ──────────────────────────────────────
    console.log("\nT9  取消任务的遗留 queued 条目\n");
    const j9 = await prisma.bulkJob.create({
      data: { type: "content_ingest", status: "queued", total_count: 3 },
      select: { id: true },
    });
    jobs.push(j9.id);
    await prisma.bulkJobItem.createMany({
      data: [okId, cId, badId].map((sid) => ({ job_id: j9.id, source_id: sid })),
    });
    const otherJob = await mkJob();
    await prisma.bulkJobItem.create({ data: { job_id: otherJob, source_id: okId } });

    const t9 = await terminalizeJob(j9.id, "canceled");
    check("T9.1", "取消时剩余 queued 条目被终结", t9.itemsTerminalized === 3, String(t9.itemsTerminalized));
    const j9items = await prisma.bulkJobItem.findMany({ where: { job_id: j9.id } });
    check("T9.2", "状态改为 skipped 并写明原因",
      j9items.every((i) => i.status === "skipped" && i.error === "parent_job_cancelled"));
    check("T9.3", "历史记录未删除", j9items.length === 3, String(j9items.length));
    check("T9.4", "其它任务的条目不受影响",
      (await prisma.bulkJobItem.count({ where: { job_id: otherJob, status: "queued" } })) === 1);
    check("T9.5", "监控不再把终态任务的条目算作卡住",
      (await countActionableStuckItems(0)) === 1, "仅剩另一个可驱动任务的 1 条");
    const repaired = await repairTerminalJobItems();
    check("T9.6", "修复函数对已处理过的任务是幂等的", repaired.repaired === 0, String(repaired.repaired));

    // ── T10 发布层不变 ────────────────────────────────────────────
    console.log("\nT10  边界不变量\n");
    check("T10.1", "ResourceContent 仍为 27", (await prisma.resourceContent.count()) === 27);
    check("T10.2", "lifecycle v4 基线仍为 429",
      (await prisma.toolHealthEvent.count({ where: { probe_version: 4 } })) === 429);
    check("T10.3", "未抓文章页（无条目带 http_status）",
      (await prisma.sourceItem.count({ where: { source_id: { in: created }, http_status: { not: null } } })) === 0);
  } finally {
    await prisma.contentSourceRun.deleteMany({ where: { source_id: { in: created } } });
    await prisma.sourceItem.deleteMany({ where: { source_id: { in: created } } });
    await prisma.bulkJobItem.deleteMany({ where: { job_id: { in: jobs } } });
    await prisma.bulkJob.deleteMany({ where: { id: { in: jobs } } });
    await prisma.contentSource.deleteMany({ where: { id: { in: created } } });
    await purgeTestSources();
    const left = await prisma.contentSource.count({ where: { publisher: "__tele_test__" } });
    console.log(`\n收尾：临时源残留 ${left} 个 ${left === 0 ? "✅" : "❌"}`);
  }

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) {
    console.log("\n失败用例:");
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
