/**
 * AI HOT 定时抓取 / 自动草稿 / 编辑审核队列的回归测试。
 *
 *   npm run test:scheduled
 *
 * **不发任何外部请求**（HTTP 全走注入的 fixture 传输层），
 * **不调用 provider**（generate/freeze 全部注入假实现），
 * **不发布**（每一节收尾都核对发布记录数没变）。
 *
 * 租约与运行审计跑真实 Postgres —— 互斥语义只有在库里才成立，
 * 用内存对象模拟出来的「并发安全」证明不了任何事。收尾删除自建数据。
 */
import type { AihotTaskType } from "@prisma/client";

import {
  clearSelectedCursor, ENDPOINTS, fetchAihot, LIMITS, loadSelectedCursor, saveSelectedCursor,
  type AihotTransport,
} from "@/lib/content/aihot/client";
import { backfillSelected, syncSelectedChanges } from "@/lib/content/aihot/sync";
import {
  acquireLease, releaseLease, renewLease, residualLeases,
} from "@/lib/content/aihot/lease";
import { runScheduledTask, runAllScheduledTasks, TASK_SCHEDULE, ALL_TASKS } from "@/lib/content/aihot/scheduler";
import { hotTopicHash, storyPublicIdFromUrl, textSimilarity, type AihotHotTopicDto } from "@/lib/content/aihot/types";
import { decideDigest } from "@/lib/content/aihot/ingest";
import { resolveNewsroomModel, saveNewsroomModel } from "@/lib/content/multilingual/model-settings";
import { hotTopicFactFingerprint, type HotTopicMaterial } from "@/lib/content/publishing/eligibility";
import { diffProtectedState, type ProtectedState } from "@/lib/content/publishing/protected-baseline";
import { buildComparison, tabOf, QUEUE_TABS, type LocaleContent, type QueueRow } from "@/lib/content/publishing/queue";
import { reviewerIdentityIssue } from "@/lib/content/publishing/review";
import { LOCALES, publicPath } from "@/lib/content/publishing/types";
import { prisma } from "@/lib/prisma";

import { readFileSync } from "fs";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(id: string, name: string, ok: boolean, detail = "") {
  if (ok) pass++; else { fail++; failures.push(`${id} ${name}${detail ? ` — ${detail}` : ""}`); }
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const section = (t: string) => console.log(`\n${t}\n`);

// ── fixture 传输层 ────────────────────────────────────────────────────────

type Step = { status: number; headers?: Record<string, string>; body?: unknown | string };
function scripted(steps: Step[]) {
  let i = 0;
  const seen: Record<string, string>[] = [];
  const transport: AihotTransport = async ({ headers }) => {
    seen.push(headers);
    const s = steps[Math.min(i, steps.length - 1)];
    i++;
    if (s.status === 0) throw new Error("模拟网络中断");
    return { status: s.status, headers: s.headers ?? {}, text: typeof s.body === "string" ? s.body : JSON.stringify(s.body ?? {}) };
  };
  return { transport, calls: () => i, seen };
}

/** 记录退避等待，验证 Retry-After 与指数退避真的被遵守 */
function recorder() {
  const waits: number[] = [];
  return { waits, wait: async (ms: number) => { waits.push(ms); } };
}

const TEST_WORKER = "scheduled-ops-tests";

/**
 * 只留代码，剔掉注释。
 *
 * 「源码里不出现 X」这类断言必须扫代码，不能扫注释 ——
 * 一句「本模块不创建 AIEvent」的说明会让断言自己把自己判红，
 * 而那正是最容易被当成「测试不靠谱」删掉的那种假警报。
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 全程零 provider 调用的假生成器 */
function fakeGenerate(status: "OK" | "EXISTING" | "GENERATION_FAILED" = "EXISTING") {
  const seen: string[] = [];
  return {
    seen,
    fn: async (a: { kind: string; id: number }) => {
      seen.push(`${a.kind}:${a.id}`);
      return {
        unitKey: `${a.kind.toLowerCase()}:${a.id}`,
        contentForm: null,
        status,
        providerCalls: status === "EXISTING" ? 0 : 1,
        languages: LOCALES.map((l) => ({
          language: l, draftId: 0, status: status === "OK" ? "DRAFTED" : status,
          issueCount: 0, issues: [], headline: "x",
        })),
        message: null,
      } as never;
    },
  };
}

const fakeFreeze = async (unitKey: string) =>
  ({ unitKey, familyId: null, slug: null, status: "SKIPPED" as const, created: [], unchanged: [], message: "测试注入，不冻结" });

async function cleanupRuns() {
  await prisma.aihotTaskRun.deleteMany({ where: { worker_id: { startsWith: TEST_WORKER } } });
  for (const t of ALL_TASKS) await releaseLease(t, TEST_WORKER).catch(() => undefined);
}

async function main() {
  const publicationsAtStart = await prisma.articlePublication.count();
  const draftsAtStart = await prisma.multilingualDraft.count();
  const familiesAtStart = await prisma.articleFamily.count();

  // ────────────────────────────────────────────────────────────────────────
  section("一、定时抓取：ETag / 304 / 429 / 5xx / 4xx");

  {
    const { transport, seen } = scripted([{ status: 200, headers: { etag: 'W/"v1"' }, body: { items: [] } }]);
    const r = await fetchAihot("/api/v1/hot-topics", { transport, etag: 'W/"v0"' });
    check("A1", "带 ETag 时发出 If-None-Match", seen[0]["If-None-Match"] === 'W/"v0"');
    check("A2", "200 返回 data 与新 etag", r.ok && r.status === 200 && r.etag === 'W/"v1"');
  }

  {
    const { transport } = scripted([{ status: 304, headers: { etag: 'W/"v0"' } }]);
    const r = await fetchAihot("/api/v1/hot-topics", { transport, etag: 'W/"v0"' });
    check("A3", "304 返回 data=null（调用方不得据此写库）", r.ok && r.status === 304 && r.data === null);
  }

  {
    const rec = recorder();
    const { transport, calls } = scripted([
      { status: 429, headers: { "retry-after": "3" } },
      { status: 200, body: { items: [] } },
    ]);
    const r = await fetchAihot("/api/v1/hot-topics", { transport, wait: rec.wait });
    check("A4", "429 按 Retry-After 秒数等待", rec.waits[0] === 3000, `等待 ${rec.waits.join(",")}`);
    check("A5", "限流后重试成功", r.ok && calls() === 2);
  }

  {
    const rec = recorder();
    const at = new Date(Date.now() + 5000).toUTCString();
    const { transport } = scripted([{ status: 429, headers: { "retry-after": at } }, { status: 200, body: {} }]);
    await fetchAihot("/api/v1/hot-topics", { transport, wait: rec.wait });
    check("A6", "Retry-After 为 HTTP 日期时也能解析", rec.waits[0] > 3000 && rec.waits[0] <= 5000, `${rec.waits[0]}ms`);
  }

  {
    const rec = recorder();
    const { transport, calls } = scripted([
      { status: 503 }, { status: 503 }, { status: 200, body: { items: [] } },
    ]);
    const r = await fetchAihot("/api/v1/hot-topics", { transport, wait: rec.wait });
    check("A7", "5xx 指数退避", rec.waits[0] === 800 && rec.waits[1] === 1600, rec.waits.join(","));
    check("A8", "退避后成功", r.ok && calls() === 3);
  }

  {
    const { transport, calls } = scripted([{ status: 404 }]);
    const r = await fetchAihot("/api/v1/hot-topics", { transport });
    check("A9", "4xx 不重试", calls() === 1);
    check("A10", "4xx 不回显响应体", !r.ok && !/\{|\}/.test(r.reason));
  }

  {
    const observed: string[] = [];
    const rec = recorder();
    const { transport } = scripted([
      { status: 429, headers: { "retry-after": "1" } }, { status: 503 }, { status: 200, body: {} },
    ]);
    await fetchAihot("/api/v1/hot-topics", {
      transport, wait: rec.wait, observe: (e) => observed.push(e.kind),
    });
    check("A11", "退避事件可被审计观察", observed.join(",") === "rate_limited,server_error", observed.join(","));
  }

  {
    const { transport, calls } = scripted([{ status: 200, body: {} }]);
    const r = await fetchAihot("/api/public/items", { transport });
    check("A12", "非 v1 端点被拒（不碰已废弃的 /api/public/*）", !r.ok && calls() === 0);
  }

  // ────────────────────────────────────────────────────────────────────────
  section("一之二、全量回填与增量水位");

  {
    // 端点契约：分页用 page，增量用 cursor —— 混用会让增量从错误位置开始
    const snap = ENDPOINTS.selectedSnapshot({ limit: 1000, page: "P1" });
    check("S1", "snapshot 用 page 翻页", /[?&]page=P1/.test(snap.path) && !/cursor=/.test(snap.path), snap.path);
    check("S2", "snapshot 默认取完整字段（minimal 没有 summary，取了也生成不了）",
      /fields=default/.test(ENDPOINTS.selectedSnapshot({ limit: 10 }).path));
    const ch = ENDPOINTS.selectedChanges("C1", 100);
    check("S3", "changes 用 cursor 续传", /[?&]cursor=C1/.test(ch.path) && !/page=/.test(ch.path), ch.path);
    check("S4", "分页上限与 API 一致", LIMITS.snapshotPage === 1000 && LIMITS.changesPage === 100 && LIMITS.dailyIndex === 180);
  }

  {
    // 全量：翻到 hasMore=false 为止，逐页累计
    const page1 = {
      cursor: "cur-1", hasMore: true, nextPage: "p2",
      items: [{ id: "s-1", title: "T1", summary: "x".repeat(60), links: { aihot: "https://aihot.virxact.com/items/aaaaaaaa" } }],
    };
    const page2 = {
      cursor: "cur-2", hasMore: false,
      items: [{ id: "s-2", title: "T2", summary: "y".repeat(60), links: { aihot: "https://aihot.virxact.com/items/bbbbbbbb" } }],
    };
    const { transport, calls } = scripted([
      { status: 200, body: page1 }, { status: 200, body: page2 },
    ]);
    const r = await backfillSelected({ transport, dryRun: true });
    check("S5", "全量翻完所有页", r.status === "OK" && r.pages === 2 && calls() === 2, `${r.pages} 页 / ${calls()} 次请求`);
    check("S6", "取回条数累计", r.fetched === 2, String(r.fetched));
    check("S7", "水位取最后一页的 cursor", r.cursor === "cur-2", String(r.cursor));
  }

  /*
   * 本节会动到**生产的同步水位**。
   * 不还原的话，下一次定时任务会以为从没全量过，白白重拉三千条快照 ——
   * 测试的副作用不该变成运行时的成本。
   */
  const savedCursor = await loadSelectedCursor();

  {
    // 增量：没有水位时必须明说要全量，绝不能偷偷改成「拉最近 24 小时」
    await clearSelectedCursor();
    const r = await syncSelectedChanges({ transport: scripted([{ status: 200, body: {} }]).transport, dryRun: true });
    check("S8", "无水位时要求先做全量", r.status === "SNAPSHOT_REQUIRED", r.message ?? "");
  }

  {
    await saveSelectedCursor("cur-test");
    const body = {
      cursor: "cur-next", hasMore: false,
      changes: [
        { op: "upsert", changedAt: "2026-08-02T00:00:00Z",
          item: { id: "s-3", title: "T3", summary: "z".repeat(60), links: { aihot: "https://aihot.virxact.com/items/cccccccc" } } },
        { op: "remove", changedAt: "2026-08-02T00:00:00Z", id: "s-gone" },
      ],
    };
    const r = await syncSelectedChanges({ transport: scripted([{ status: 200, body }]).transport, dryRun: true });
    check("S9", "增量能处理 upsert", r.status === "OK" && r.created + r.updated + r.unchanged === 1, JSON.stringify(r));
    check("S10", "增量能处理 remove（取消精选）", r.removed === 1, String(r.removed));

    // 409 = 水位失效，唯一正确反应是重做全量，不是继续用旧水位
    const r409 = await syncSelectedChanges({ transport: scripted([{ status: 409 }]).transport, dryRun: true });
    check("S11", "409 要求重做全量", r409.status === "SNAPSHOT_REQUIRED", r409.message ?? "");
  }

  {
    // 还原生产水位，并核对确实还原了
    await clearSelectedCursor();
    if (savedCursor) await saveSelectedCursor(savedCursor);
    check("S17", "测试没有破坏生产同步水位",
      (await loadSelectedCursor()) === savedCursor,
      savedCursor ? `已还原（长度 ${savedCursor.length}）` : "本来就没有水位");
  }

  {
    // publicId 只能从 links.story 末段取，**绝不自行拼接**
    check("S18", "从 links.story 末段提取 publicId",
      storyPublicIdFromUrl("https://aihot.virxact.com/story/dcda0e3a-e856-44a8-b502-17fa0707ef51")
        === "dcda0e3a-e856-44a8-b502-17fa0707ef51");
    check("S19", "links.story 缺失时不猜 id", storyPublicIdFromUrl(null) === null
      && storyPublicIdFromUrl(undefined) === null);
    check("S20", "条目页地址不是 story 地址（早先误用 topic.id 拿到 404）",
      storyPublicIdFromUrl("https://aihot.virxact.com/items/cmsa77lmk02tcrox0gfhj3rcq") === null);

    const dto: AihotHotTopicDto = {
      id: "t", title: "T", sourceCount: 3, signalCount: 5, sourceNames: ["A"],
      links: { aihot: "https://aihot.virxact.com/items/abcdefgh" }, latestAt: "2026-08-01T00:00:00Z",
    };
    check("S21", "story digest 进内容指纹（digest 被重写就该出新版本）",
      hotTopicHash(dto, "digest-v1") !== hotTopicHash(dto, "digest-v2"));
    check("S22", "没有 digest 时指纹与旧口径一致", hotTopicHash(dto, null) === hotTopicHash(dto));

    check("S23", "未筛选流是独立任务类型", ALL_TASKS.includes("ITEMS_ALL"));
    check("S24", "未筛选流的调度周期在 7 天窗口内（掉出窗口就补不回来）",
      TASK_SCHEDULE.ITEMS_ALL.everyMs < 7 * 24 * 60 * 60_000,
      TASK_SCHEDULE.ITEMS_ALL.cron);

    const g = fakeGenerate("OK");
    const r = await runScheduledTask("ITEMS_ALL", {
      workerId: `${TEST_WORKER}-all`,
      transport: scripted([{ status: 200, body: { items: [], page: { hasMore: false } } }]).transport,
      generate: g.fn, freeze: fakeFreeze,
    });
    check("S25", "未筛选流只入库、不出稿", r.unitsConsidered === 0 && g.seen.length === 0 && r.providerCalls === 0,
      `候选 ${r.unitsConsidered} · 生成 ${g.seen.length}`);
    check("S26", "未筛选流同样零发布", r.publicationsCreated === 0);
  }

  {
    // ── digest 重写节流 ──
    const long = "OpenAI 宣布其下一代模型 Astra 解决了数学与理论计算机科学领域的十项重大开放问题，总成本约两千美元。";
    // 纯排版改动：只动标点与空格，归一化后逐字相同
    const cosmetic = "OpenAI 宣布其下一代模型 Astra 解决了数学与理论计算机科学领域的十项重大开放问题、总成本约两千美元";
    // 换了写法但意思一样 —— 这种**算**实质变化，一天最多重写一次已经够克制了
    const reworded = "OpenAI 宣布其下一代模型 Astra 解决了数学与理论计算机科学领域的十项重大开放问题，总成本约 2000 美元。";
    const rewritten = "苹果发布新款芯片，性能较上一代提升四成，将于第四季度随新机型出货，售价维持不变。";
    const dayAgo = new Date(Date.now() - 25 * 60 * 60_000);
    const hourAgo = new Date(Date.now() - 60 * 60_000);

    check("T1", "首次拿到 digest 直接采纳",
      decideDigest({ incoming: long, stored: null, storedAt: null }).adopted);
    check("T2", "纯排版改动不触发重写",
      decideDigest({ incoming: cosmetic, stored: long, storedAt: dayAgo }).adopted === false,
      `相似度 ${textSimilarity(cosmetic, long).toFixed(3)}`);
    check("T2b", "换写法算实质变化（隔天才会被采纳，不会当天连改）",
      decideDigest({ incoming: reworded, stored: long, storedAt: dayAgo }).reason === "MATERIAL_CHANGE"
      && decideDigest({ incoming: reworded, stored: long, storedAt: hourAgo }).reason === "TOO_SOON",
      `相似度 ${textSimilarity(reworded, long).toFixed(3)}`);
    check("T3", "改动够大且隔了一天才采纳",
      decideDigest({ incoming: rewritten, stored: long, storedAt: dayAgo }).reason === "MATERIAL_CHANGE");
    check("T4", "改动够大但当天已采纳过 —— 压到明天",
      decideDigest({ incoming: rewritten, stored: long, storedAt: hourAgo }).reason === "TOO_SOON");
    check("T5", "未采纳时沿用旧 digest（不丢素材）",
      decideDigest({ incoming: rewritten, stored: long, storedAt: hourAgo }).digest === long);
    check("T6", "本轮没取到 digest 时不清空已有素材",
      decideDigest({ incoming: null, stored: long, storedAt: hourAgo }).digest === long);
    check("T7", "逐字相同直接判未变", decideDigest({ incoming: long, stored: long, storedAt: dayAgo }).reason === "UNCHANGED");
    check("T8", "相似度自身可用", textSimilarity("abc", "abc") === 1 && textSimilarity("abc", "xyz") === 0);
    check("T9", "未采纳的 digest 不进指纹（指纹用的是采纳值）",
      hotTopicHash({ id: "t", title: "T", links: {} }, decideDigest({
        incoming: rewritten, stored: long, storedAt: hourAgo,
      }).digest) === hotTopicHash({ id: "t", title: "T", links: {} }, long));

    // ── Newsroom 模型设置 ──
    const gen = codeOnly(readFileSync("src/lib/content/multilingual/generate.ts", "utf8"));
    check("T10", "生成不再写死 provider", !/args\.provider \?\? "deepseek"/.test(gen) && /resolveNewsroomModel/.test(gen));
    check("T11", "provider 不可用时如实失败，不悄悄换一个",
      /configured && !configured\.available/.test(gen) && /GENERATION_FAILED/.test(gen));
    const route = codeOnly(readFileSync("src/app/api/admin/settings/newsroom-model/route.ts", "utf8"));
    check("T12", "模型设置接口要求管理员", /requireAdmin/.test(route));

    const current = await resolveNewsroomModel();
    check("T13", "能解析出当前生效的模型", Boolean(current.provider),
      `${current.provider}${current.model ? ` · ${current.model}` : "（默认模型）"} · ${current.source}`);
    const bad = await saveNewsroomModel({ provider: "not-a-provider" });
    check("T14", "未知 provider 被拒", !bad.ok);
  }

  {
    const src = codeOnly(readFileSync("src/lib/content/aihot/sync.ts", "utf8"));
    check("S12", "取消精选不删行（已发布内容的追溯链不能断）",
      !/aihotSelectedItem\.delete/.test(src)
      && /deselectItem/.test(src));
    const ingest = codeOnly(readFileSync("src/lib/content/aihot/ingest.ts", "utf8"));
    check("S13", "deselect 只标记 selected=false", /selected: false/.test(ingest) && !/aihotSelectedItem\.delete/.test(ingest));

    const sched = codeOnly(readFileSync("src/lib/content/aihot/scheduler.ts", "utf8"));
    // 精选那条走水位；window 只剩未筛选流在用（它没有增量契约，只能按窗口重取）
    check("S14", "精选定时任务改走水位增量",
      /syncSelected\(fetchOpts\)/.test(sched) && !/ingestSelected/.test(sched));
    check("S15", "自动生成只覆盖时效窗口内的条目", /SELECTED_RECENCY_MS/.test(sched));
    check("S16", "已取消精选的条目不再排队生成", /selected: true/.test(sched));
  }

  // ────────────────────────────────────────────────────────────────────────
  section("二、租约与并发");

  {
    /*
     * 前置条件：不能有**外部进程**持着租约。
     *
     * 生产服务器起着的时候，它自己的 cron 会正常抢到租约 —— 那是租约在干活，
     * 不是缺陷。但本节要验证的正是抢占语义，外部持有者会让后面八条断言
     * 一起变红，看上去像八个 bug。先单独判一次，给出能直接照做的提示。
     */
    const foreign = (await residualLeases()).filter((l) => !l.locked_by?.startsWith(TEST_WORKER));
    check("B0", "无外部进程持有租约（跑测试前请停掉 dev/prod server）",
      foreign.length === 0,
      foreign.map((l) => `${l.task_type}@${l.locked_by}`).join(", ") || "无");
    if (foreign.length) {
      console.log("\n  ⚠ 检测到外部租约持有者，租约与调度相关断言会失真。");
      console.log("    请先停掉本地服务（preview_stop / kill 掉 next start）再重跑。\n");
    }
  }

  {
    const t: AihotTaskType = "HOT_TOPICS";
    const a = await acquireLease(t, `${TEST_WORKER}-A`, 60_000);
    check("B1", "首个 worker 拿到租约", a.ok);
    const b = await acquireLease(t, `${TEST_WORKER}-B`, 60_000);
    check("B2", "同类任务第二个 worker 抢不到", !b.ok);
    check("B3", "冲突时能看到持有者", !b.ok && b.heldBy === `${TEST_WORKER}-A`);

    check("B4", "非持有者续租失败", !(await renewLease(t, `${TEST_WORKER}-B`, 60_000)));
    check("B5", "持有者可续租", await renewLease(t, `${TEST_WORKER}-A`, 60_000));
    check("B6", "非持有者释放不了别人的租约", !(await releaseLease(t, `${TEST_WORKER}-B`)));
    check("B7", "持有者可释放", await releaseLease(t, `${TEST_WORKER}-A`));

    const c = await acquireLease(t, `${TEST_WORKER}-B`, 60_000);
    check("B8", "释放后别人能拿到", c.ok);
    await releaseLease(t, `${TEST_WORKER}-B`);
  }

  {
    // 过期租约必须能被接管 —— 否则 worker 崩溃一次就永久卡死一类任务
    const t: AihotTaskType = "DAILY";
    await acquireLease(t, `${TEST_WORKER}-dead`, -1_000);
    const taken = await acquireLease(t, `${TEST_WORKER}-new`, 60_000);
    check("B9", "过期租约可被接管", taken.ok);
    await releaseLease(t, `${TEST_WORKER}-new`);
  }

  {
    /*
     * worker 被杀掉后留下的 RUNNING 审计行必须被后续运行回收。
     * 不回收的话，事后看审计分不清「还在跑」和「跑到一半没了」——
     * 而那正是这张表唯一的用途。
     */
    const orphan = await prisma.aihotTaskRun.create({
      data: {
        task_type: "DAILY", worker_id: `${TEST_WORKER}-killed`, status: "RUNNING",
        started_at: new Date(Date.now() - 30 * 60_000),
      },
    });
    await runScheduledTask("DAILY", {
      workerId: `${TEST_WORKER}-reaper`,
      transport: scripted([{ status: 304 }]).transport, dryRun: true,
    });
    const after = await prisma.aihotTaskRun.findUnique({ where: { id: orphan.id } });
    check("B12", "崩溃遗留的 RUNNING 行被回收为 FAILED", after?.status === "FAILED", after?.status ?? "?");
    check("B13", "回收原因如实记为 WORKER_LOST", after?.error_code === "WORKER_LOST", after?.error_code ?? "?");
    check("B14", "回收行补上了结束时间", after?.finished_at !== null);
  }

  {
    const t: AihotTaskType = "SELECTED";
    await acquireLease(t, `${TEST_WORKER}-holder`, 60_000);
    const { transport } = scripted([{ status: 200, body: { items: [] } }]);
    const r = await runScheduledTask(t, { workerId: `${TEST_WORKER}-blocked`, transport, dryRun: true });
    check("B10", "租约被占时本轮跳过", r.status === "SKIPPED_LOCKED");
    check("B11", "跳过被记成租约冲突而非失败", r.leaseConflict && r.errorCode === null);
    await releaseLease(t, `${TEST_WORKER}-holder`);
  }

  // ────────────────────────────────────────────────────────────────────────
  section("三、一轮运行：状态、审计、零发布");

  {
    const { transport } = scripted([{ status: 200, headers: { etag: 'W/"x"' }, body: { items: [] } }]);
    const r = await runScheduledTask("HOT_TOPICS", {
      workerId: `${TEST_WORKER}-c1`, transport, dryRun: true,
    });
    check("C1", "dry-run 正常结束", r.status === "OK", r.message ?? "");
    check("C2", "写出运行审计", r.runId !== null);
    check("C3", "本轮零 provider 调用", r.providerCalls === 0);
    check("C4", "本轮零发布", r.publicationsCreated === 0);
    check("C5", "跑完不留租约", (await residualLeases()).filter((l) => l.locked_by?.startsWith(TEST_WORKER)).length === 0);
  }

  {
    const { transport } = scripted([{ status: 304 }]);
    const r = await runScheduledTask("HOT_TOPICS", {
      workerId: `${TEST_WORKER}-c2`, transport, dryRun: true,
    });
    check("C6", "304 记为 NOT_MODIFIED", r.status === "NOT_MODIFIED");
    check("C7", "304 零入库写入", r.created === 0 && r.updated === 0);
  }

  {
    const { transport } = scripted([{ status: 500 }]);
    const rec = recorder();
    const r = await runScheduledTask("DAILY", {
      workerId: `${TEST_WORKER}-c3`, transport, wait: rec.wait, dryRun: true,
    });
    check("C8", "抓取失败记为 FAILED 且不抛异常", r.status === "FAILED" && r.errorCode === "INGEST_FAILED");
    check("C9", "5xx 计数进审计", r.serverError > 0, `${r.serverError}`);
  }

  {
    /*
     * 生成阶段抛异常也不能把整轮变成未捕获异常。
     *
     * 这条必须**保证有候选单元**才测得到 —— 库里的日报若都已成稿，
     * 生成循环一次都不会进，注入的异常永远不会被触发，
     * 这条断言就会变成一条只会绿的假测试。所以先造一条临时日报。
     */
    const probeDate = "2999-01-01";
    await prisma.aihotDailyReport.create({
      data: {
        provider: "AIHOT", report_date: probeDate, title: "测试探针",
        sections_json: [], aihot_url: "https://aihot.virxact.com/dailies/2999-01-01",
        attribution_name: "AI HOT", attribution_url: "https://aihot.virxact.com/dailies/2999-01-01",
        source_snapshot_hash: `probe-${Date.now()}`,
      },
    });
    try {
      const r = await runScheduledTask("DAILY", {
        workerId: `${TEST_WORKER}-c4`,
        transport: scripted([{ status: 304 }]).transport,
        generate: async () => { throw new Error("provider 崩了"); },
        freeze: fakeFreeze,
        maxUnits: 1,
      });
      check("C10", "生成异常被兜住", r.status === "FAILED" && r.errorCode === "UNEXPECTED",
        `${r.status}/${r.errorCode} 候选 ${r.unitsConsidered}`);
      check("C11", "异常不回显完整堆栈", (r.message ?? "").length <= 300);
      check("C12", "异常轮次同样零发布", r.publicationsCreated === 0);
    } finally {
      await prisma.aihotDailyReport.deleteMany({ where: { report_date: probeDate } });
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  section("四、任务隔离：一类失败不影响另外两类");

  {
    /*
     * 三类各自独立取端点：让热点端点 500、另外两类 304。
     * 传输层按 URL 分派，才能表达「只有一类挂了」这件事。
     */
    const transport: AihotTransport = async ({ url }) => {
      if (url.includes("/hot-topics")) return { status: 500, headers: {}, text: "" };
      return { status: 304, headers: {}, text: "" };
    };
    const rec = recorder();
    const rs = await runAllScheduledTasks({
      workerId: `${TEST_WORKER}-d`, transport, wait: rec.wait, dryRun: true,
    });
    const byType = new Map(rs.map((r) => [r.taskType, r]));
    check("D1", "每一类都跑到了", rs.length === ALL_TASKS.length, `${rs.length}/${ALL_TASKS.length}`);
    check("D2", "热点失败", byType.get("HOT_TOPICS")!.status === "FAILED");
    check("D3", "精选不受影响", byType.get("SELECTED")!.status === "NOT_MODIFIED");
    check("D4", "日报不受影响", byType.get("DAILY")!.status === "NOT_MODIFIED");
    check("D5", "每类各留一条审计", rs.every((r) => r.runId !== null));
  }

  {
    check("D6", "各类调度周期互不相同",
      new Set(ALL_TASKS.map((t) => TASK_SCHEDULE[t].cron)).size === ALL_TASKS.length,
      ALL_TASKS.map((t) => `${t}=${TASK_SCHEDULE[t].cron}`).join(" "));
    check("D7", "热点 5 分钟", TASK_SCHEDULE.HOT_TOPICS.cron === "*/5 * * * *");
    check("D8", "精选 10 分钟", TASK_SCHEDULE.SELECTED.cron === "*/10 * * * *");
    check("D9", "日报 30 分钟", TASK_SCHEDULE.DAILY.cron === "*/30 * * * *");
  }

  // ────────────────────────────────────────────────────────────────────────
  section("五、幂等：相同输入不重复调用 provider");

  {
    const g = fakeGenerate("EXISTING");
    const r = await runScheduledTask("HOT_TOPICS", {
      workerId: `${TEST_WORKER}-e1`,
      transport: scripted([{ status: 200, body: { items: [] } }]).transport,
      generate: g.fn, freeze: fakeFreeze, maxUnits: 3,
    });
    check("E1", "幂等复用时 provider 调用为 0", r.providerCalls === 0);
    check("E2", "复用被单独计数", r.unitsReused === r.unitsConsidered, `${r.unitsReused}/${r.unitsConsidered}`);
    check("E3", "复用不算新生成", r.unitsGenerated === 0);
  }

  {
    /*
     * 失败冷却：稳定过不了 QA 的单元不能每一轮都重烧 provider。
     *
     * 造一条临时日报并给它写一份 QA_FAILED 草稿，
     * 默认冷却下它不该入选；--retry-failed（冷却 0）时必须重新入选。
     */
    const probeDate = "2998-01-01";
    const unitKey = `daily:${probeDate}`;
    const hash = `cooldown-${Date.now()}`;
    const report = await prisma.aihotDailyReport.create({
      data: {
        provider: "AIHOT", report_date: probeDate, title: "冷却探针",
        sections_json: [], aihot_url: "https://aihot.virxact.com/dailies/2998-01-01",
        attribution_name: "AI HOT", attribution_url: "https://aihot.virxact.com/dailies/2998-01-01",
        source_snapshot_hash: hash,
      },
    });
    const draft = await prisma.multilingualDraft.create({
      data: {
        content_form: "DAILY_BRIEF", content_kind: "DAILY", unit_key: unitKey,
        daily_report_id: report.id, language: "EN_US", is_master: true,
        generation_version: "cooldown-test-version", status: "QA_FAILED",
        source_snapshot_hash: hash, source_input_hash: hash,
        provider_attribution_name: "AI HOT",
        provider_attribution_url: "https://aihot.virxact.com/dailies/2998-01-01",
      },
    });
    try {
      const g1 = fakeGenerate("OK");
      const cooled = await runScheduledTask("DAILY", {
        workerId: `${TEST_WORKER}-e0a`,
        transport: scripted([{ status: 304 }]).transport,
        generate: g1.fn, freeze: fakeFreeze,
        generationVersion: "cooldown-test-version", maxUnits: 5,
      });
      check("E0a", "刚失败过的单元在冷却期内不重跑",
        !g1.seen.includes(`DAILY:${report.id}`), g1.seen.join(","));
      check("E0b", "冷却不影响本轮正常结束", cooled.status === "NOT_MODIFIED");

      const g2 = fakeGenerate("OK");
      await runScheduledTask("DAILY", {
        workerId: `${TEST_WORKER}-e0b`,
        transport: scripted([{ status: 304 }]).transport,
        generate: g2.fn, freeze: fakeFreeze,
        generationVersion: "cooldown-test-version", maxUnits: 5, failureCooldownMs: 0,
      });
      check("E0c", "冷却设为 0 时立刻重试",
        g2.seen.includes(`DAILY:${report.id}`), g2.seen.join(","));
    } finally {
      await prisma.multilingualDraft.delete({ where: { id: draft.id } }).catch(() => undefined);
      await prisma.aihotDailyReport.delete({ where: { id: report.id } }).catch(() => undefined);
    }
  }

  {
    // 名次不进内容指纹：只有名次变了，指纹必须逐字相同
    const base: AihotHotTopicDto = {
      id: "topic-x", title: "示例热点", sourceCount: 3, signalCount: 5,
      sourceNames: ["A", "B"], links: { aihot: "https://aihot.virxact.com/items/abcdefgh" },
      latestAt: "2026-08-01T00:00:00.000Z",
    };
    check("E4", "名次不影响内容指纹", hotTopicHash(base) === hotTopicHash({ ...base }));
    check("E5", "来源数变化会改变指纹", hotTopicHash(base) !== hotTopicHash({ ...base, sourceCount: 4 }));
    check("E6", "标题变化会改变指纹", hotTopicHash(base) !== hotTopicHash({ ...base, title: "改了" }));
    check("E7", "来源名单变化会改变指纹", hotTopicHash(base) !== hotTopicHash({ ...base, sourceNames: ["A", "C"] }));
  }

  {
    const m: HotTopicMaterial = {
      snapshotId: 1, topicId: "t", title: "标题", rank: 1, sourceCount: 3, signalCount: 5,
      sourceNames: ["A"], capturedAt: new Date(), latestAt: null,
      aihotUrl: "https://aihot.virxact.com/items/abcdefgh", originalUrl: null,
      representativeSourceName: null, apiSummary: null, storyDigest: null, storyReports: [], relatedItems: [],
      mode: "SIGNAL", attributionUrlValid: true, snapshotHash: "h",
    };
    check("E8", "事实指纹排除名次",
      hotTopicFactFingerprint(m) === hotTopicFactFingerprint({ ...m, rank: 9 }));
    check("E9", "事实指纹包含来源数",
      hotTopicFactFingerprint(m) !== hotTopicFactFingerprint({ ...m, sourceCount: 4 }));
    check("E10", "事实指纹包含关联精选",
      hotTopicFactFingerprint(m) !== hotTopicFactFingerprint({
        ...m, relatedItems: [{ title: "x", summary: null, sourceName: null, aihotUrl: null }],
      }));
  }

  // ────────────────────────────────────────────────────────────────────────
  section("六、热点模式：素材少照样生成");

  {
    const src = readFileSync("src/lib/content/publishing/eligibility.ts", "utf8");
    check("F1", "不存在信息不足门禁", !/HOT_TOPIC_INSUFFICIENT_FOR_PUBLICATION/.test(src));
    // 素材有三种来源：API 摘要、story digest、可精确关联的已入库精选
    check("F2", "模式由素材决定",
      /apiSummary \|\| storyDigest \|\| related\.length \? "ENRICHED" : "SIGNAL"/.test(src));
    const pre = readFileSync("src/lib/content/publishing/publish.ts", "utf8");
    check("F3", "preflight 不含素材充分性门禁", !/INSUFFICIENT/.test(pre));
  }

  {
    const sched = codeOnly(readFileSync("src/lib/content/aihot/scheduler.ts", "utf8"));
    check("F4", "调度器不含发布调用", !/publishFamily|publishTranslation/.test(sched));
    check("F5", "调度器不碰 event clustering", !/eventClustering|clusterCandidate|EventSimilarity/i.test(sched));
    check("F6", "调度器不创建 AIEvent", !/aiEvent/i.test(sched));
    check("F7", "调度器每轮核对发布记录数",
      /publicationsBefore/.test(sched) && /AUTO_PUBLICATION_DETECTED/.test(sched));
  }

  // ────────────────────────────────────────────────────────────────────────
  section("七、审核身份：AGENT 不得伪装为 HUMAN");

  {
    check("G1", "缺少标识被拒", reviewerIdentityIssue({ type: "HUMAN", id: "" }) !== null);
    check("G2", "agent 标识声明 HUMAN 被拒",
      reviewerIdentityIssue({ type: "HUMAN", id: "claude-code-agent" }) !== null);
    check("G3", "名字里带 bot 声明 HUMAN 被拒",
      reviewerIdentityIssue({ type: "HUMAN", id: "u1", name: "review bot" }) !== null);
    check("G4", "SYSTEM 不能用于审核", reviewerIdentityIssue({ type: "SYSTEM", id: "migration" }) !== null);
    check("G5", "正常人工身份放行", reviewerIdentityIssue({ type: "HUMAN", id: "alice", name: "Alice" }) === null);
    check("G6", "AGENT 如实声明放行", reviewerIdentityIssue({ type: "AGENT", id: "claude-code-agent" }) === null);
  }

  {
    const existing = await prisma.translationReview.findMany({
      select: { reviewer_type: true, reviewer_id: true, decision: true, approved_revision_id: true, revision_id: true },
    });
    check("G7", "历史审核记录全部带身份类型",
      existing.every((r) => r.reviewer_type !== null && Boolean(r.reviewer_id)));
    check("G8", "历史 agent 审核未被回填成 HUMAN",
      !existing.some((r) => r.reviewer_type === "HUMAN" && /agent|claude|bot/i.test(r.reviewer_id)));
    check("G9", "已批准的记录留住了批准版本",
      existing.filter((r) => r.decision === "APPROVED").every((r) => r.approved_revision_id === r.revision_id));
  }

  {
    const route = readFileSync("src/app/api/admin/content/aihot/family/[id]/review/route.ts", "utf8");
    check("G10", "审核路由由服务端定身份类型", /type: "HUMAN"/.test(route) && !/body\.reviewerType/.test(route));
    check("G11", "审核路由要求管理员", /requireAdmin/.test(route));
  }

  // ────────────────────────────────────────────────────────────────────────
  section("八、编辑队列：栏目、对照、授权");

  {
    check("H1", "八个内容栏目齐全",
      ["NEEDS_REVIEW", "QA_FAILED", "APPROVED", "PUBLISHED", "REJECTED", "SELECTED", "HOT_TOPICS", "DAILY"]
        .every((t) => (QUEUE_TABS as readonly string[]).includes(t)));

    const baseRow = {
      familyId: 1, unitKey: "u", slug: "s", reportDate: null,
      contentKind: "SELECTED", contentForm: "MULTILINGUAL_NEWS_BRIEF",
      hotTopicMode: null, familyStatus: "DRAFTED", categorySlug: null, masterHeadline: "h",
      attributionName: "AI HOT", attributionUrl: "https://aihot.virxact.com/items/aaaaaaaa",
      originalSourceName: null, originalSourceUrl: null, sourceSnapshotHash: "hh",
      sourcePublishedAt: null, capturedAt: null, publishedCount: 0, qaIssueCount: 0,
      updatedAt: new Date(),
    } as unknown as QueueRow;
    const loc = (over: Record<string, unknown>) => LOCALES.map((l) => ({
      locale: l, translationId: 1, status: "DRAFTED", currentRevisionId: 1, currentRevisionNumber: 1,
      approvedRevisionId: null, approvedIsCurrent: false, publishedRevisionId: null, publishedPath: null,
      qaVerdict: "PASSED", qaIssues: [], lastReviewerType: null, lastReviewerId: null, lastReviewerName: null,
      lastDecision: null, lastReviewedAt: null, lastNotes: null, reviewCount: 0, ...over,
    })) as QueueRow["locales"];

    check("H2", "默认落在待审核", tabOf({ ...baseRow, locales: loc({}) }) === "NEEDS_REVIEW");
    check("H3", "QA 未过优先于其它状态",
      tabOf({ ...baseRow, locales: loc({ qaVerdict: "FAILED", approvedIsCurrent: true }) }) === "QA_FAILED");
    check("H4", "被拒最优先",
      tabOf({ ...baseRow, locales: loc({ status: "REJECTED" }) }) === "REJECTED");
    check("H5", "四语言都批准当前版本才算已批准",
      tabOf({ ...baseRow, locales: loc({ approvedIsCurrent: true }) }) === "APPROVED");
    check("H6", "四语言都发布才算已发布",
      tabOf({ ...baseRow, publishedCount: 4, locales: loc({ approvedIsCurrent: true, publishedPath: "/en/x" }) }) === "PUBLISHED");
  }

  {
    const mk = (locale: string, headline: string, body: string) => ({
      locale, headline, summary: "", body, sections: [], targetPath: "/x",
      translationId: 1, status: "DRAFTED", currentRevisionId: 1, currentRevisionNumber: 1,
      approvedRevisionId: null, approvedIsCurrent: false, publishedRevisionId: null, publishedPath: null,
      qaVerdict: "PASSED", qaIssues: [], lastReviewerType: null, lastReviewerId: null, lastReviewerName: null,
      lastDecision: null, lastReviewedAt: null, lastNotes: null, reviewCount: 0,
    }) as unknown as LocaleContent;

    const cmp = buildComparison([
      mk("EN_US", "GPT-5.6 ships", "OpenAI released GPT-5.6 on 2026-08-01 with 4000 million tracks."),
      mk("ES_ES", "GPT-5.6 llega", "OpenAI lanzó GPT-5.6 el 2026-08-01 con 4000 millones de pistas."),
      // 巴葡故意整篇都不提型号 —— 标题里带上它，这条对照就永远是绿的，测不出任何东西
      mk("PT_BR", "Novo modelo chega", "A OpenAI lançou o modelo em 2026-08-01."),
      mk("JA_JP", "GPT-5.6 登場", "OpenAI は 2026-08-01 に GPT-5.6 を公開した。"),
    ]);
    const model = cmp.find((c) => c.dimension === "MODEL" && /gpt-5\.6/i.test(c.master));
    check("H7", "对照能识别模型 token", Boolean(model));
    check("H8", "缺失的模型 token 被标出", Boolean(model) && model!.present.PT_BR === false);
    check("H9", "共同出现的日期被认可",
      Boolean(cmp.find((c) => c.dimension === "DATE" && Object.values(c.present).every(Boolean))));
    check("H10", "四个维度都会产出",
      new Set(cmp.map((c) => c.dimension)).size >= 3, [...new Set(cmp.map((c) => c.dimension))].join(","));
  }

  {
    for (const p of [
      "src/app/api/admin/content/aihot/queue/route.ts",
      "src/app/api/admin/content/aihot/family/[id]/route.ts",
      "src/app/api/admin/content/aihot/family/[id]/review/route.ts",
      "src/app/api/admin/content/aihot/family/[id]/publish/route.ts",
      "src/app/api/admin/content/aihot/family/[id]/regenerate/route.ts",
    ]) {
      const src = readFileSync(p, "utf8");
      check(`H11:${p.split("/").slice(-2).join("/")}`, "路由要求管理员身份", /requireAdmin/.test(src));
    }
  }

  {
    const queue = readFileSync("src/lib/content/publishing/queue.ts", "utf8");
    check("H12", "队列层不提供修改 AI HOT 输入的入口",
      !/aihotSelectedItem\.update|aihotHotTopicSnapshot\.update|aihotDailyReport\.update/.test(queue));
    const client = readFileSync("src/components/admin/aihot-queue-client.tsx", "utf8");
    check("H13", "队列 UI 标注来源为只读", /只读，不可编辑/.test(client));
  }

  // ────────────────────────────────────────────────────────────────────────
  section("九、不自动发布 / 草稿隐私");

  {
    const publicationsNow = await prisma.articlePublication.count();
    check("I1", "整套测试期间发布记录未变",
      publicationsNow === publicationsAtStart, `${publicationsAtStart} → ${publicationsNow}`);

    const cron = readFileSync("src/lib/tasks/aihot-cron.ts", "utf8");
    check("I2", "cron 回调只调调度器", /runScheduledTask/.test(cron) && !/publish/i.test(cron));

    const trending = readFileSync("src/lib/content/publishing/trending.ts", "utf8");
    check("I3", "榜单只读已发布记录", /status: "PUBLISHED"/.test(trending));
    check("I4", "榜单按发布时间倒序取最近已发布版本", /orderBy: \{ published_at: "desc" \}/.test(trending));
    check("I5", "榜单卡片不含 topicId / 来源名单",
      !/topicId:/.test(trending.split("export type TrendingCard")[1]?.split("};")[0] ?? "")
      && !/sourceNames:/.test(trending.split("export type TrendingCard")[1]?.split("};")[0] ?? ""));

    const adminPage = readFileSync("src/app/(admin)/admin/content/aihot/page.tsx", "utf8");
    check("I6", "审核台 noindex", /robots: \{ index: false, follow: false \}/.test(adminPage));

    const sitemap = codeOnly(readFileSync("src/app/sitemap.ts", "utf8"));
    check("I7", "sitemap 只收已发布页面", /listPublishedPaths/.test(sitemap));
    check("I8", "sitemap 含三个常驻列表页 × 四语言",
      ["/trending", "/updates", "/briefings/daily"].every((p) => sitemap.includes(p))
      && /LOCALES\.(?:map|flatMap)/.test(sitemap));
  }

  {
    check("I9", "精选路径", publicPath({ locale: "EN_US", contentForm: "MULTILINGUAL_NEWS_BRIEF", slug: "x" }) === "/en/updates/x");
    check("I10", "热点简报路径", publicPath({ locale: "JA_JP", contentForm: "HOT_TOPIC_BRIEF", slug: "x" }) === "/ja/updates/trending/x");
    check("I11", "日报路径", publicPath({ locale: "PT_BR", contentForm: "DAILY_BRIEF", slug: "x", reportDate: "2026-08-01" }) === "/pt-br/briefings/daily/2026-08-01");
  }

  // ────────────────────────────────────────────────────────────────────────
  section("十、动态基线");

  {
    const a = { clusteringRuns: 1, clusteringEdges: 0, clusterCandidates: 9, clusterMembers: 9 } as unknown as ProtectedState;
    check("J1", "相同状态无差异", diffProtectedState(a, { ...a }).length === 0);
    const d = diffProtectedState(a, { ...a, clusterCandidates: 10 } as ProtectedState);
    check("J2", "差异被逐项列出", d.length === 1 && d[0].key === "clusterCandidates");

    const canary = codeOnly(readFileSync("scripts/hot-topic-canary.ts", "utf8"));
    check("J3", "hot:canary 不再写死 clustering 数量",
      !/candidates === 9|members === 9|runs === 1|edges === 0/.test(canary));
    check("J4", "hot:canary 改为与基线比对", /loadProtectedBaseline/.test(canary));

    const ops = codeOnly(readFileSync("scripts/aihot-ops-canary.ts", "utf8"));
    check("J5", "ops canary 同样使用动态基线", /diffProtectedState/.test(ops));
    check("J6", "ops canary 不修改 event discovery 数据",
      !/eventClusteringRun\.(create|update|delete)/.test(ops));
  }

  // ────────────────────────────────────────────────────────────────────────
  section("十一、收尾：没有留下任何越权写入");

  await cleanupRuns();

  {
    const publicationsNow = await prisma.articlePublication.count();
    const draftsNow = await prisma.multilingualDraft.count();
    const familiesNow = await prisma.articleFamily.count();
    check("K1", "发布记录数未变", publicationsNow === publicationsAtStart, `${publicationsAtStart} → ${publicationsNow}`);
    check("K2", "草稿数未变", draftsNow === draftsAtStart, `${draftsAtStart} → ${draftsNow}`);
    check("K3", "家族数未变", familiesNow === familiesAtStart, `${familiesAtStart} → ${familiesNow}`);
    const leftover = (await residualLeases()).filter((l) => l.locked_by?.startsWith(TEST_WORKER));
    check("K4", "测试租约全部释放", leftover.length === 0, leftover.map((l) => l.task_type).join(","));
    const leftRuns = await prisma.aihotTaskRun.count({ where: { worker_id: { startsWith: TEST_WORKER } } });
    check("K5", "测试审计已清理", leftRuns === 0, `${leftRuns}`);
  }

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) { console.log("\n未通过："); for (const f of failures) console.log(`  - ${f}`); }
  await prisma.$disconnect();
  if (fail) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await cleanupRuns().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(1);
});
