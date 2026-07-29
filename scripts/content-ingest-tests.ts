/**
 * AI Content Intelligence 采集层测试。
 *
 *   npm run test:ingest
 *
 * 解析与 URL 归一化是纯函数，不碰网络也不碰库；
 * 采集落库走真实的 Prisma 与真实的 SSRF 校验，但 transport 注入内存 fixture ——
 * **不访问任何真实站点、不调 AI、不写 ResourceContent**。
 * 收尾删除本脚本自建的临时源与条目。
 */
import http from "http";

import { prisma } from "@/lib/prisma";
import { parseFeed, htmlToText, parseFeedDate, decodeEntities } from "@/lib/content/feed-parser";
import { normalizeUrl, contentHash } from "@/lib/content/url-normalize";
import { ingestSource, submitManualUrl, backoffMinutes, selectDueSources } from "@/lib/content/ingest";
import type { Transport, TransportArgs } from "@/lib/website/probe/http-client";
import type { ResolveFn } from "@/lib/website/probe/ssrf";
import { assertSafeUrl } from "@/lib/website/probe/ssrf";

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

// ── fixture ────────────────────────────────────────────────────────────
const HOST = "feeds.example";
const ORIGIN = `https://${HOST}`;
const PUBLIC_IP = "93.184.216.34"; // 真实公网地址：SSRF 会按生产规则放行

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>Acme AI Blog</title>
  <link>https://acme.example/</link>
  <item>
    <title>Acme ships Model X</title>
    <link>https://acme.example/blog/model-x?utm_source=rss&amp;utm_medium=feed</link>
    <guid isPermaLink="false">acme-model-x-2026</guid>
    <dc:creator>Jane Doe</dc:creator>
    <pubDate>Tue, 28 Jul 2026 10:00:00 GMT</pubDate>
    <description><![CDATA[<p>Acme <b>ships</b> Model X today.</p>]]></description>
    <content:encoded><![CDATA[<p>Acme ships Model X today. It runs 3x faster.</p><script>bad()</script>]]></content:encoded>
  </item>
  <item>
    <title>Pricing update</title>
    <link>https://acme.example/blog/pricing</link>
    <pubDate>Mon, 27 Jul 2026 08:30:00 GMT</pubDate>
    <description>We changed our pricing &amp; plans.</description>
  </item>
</channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Beta Labs</title>
  <link rel="self" href="https://beta.example/feed"/>
  <link rel="alternate" href="https://beta.example/"/>
  <entry>
    <title>Beta opens API</title>
    <link rel="alternate" href="https://beta.example/posts/api"/>
    <id>tag:beta.example,2026:post-1</id>
    <author><name>Sam Lee</name></author>
    <published>2026-07-26T12:00:00Z</published>
    <summary>Beta opens its API to everyone.</summary>
    <content type="html">&lt;p&gt;Beta opens its &lt;i&gt;API&lt;/i&gt;.&lt;/p&gt;</content>
  </entry>
</feed>`;

const ARTICLE = `<!doctype html><html><head><title>Acme ships Model X</title></head>
<body><h1>Acme ships Model X</h1><p>Full article body here.</p><script>x()</script></body></html>`;

function mockTransport(): { transport: Transport; resolve: ResolveFn; log: string[] } {
  const log: string[] = [];
  const transport: Transport = async (args: TransportArgs) => {
    const path = args.url.pathname;
    log.push(`${args.method} ${args.url.host}${path}`);
    const send = (status: number, body: string, type = "application/xml") => ({
      status,
      headers: { "content-type": type } as http.IncomingHttpHeaders,
      buffer: Buffer.from(args.wantBody ? body : "", "utf8"),
      truncated: false,
    });
    if (path === "/robots.txt") return send(200, "User-agent: *\nDisallow:\n", "text/plain");
    if (path === "/rss") return send(200, RSS);
    if (path === "/atom") return send(200, ATOM);
    if (path === "/notafeed") return send(200, "<html><body>hello</body></html>", "text/html");
    if (path === "/broken") return send(200, "<rss><channel><item><title>x", "application/xml");
    if (path === "/404") return send(404, "not found", "text/html");
    if (path.startsWith("/blog/") || path.startsWith("/posts/") || path === "/article") {
      return send(200, ARTICLE, "text/html");
    }
    return send(404, "no fixture", "text/html");
  };
  const resolve: ResolveFn = async () => [PUBLIC_IP];
  return { transport, resolve, log };
}

// ── 1. 解析 ────────────────────────────────────────────────────────────
function parserTests() {
  console.log("\n1. RSS / Atom 解析\n");

  const rss = parseFeed(RSS);
  check("P1", "识别为 RSS", rss.kind === "rss", rss.kind);
  check("P2", "取到频道标题", rss.title === "Acme AI Blog", String(rss.title));
  check("P3", "取到两条 item", rss.items.length === 2, String(rss.items.length));
  const a = rss.items[0];
  check("P4", "标题正确", a.title === "Acme ships Model X", a.title);
  check("P5", "link 正确（实体已解码）",
    a.link === "https://acme.example/blog/model-x?utm_source=rss&utm_medium=feed", String(a.link));
  check("P6", "dc:creator 作为作者（命名空间前缀被忽略）", a.author === "Jane Doe", String(a.author));
  check("P7", "pubDate 解析成功", a.publishedAt?.toISOString() === "2026-07-28T10:00:00.000Z",
    String(a.publishedAt?.toISOString()));
  check("P8", "CDATA 摘要取出", (a.excerpt ?? "").includes("<b>ships</b>"), String(a.excerpt).slice(0, 40));
  check("P9", "content:encoded 优先作为正文", (a.content ?? "").includes("3x faster"));
  check("P10", "guid 保留", a.guid === "acme-model-x-2026", String(a.guid));
  check("P11", "第二条无 content 时 content 为 null", rss.items[1].content === null);
  check("P12", "description 中的实体已解码",
    rss.items[1].excerpt === "We changed our pricing & plans.", String(rss.items[1].excerpt));

  const atom = parseFeed(ATOM);
  check("P13", "识别为 Atom", atom.kind === "atom", atom.kind);
  check("P14", "Atom 取 rel=alternate 的 href（不是 rel=self）",
    atom.items[0].link === "https://beta.example/posts/api", String(atom.items[0].link));
  check("P15", "Atom homepage 取 alternate", atom.homepage === "https://beta.example/", String(atom.homepage));
  check("P16", "Atom 作者从 <author><name> 取", atom.items[0].author === "Sam Lee", String(atom.items[0].author));
  check("P17", "Atom published 解析", atom.items[0].publishedAt?.toISOString() === "2026-07-26T12:00:00.000Z");

  let threw = false;
  try { parseFeed("<html><body>not a feed</body></html>"); } catch { threw = true; }
  check("P18", "非订阅内容抛 FeedParseError", threw);

  check("P19", "htmlToText 去掉 script", !htmlToText(ARTICLE).includes("x()"));
  check("P20", "htmlToText 保留正文", htmlToText(ARTICLE).includes("Full article body here."));
  check("P21", "实体解码：数字与命名", decodeEntities("a&#65;b&amp;c&#x42;") === "aAb&cB",
    decodeEntities("a&#65;b&amp;c&#x42;"));
  check("P22", "荒谬日期判为无效", parseFeedDate("Thu, 01 Jan 1970 00:00:00 GMT") === null);
  check("P23", "无法解析的日期返回 null", parseFeedDate("не дата") === null);
}

// ── 2. URL 规范化 ──────────────────────────────────────────────────────
function urlTests() {
  console.log("\n2. URL 规范化与去重键\n");

  const withUtm = normalizeUrl("https://acme.example/blog/x?utm_source=rss&utm_medium=feed&id=7");
  check("U1", "去掉 utm_* 但保留业务参数",
    withUtm?.url === "https://acme.example/blog/x?id=7", String(withUtm?.url));

  const a = normalizeUrl("https://Acme.Example:443/blog/x/?b=2&a=1#frag");
  const b = normalizeUrl("https://acme.example/blog/x?a=1&b=2");
  check("U2", "大小写/默认端口/末尾斜杠/fragment/参数顺序归一后一致",
    a?.hash === b?.hash, `${a?.url} vs ${b?.url}`);

  check("U3", "根路径保留斜杠", normalizeUrl("https://acme.example/")?.url === "https://acme.example/");
  check("U4", "相对地址按 base 解析",
    normalizeUrl("/blog/y", "https://acme.example/feed")?.url === "https://acme.example/blog/y");
  check("U5", "非 http(s) 拒绝", normalizeUrl("javascript:alert(1)") === null);
  check("U6", "无法解析的返回 null", normalizeUrl("not a url") === null);
  check("U7", "认证信息被剥离",
    !(normalizeUrl("https://u:p@acme.example/x")?.url ?? "").includes("u:p"),
    String(normalizeUrl("https://u:p@acme.example/x")?.url));
  check("U8", "不同文章 hash 不同",
    normalizeUrl("https://acme.example/a")?.hash !== normalizeUrl("https://acme.example/b")?.hash);
  check("U9", "刻意不去 www（可能是不同页面）",
    normalizeUrl("https://www.acme.example/x")?.hash !== normalizeUrl("https://acme.example/x")?.hash);
  check("U10", "内容哈希忽略空白差异",
    contentHash("hello   world\n\n") === contentHash("hello world"));
  check("U11", "内容不同则哈希不同", contentHash("a") !== contentHash("b"));
}

// ── 3. SSRF（复用探针的生产校验，未放松任何规则）─────────────────────────
async function ssrfTests() {
  console.log("\n3. SSRF（采集与探测共用同一套校验）\n");
  for (const [id, url, expected] of [
    ["S1", "http://127.0.0.1/feed", "private_ip"],
    ["S2", "http://169.254.169.254/latest/meta-data/", "metadata_endpoint"],
    ["S3", "http://10.0.0.1/feed", "private_ip"],
    ["S4", "http://localhost/feed", "hostname_not_allowed"],
    ["S5", "https://acme.example:8080/feed", "port_not_allowed"],
    ["S6", "file:///etc/passwd", "protocol_not_allowed"],
  ] as [string, string, string][]) {
    const v = await assertSafeUrl(url, async () => [PUBLIC_IP]);
    check(id, `${url} 被拒 → ${expected}`, !v.safe && v.reason === expected, v.safe ? "safe!" : v.reason);
  }
  const dns = await assertSafeUrl("https://gone.example/feed", async () => {
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  });
  check("S7", "DNS 失败走 dns 通道而非 unsafe",
    !dns.safe && dns.kind === "dns", dns.safe ? "safe" : dns.kind);
}

// ── 4. 采集落库 ────────────────────────────────────────────────────────
async function ingestTests() {
  console.log("\n4. 采集落库（真实 Prisma + 真实 SSRF + 内存 transport）\n");
  const mock = mockTransport();
  const opts = { transport: mock.transport, resolve: mock.resolve };
  const created: number[] = [];

  // 前置清理：上一轮若在数据库中断时崩溃，会留下同名同 feed_url 的测试源，
  // 下一轮建源就会撞唯一约束。只按 publisher 标记清，碰不到真实源。
  await purgeTestSources();

  const mkSource = async (kind: "rss" | "manual", feedPath: string | null, name: string) => {
    const s = await prisma.contentSource.create({
      data: {
        name, kind, publisher: "__ingest_test__",
        feed_url: feedPath ? `${ORIGIN}${feedPath}` : null,
        fetch_interval_minutes: 60,
      },
      select: { id: true },
    });
    created.push(s.id);
    return s.id;
  };

  try {
    // 首轮抓取
    const rssId = await mkSource("rss", "/rss", "__test_rss__");
    const r1 = await ingestSource(rssId, opts);
    check("I1", "抓取成功", r1.ok && r1.status === "ok", `${r1.status} ${r1.error ?? ""}`);
    check("I2", "看到 2 条、落库 2 条", r1.itemsSeen === 2 && r1.itemsCreated === 2,
      `seen=${r1.itemsSeen} created=${r1.itemsCreated}`);

    const items = await prisma.sourceItem.findMany({
      where: { source_id: rssId }, orderBy: { id: "asc" },
    });
    check("I3", "跟踪参数已在落库前剥离",
      items[0].url === "https://acme.example/blog/model-x", items[0].url);
    check("I4", "正文取自 content:encoded 且已去标签",
      (items[0].raw_content ?? "").includes("3x faster") && !(items[0].raw_content ?? "").includes("<p>"),
      String(items[0].raw_content).slice(0, 50));
    check("I5", "作者/发布时间落库", items[0].author === "Jane Doe" && items[0].published_at !== null);
    check("I6", "内容哈希已计算", (items[0].content_hash ?? "").length === 32);
    check("I7", "无正文的条目记 link_only",
      items[1].status === "link_only", items[1].status);
    check("I8", "guid 存入 canonical_url", items[0].canonical_url === "acme-model-x-2026",
      String(items[0].canonical_url));

    // 幂等：再抓一次
    const r2 = await ingestSource(rssId, opts);
    check("I9", "重复抓取不新增条目", r2.itemsCreated === 0 && r2.itemsDuplicate === 2,
      `created=${r2.itemsCreated} duplicate=${r2.itemsDuplicate}`);
    check("I10", "库里仍是 2 条",
      (await prisma.sourceItem.count({ where: { source_id: rssId } })) === 2);

    const src = await prisma.contentSource.findUniqueOrThrow({ where: { id: rssId } });
    check("I11", "item_count 只统计新增", src.item_count === 2, String(src.item_count));
    check("I12", "已排下一次抓取", src.next_fetch_at !== null && src.next_fetch_at > new Date());
    check("I13", "连续失败计数为 0", src.consecutive_failures === 0);

    // Atom
    const atomId = await mkSource("rss", "/atom", "__test_atom__");
    const r3 = await ingestSource(atomId, opts);
    check("I14", "Atom 源同样能落库", r3.ok && r3.itemsCreated === 1,
      `${r3.status} created=${r3.itemsCreated}`);

    // 跨源不去重
    const dupId = await mkSource("rss", "/rss", "__test_rss_dup__").catch(() => null);
    check("I15", "同一订阅地址不能重复配置（唯一约束生效）", dupId === null,
      dupId === null ? "" : `建成了 #${dupId}`);

    // 抓取失败：不落条目，只记状态并退避
    const badId = await mkSource("rss", "/404", "__test_404__");
    const r4 = await ingestSource(badId, opts);
    check("I16", "HTTP 404 记 http_error 且不落条目",
      !r4.ok && r4.status === "http_error" && r4.itemsCreated === 0, `${r4.status}`);
    const badSrc = await prisma.contentSource.findUniqueOrThrow({ where: { id: badId } });
    check("I17", "失败后 consecutive_failures 递增", badSrc.consecutive_failures === 1,
      String(badSrc.consecutive_failures));
    check("I18", "失败后退避（下次 > 基础间隔）",
      (badSrc.next_fetch_at!.getTime() - Date.now()) / 60_000 > 60,
      `${((badSrc.next_fetch_at!.getTime() - Date.now()) / 60_000).toFixed(0)} 分钟后`);

    const notFeedId = await mkSource("rss", "/notafeed", "__test_notfeed__");
    const r5 = await ingestSource(notFeedId, opts);
    check("I19", "非订阅内容记 parse_error", !r5.ok && r5.status === "parse_error", r5.status);

    // 人工提交
    const manualId = await mkSource("manual", null, "__test_manual__");
    const m1 = await submitManualUrl(manualId, `${ORIGIN}/article?utm_source=x`, opts);
    check("I20", "人工提交成功", m1.ok === true && m1.duplicate === false,
      m1.ok ? "" : m1.message);
    const m2 = await submitManualUrl(manualId, `${ORIGIN}/article`, opts);
    check("I21", "同一 URL 再提交识别为重复（归一化后相同）",
      m2.ok === true && m2.duplicate === true && m2.itemId === (m1.ok ? m1.itemId : -1),
      m2.ok ? `duplicate=${m2.duplicate}` : m2.message);
    const manualItem = await prisma.sourceItem.findFirstOrThrow({ where: { source_id: manualId } });
    check("I22", "人工提交也抓了正文与标题",
      manualItem.title === "Acme ships Model X" && (manualItem.raw_content ?? "").includes("Full article"),
      manualItem.title);
    check("I23", "manual 源不会被订阅抓取选中",
      !(await selectDueSources(100)).includes(manualId));

    const m3 = await submitManualUrl(rssId, `${ORIGIN}/article`, opts);
    check("I24", "不能往 rss 源人工提交", m3.ok === false, m3.ok ? "居然成功了" : m3.message);

    // 采集绝不触碰发布层
    const resourceCount = await prisma.resourceContent.count();
    check("I25", "ResourceContent 未被写入", resourceCount === 27, `${resourceCount} 条（基线 27）`);

    // 退避函数
    check("I26", "退避：0 次失败用基础间隔", backoffMinutes(60, 0) === 60);
    check("I27", "退避：指数增长", backoffMinutes(60, 3) === 480, String(backoffMinutes(60, 3)));
    check("I28", "退避：上限 24 小时", backoffMinutes(60, 20) === 1440, String(backoffMinutes(60, 20)));

    check("I29", "全程未访问真实站点（仅 fixture 主机）",
      mock.log.every((l) => l.startsWith("GET feeds.example")), mock.log.slice(0, 3).join(" | "));
  } finally {
    // run 先删：它有指向 content_sources 的外键，不先清就删不掉源
    await prisma.contentSourceRun.deleteMany({ where: { source_id: { in: created } } });
    await prisma.sourceItem.deleteMany({ where: { source_id: { in: created } } });
    await prisma.bulkJobItem.deleteMany({ where: { source_id: { in: created } } });
    await prisma.contentSource.deleteMany({ where: { id: { in: created } } });
    await purgeTestSources();
    const left = await prisma.contentSource.count({ where: { publisher: "__ingest_test__" } });
    console.log(`\n收尾：临时源残留 ${left} 个 ${left === 0 ? "✅" : "❌"}`);
  }
}

/** 清掉本套测试自己造的源（按 publisher 标记识别），不碰任何真实源 */
async function purgeTestSources(): Promise<void> {
  const orphans = await prisma.contentSource.findMany({
    where: { publisher: "__ingest_test__" },
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
  parserTests();
  urlTests();
  await ssrfTests();
  await ingestTests();

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
