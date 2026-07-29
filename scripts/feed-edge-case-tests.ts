/**
 * C3 Canary 前置：真实订阅里的 13 类边界。
 *
 *   npm run test:feededge
 *
 * 全部用内存 fixture 复现，**不访问任何真实来源、不调 AI、不写 ResourceContent**。
 * 目的是在接真实源之前，先证明这些情况我们扛得住。
 */
import http from "http";

import { prisma } from "@/lib/prisma";
import { parseFeed } from "@/lib/content/feed-parser";
import { ingestSource, FEED_MAX_BYTES } from "@/lib/content/ingest";
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

const HOST = "edge.example";
const ORIGIN = `https://${HOST}`;
const PUBLIC_IP = "93.184.216.34";

// ── fixture 订阅 ───────────────────────────────────────────────────────

/** E2 GUID 缺失 · E3 相对 URL · E4 content:encoded · E5 实体 · E8 时间缺失/非法 */
const MESSY_RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Messy Feed</title>
  <link>https://edge.example/</link>
  <item>
    <title>No guid here</title>
    <link>/posts/relative-one</link>
    <pubDate>Tue, 28 Jul 2026 10:00:00 GMT</pubDate>
    <content:encoded><![CDATA[<p>Body with &amp; entity and <b>tags</b>.</p>]]></content:encoded>
  </item>
  <item>
    <title>Bad date &amp; entities &#8212; here</title>
    <link>https://edge.example/posts/bad-date</link>
    <guid>https://edge.example/posts/bad-date</guid>
    <pubDate>not a real date</pubDate>
    <description>Plain &lt;b&gt;escaped&lt;/b&gt; markup</description>
  </item>
  <item>
    <title>Epoch date</title>
    <link>https://edge.example/posts/epoch</link>
    <pubDate>Thu, 01 Jan 1970 00:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Missing link entirely</title>
    <guid isPermaLink="false">urn:uuid:no-link-at-all</guid>
  </item>
</channel>
</rss>`;

/** E13 单条畸形但其余正常 */
const PARTIALLY_BROKEN = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Partly Broken</title>
  <item><title>Good one</title><link>https://edge.example/posts/good-1</link></item>
  <item><title>Weird</title><link>javascript:void(0)</link></item>
  <item><title>Good two</title><link>https://edge.example/posts/good-2</link></item>
</channel></rss>`;

/** E7 条目带 atom:updated */
const UPDATED_RSS = (updated: string, title: string) => `<?xml version="1.0"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Rev Feed</title>
  <item>
    <title>${title}</title>
    <link>https://edge.example/posts/revised</link>
    <pubDate>Mon, 27 Jul 2026 08:00:00 GMT</pubDate>
    <atom:updated>${updated}</atom:updated>
  </item>
</channel></rss>`;

/** E9 只保留最近若干条（第二次抓时老条目消失） */
const WINDOW_A = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Windowed</title>
  <item><title>Old post</title><link>https://edge.example/posts/w-old</link></item>
  <item><title>New post</title><link>https://edge.example/posts/w-new</link></item>
</channel></rss>`;
const WINDOW_B = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Windowed</title>
  <item><title>Newest post</title><link>https://edge.example/posts/w-newest</link></item>
  <item><title>New post</title><link>https://edge.example/posts/w-new</link></item>
</channel></rss>`;

/** E12 超过字节上限 */
const HUGE_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Huge</title>` +
  Array.from({ length: 6000 }, (_, i) =>
    `<item><title>Item ${i}</title><link>https://edge.example/posts/huge-${i}</link>` +
    `<description>${"x".repeat(200)}</description></item>`
  ).join("") +
  `</channel></rss>`;

type MockState = {
  /** E10 条件请求：命中则回 304 */
  etag: string | null;
  /** E9 窗口滚动 */
  windowPhase: "a" | "b";
  /** E7 条目修订 */
  revision: { updated: string; title: string };
  requests: { path: string; ifNoneMatch?: string; ifModifiedSince?: string }[];
};

function mockTransport(state: MockState): { transport: Transport; resolve: ResolveFn } {
  const transport: Transport = async (args: TransportArgs) => {
    const path = args.url.pathname;
    state.requests.push({
      path,
      ifNoneMatch: args.conditional?.etag,
      ifModifiedSince: args.conditional?.lastModified,
    });
    const send = (
      status: number,
      body: string,
      headers: Record<string, string> = {},
      maxBytes = args.maxBytes ?? 65_536
    ) => {
      const buf = Buffer.from(args.wantBody ? body : "", "utf8");
      const cut = buf.subarray(0, maxBytes);
      return {
        status,
        headers: { "content-type": "application/xml", ...headers } as http.IncomingHttpHeaders,
        buffer: cut,
        truncated: buf.length > maxBytes,
      };
    };

    if (path === "/robots.txt") return send(200, "User-agent: *\nDisallow:\n", { "content-type": "text/plain" });
    if (path === "/messy") return send(200, MESSY_RSS);
    if (path === "/partial") return send(200, PARTIALLY_BROKEN);
    if (path === "/huge") return send(200, HUGE_RSS);
    if (path === "/revised") return send(200, UPDATED_RSS(state.revision.updated, state.revision.title));
    if (path === "/windowed") return send(200, state.windowPhase === "a" ? WINDOW_A : WINDOW_B);

    // E10 ETag / Last-Modified
    if (path === "/conditional") {
      if (args.conditional?.etag === '"v1"') {
        return send(304, "", { etag: '"v1"', "last-modified": "Tue, 28 Jul 2026 10:00:00 GMT" });
      }
      return send(200, WINDOW_A, { etag: '"v1"', "last-modified": "Tue, 28 Jul 2026 10:00:00 GMT" });
    }

    // E11 Feed 地址 301 迁移
    if (path === "/moved") {
      return {
        status: 301,
        headers: { location: `${ORIGIN}/moved-target` } as http.IncomingHttpHeaders,
        buffer: Buffer.alloc(0),
        truncated: false,
      };
    }
    if (path === "/moved-target") return send(200, WINDOW_A);

    return send(404, "no fixture", { "content-type": "text/html" });
  };
  return { transport, resolve: async () => [PUBLIC_IP] };
}

// ── 测试 ──────────────────────────────────────────────────────────────

/** 清掉本套测试自己造的源（按 publisher 标记识别），不碰任何真实源 */
async function purgeTestSources(): Promise<void> {
  const orphans = await prisma.contentSource.findMany({
    where: { publisher: "__edge_test__" },
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
  const state: MockState = {
    etag: null,
    windowPhase: "a",
    revision: { updated: "2026-07-27T09:00:00Z", title: "Original title" },
    requests: [],
  };
  const mock = mockTransport(state);
  const opts = { transport: mock.transport, resolve: mock.resolve };
  const created: number[] = [];

  // 前置清理：上一轮若在数据库中断时崩溃，会留下同名同 feed_url 的测试源，
  // 下一轮建源就会撞唯一约束。只按 publisher 标记清，碰不到真实源。
  await purgeTestSources();

  const mkSource = async (path: string, name: string) => {
    const s = await prisma.contentSource.create({
      data: {
        name, kind: "rss", publisher: "__edge_test__",
        feed_url: `${ORIGIN}${path}`, fetch_interval_minutes: 60,
      },
      select: { id: true },
    });
    created.push(s.id);
    return s.id;
  };

  try {
    // ── E1 RSS / Atom 混用 ───────────────────────────────────────────
    console.log("\nE1  RSS / Atom 混用\n");
    check("E1.1", "RSS 与 Atom 由同一入口分派",
      parseFeed(MESSY_RSS).kind === "rss" &&
      parseFeed('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>a</title></feed>').kind === "atom");

    // ── E2/E3/E4/E5/E8 ──────────────────────────────────────────────
    console.log("\nE2·E3·E4·E5·E8  GUID 缺失 / 相对 URL / content:encoded / 实体 / 非法时间\n");
    const messyId = await mkSource("/messy", "__edge_messy__");
    const r1 = await ingestSource(messyId, opts);
    const messyItems = await prisma.sourceItem.findMany({
      where: { source_id: messyId }, orderBy: { id: "asc" },
    });
    check("E2.1", "GUID 缺失时仍能靠 link 落库",
      messyItems.some((i) => i.url.endsWith("/posts/relative-one")), String(messyItems.length));
    check("E2.2", "link 缺失时回落到 guid（非 URL 的 guid 记为跳过）",
      r1.itemsSkipped >= 1, `skipped=${r1.itemsSkipped}`);
    check("E3.1", "相对 URL 以订阅地址为 base 解析成绝对地址",
      messyItems.some((i) => i.url === "https://edge.example/posts/relative-one"),
      messyItems.map((i) => i.url).join(" | ").slice(0, 90));
    const withBody = messyItems.find((i) => i.url.endsWith("/posts/relative-one"));
    check("E4.1", "content:encoded 作为正文且已去标签",
      (withBody?.raw_content ?? "").includes("Body with & entity and tags") &&
      !(withBody?.raw_content ?? "").includes("<b>"),
      String(withBody?.raw_content));
    check("E5.1", "标题中的实体已解码",
      messyItems.some((i) => i.title.includes("&") && i.title.includes("—")),
      messyItems.map((i) => i.title).join(" | ").slice(0, 80));
    const badDate = messyItems.find((i) => i.url.endsWith("/posts/bad-date"));
    check("E8.1", "非法时间落 null 而不是编造", badDate?.published_at === null, String(badDate?.published_at));
    const epoch = messyItems.find((i) => i.url.endsWith("/posts/epoch"));
    check("E8.2", "1970 这类荒谬时间也判无效", epoch?.published_at === null, String(epoch?.published_at));

    // ── E13 单条畸形不影响其余 ────────────────────────────────────────
    console.log("\nE13  单条格式异常但其他条目正常\n");
    const partialId = await mkSource("/partial", "__edge_partial__");
    const r2 = await ingestSource(partialId, opts);
    const partialItems = await prisma.sourceItem.findMany({ where: { source_id: partialId } });
    check("E13.1", "整源仍判成功", r2.ok && r2.status === "ok", `${r2.status} ${r2.error ?? ""}`);
    check("E13.2", "两条正常条目都落库", partialItems.length === 2, String(partialItems.length));
    check("E13.3", "畸形条目被跳过而非拖垮整源",
      r2.itemsSkipped === 1 && r2.itemsErrored === 0,
      `skipped=${r2.itemsSkipped} errored=${r2.itemsErrored}`);

    // ── E6 重复 URL 但标题变化 ───────────────────────────────────────
    console.log("\nE6·E7  重复 URL 标题变化 / 条目修订时间\n");
    const revId = await mkSource("/revised", "__edge_revised__");
    const rev1 = await ingestSource(revId, opts);
    const revItem1 = await prisma.sourceItem.findFirstOrThrow({ where: { source_id: revId } });
    check("E7.1", "atom:updated 落到 source_updated_at",
      revItem1.source_updated_at?.toISOString() === "2026-07-27T09:00:00.000Z",
      String(revItem1.source_updated_at?.toISOString()));
    check("E7.2", "首轮新增 1 条", rev1.itemsCreated === 1, String(rev1.itemsCreated));

    state.revision = { updated: "2026-07-29T11:00:00Z", title: "Revised title" };
    const rev2 = await ingestSource(revId, opts);
    check("E6.1", "同一 URL 标题变化被识别并计数",
      rev2.itemsTitleChanged === 1, String(rev2.itemsTitleChanged));
    check("E6.2", "仍算重复，不新增条目",
      rev2.itemsCreated === 0 && rev2.itemsDuplicate === 1,
      `created=${rev2.itemsCreated} duplicate=${rev2.itemsDuplicate}`);
    const revItem2 = await prisma.sourceItem.findFirstOrThrow({ where: { source_id: revId } });
    check("E6.3", "原始快照不可变：标题未被改写",
      revItem2.title === "Original title", revItem2.title);
    check("E6.4", "库中仍只有 1 条",
      (await prisma.sourceItem.count({ where: { source_id: revId } })) === 1);

    // ── E9 只保留最近若干条 ──────────────────────────────────────────
    console.log("\nE9  Feed 只保留最近若干条（窗口滚动）\n");
    const winId = await mkSource("/windowed", "__edge_window__");
    await ingestSource(winId, opts);
    state.windowPhase = "b"; // 老条目滑出窗口，新条目进来
    const w2 = await ingestSource(winId, opts);
    const winItems = await prisma.sourceItem.findMany({ where: { source_id: winId } });
    check("E9.1", "滑出窗口的老条目仍保留在库中",
      winItems.some((i) => i.url.endsWith("/posts/w-old")), winItems.map((i) => i.url).join(" | "));
    check("E9.2", "新出现的条目被落库",
      winItems.some((i) => i.url.endsWith("/posts/w-newest")));
    check("E9.3", "累计 3 条（2 + 1 新增）", winItems.length === 3, String(winItems.length));
    check("E9.4", "第二轮只新增 1 条", w2.itemsCreated === 1, String(w2.itemsCreated));

    // ── E10 ETag / Last-Modified ────────────────────────────────────
    console.log("\nE10  ETag / Last-Modified 条件请求\n");
    const condId = await mkSource("/conditional", "__edge_conditional__");
    const c1 = await ingestSource(condId, opts);
    const condSrc1 = await prisma.contentSource.findUniqueOrThrow({ where: { id: condId } });
    check("E10.1", "首轮 200 并记下 ETag", c1.ok && condSrc1.etag === '"v1"', String(condSrc1.etag));
    check("E10.2", "同时记下 Last-Modified",
      condSrc1.last_modified === "Tue, 28 Jul 2026 10:00:00 GMT", String(condSrc1.last_modified));

    const c2 = await ingestSource(condId, opts);
    const lastReq = state.requests.filter((r) => r.path === "/conditional").pop();
    check("E10.3", "第二轮带上 If-None-Match", lastReq?.ifNoneMatch === '"v1"', String(lastReq?.ifNoneMatch));
    check("E10.4", "命中 304 判成功而非失败",
      c2.ok && c2.status === "not_modified", `${c2.status} ok=${c2.ok}`);
    check("E10.5", "304 不新增条目也不重置计数",
      c2.itemsCreated === 0 && c2.itemsSeen === 0, `created=${c2.itemsCreated}`);
    const condSrc2 = await prisma.contentSource.findUniqueOrThrow({ where: { id: condId } });
    check("E10.6", "304 后连续失败计数仍为 0", condSrc2.consecutive_failures === 0,
      String(condSrc2.consecutive_failures));

    // ── E11 Feed 地址 301 迁移 ──────────────────────────────────────
    console.log("\nE11  Feed 地址 301/302 迁移\n");
    const movedId = await mkSource("/moved", "__edge_moved__");
    const m1 = await ingestSource(movedId, opts);
    const movedSrc = await prisma.contentSource.findUniqueOrThrow({ where: { id: movedId } });
    check("E11.1", "跟随 301 后仍能成功解析", m1.ok && m1.itemsCreated === 2,
      `${m1.status} created=${m1.itemsCreated}`);
    check("E11.2", "记录迁移后的实际地址",
      movedSrc.resolved_feed_url === `${ORIGIN}/moved-target`, String(movedSrc.resolved_feed_url));
    check("E11.3", "标记为已迁移", m1.feedMoved === true, String(m1.feedMoved));
    check("E11.4", "**不自动改写配置的 feed_url**（等人工确认）",
      movedSrc.feed_url === `${ORIGIN}/moved`, String(movedSrc.feed_url));

    // ── E12 超过字节上限 ────────────────────────────────────────────
    console.log("\nE12  XML 体积超过上限\n");
    console.log(`     （fixture 原始大小 ${(Buffer.byteLength(HUGE_RSS) / 1024 / 1024).toFixed(2)} MB，上限 ${(FEED_MAX_BYTES / 1024 / 1024).toFixed(0)} MB）`);
    const hugeId = await mkSource("/huge", "__edge_huge__");
    const h1 = await ingestSource(hugeId, opts);
    check("E12.1", "被截断时如实标记 truncated", h1.truncated === true, String(h1.truncated));
    // 解析器只认完整的 <item>…</item>，截断尾部被自动忽略 —— 数据是对的，
    // 但「只看到一部分」绝不能长得和「全看到了」一样，状态必须说明白
    check("E12.2", "状态为 feed_truncated 而非笼统的 ok",
      h1.status === "feed_truncated", h1.status);
    check("E12.3", "错误信息说明少看了条目",
      (h1.error ?? "").includes("上限") && (h1.error ?? "").includes("未纳入"),
      String(h1.error).slice(0, 70));
    const hugeCount = await prisma.sourceItem.count({ where: { source_id: hugeId } });
    check("E12.4", "已解析出的条目照常保留（不因截断丢弃好数据）",
      hugeCount > 0 && hugeCount === h1.itemsCreated, `${hugeCount} 条`);
    check("E12.5", "落库数明显少于订阅实际条目数（6000）",
      h1.itemsSeen < 6000, `itemsSeen=${h1.itemsSeen}`);

    // ── 单源失败不影响其他源 ────────────────────────────────────────
    console.log("\nX  单源失败隔离\n");
    const deadId = await mkSource("/does-not-exist", "__edge_dead__");
    const okId = await mkSource("/windowed", "__edge_ok2__").catch(() => null);
    const dRes = await ingestSource(deadId, opts);
    check("X1", "失败源自身记失败", !dRes.ok && dRes.status === "http_error", dRes.status);
    check("X2", "失败源不抛异常（不会中断任务块）", true);
    check("X3", "同一订阅地址仍受唯一约束保护", okId === null);

    // ── 全程未触碰发布层与 lifecycle ────────────────────────────────
    console.log("\nZ  边界不变量\n");
    check("Z1", "ResourceContent 仍为 27 条",
      (await prisma.resourceContent.count()) === 27);
    check("Z2", "未产生任何 ToolHealthEvent（v4 基线不变）",
      (await prisma.toolHealthEvent.count({ where: { probe_version: 4 } })) === 429);
    check("Z3", "全程无文章原文请求（fetchArticles 默认关闭）",
      state.requests.every((r) => !r.path.startsWith("/posts/")),
      state.requests.filter((r) => r.path.startsWith("/posts/")).length + " 次");
  } finally {
    // run 先删：它有指向 content_sources 的外键，不先清就删不掉源
    await prisma.contentSourceRun.deleteMany({ where: { source_id: { in: created } } });
    await prisma.sourceItem.deleteMany({ where: { source_id: { in: created } } });
    await prisma.bulkJobItem.deleteMany({ where: { source_id: { in: created } } });
    await prisma.contentSource.deleteMany({ where: { id: { in: created } } });
    await purgeTestSources();
    const left = await prisma.contentSource.count({ where: { publisher: "__edge_test__" } });
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
  .catch((e) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
