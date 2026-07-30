/**
 * C4 文章增强离线测试。
 *
 *   npm run test:enrich
 *
 * 全部走真实 Prisma + 真实 SSRF + 真实 robots，网络层注入内存 fixture ——
 * **不访问任何真实站点、不调 AI、不写 ResourceContent、不改 Website/Lifecycle**。
 *
 * 核心命题有三条：
 *   1. 完整 HTML 与完整正文**永远不落库**；
 *   2. 源站拒绝 / 正文不足是**有效结论**，不是我们的故障；
 *   3. 基础设施故障绝不归因于源，也不写谎称抓过的 run。
 */
import http from "http";
import crypto from "crypto";

import { ArticleFetchPolicy, EnrichmentOutcome, SourceRunErrorDomain } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  ARTICLE_MAX_BYTES,
  enrichSourceItem,
  infraDomainOf,
  isSourceSide,
  parseRetryAfter,
  politeDelay,
  selectEnrichableItems,
  SAME_HOST_DELAY_MS,
} from "@/lib/content/article-enrich";
import { extractArticle, MIN_VISIBLE_TEXT_CHARS } from "@/lib/content/html-extract";
import { terminalizeJob } from "@/lib/website/bulk-job";
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
function section(title: string) {
  console.log(`\n${title}\n`);
}

const ORIGIN = "https://enrich.example";
const PUBLIC_IP = "93.184.216.34";
const MARKER = "__enrich_test_publisher__";

const BODY = "这是一段足够长的正文。".repeat(40); // 远超 300 字符下限

const FULL_PAGE = `<!doctype html>
<html lang="en">
<head>
  <title>Doc Title</title>
  <link rel="canonical" href="/canonical/article-1">
  <meta property="og:title" content="OG Title">
  <meta property="og:description" content="OG description here">
  <meta property="article:published_time" content="2026-07-20T08:00:00Z">
  <meta name="author" content="Ada Lovelace">
  <script type="application/ld+json">
    {"@type":"NewsArticle","headline":"LD Headline","author":{"name":"Grace Hopper"},
     "datePublished":"2026-07-19T00:00:00Z","dateModified":"2026-07-21T00:00:00Z"}
  </script>
  <style>.secret-style{color:red}</style>
</head>
<body>
  <nav>NAV_SHOULD_NOT_APPEAR</nav>
  <header>HEADER_SHOULD_NOT_APPEAR</header>
  <aside>ASIDE_SHOULD_NOT_APPEAR</aside>
  <article>
    <h1>Article Heading</h1>
    <h2>Sub Heading</h2>
    <p>${BODY}</p>
    <script>var SCRIPT_SHOULD_NOT_APPEAR = 1;</script>
    <form><input name="FORM_SHOULD_NOT_APPEAR"></form>
  </article>
  <footer>FOOTER_SHOULD_NOT_APPEAR</footer>
</body></html>`;

const MAIN_ONLY = `<!doctype html><html><head><title>Main Only</title></head>
<body><nav>NAV_SHOULD_NOT_APPEAR</nav><main><h1>Main Heading</h1><p>${BODY}</p></main>
<footer>FOOTER_SHOULD_NOT_APPEAR</footer></body></html>`;

const SPA_SHELL = `<!doctype html><html><head><title>App</title></head>
<body><div id="root"></div><script>window.__APP__=1</script></body></html>`;

const THIN_PAGE = `<!doctype html><html><head><title>Thin</title></head>
<body><article><p>too short</p></article></body></html>`;

const BIG_PAGE = `<!doctype html><html><head><title>Big</title></head><body><article>` +
  `<p>${"A".repeat(ARTICLE_MAX_BYTES + 200_000)}</p></article></body></html>`;

type MockState = {
  requests: string[];
  conditionalHit: boolean;
};

function mock(state: MockState): { transport: Transport; resolve: ResolveFn } {
  const transport: Transport = async (args: TransportArgs) => {
    state.requests.push(`${args.method} ${args.url.host}${args.url.pathname}`);
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      const buf = Buffer.from(args.wantBody ? body : "", "utf8");
      const max = args.maxBytes ?? 65_536;
      return {
        status,
        headers: { "content-type": "text/html; charset=utf-8", ...headers } as http.IncomingHttpHeaders,
        buffer: buf.subarray(0, max),
        // transport 只在远超上限时报 truncated；服务端认 Range 时不报
        truncated: buf.length > Math.max(262_144, max * 4),
      };
    };
    const path = args.url.pathname;
    if (path === "/robots.txt") {
      // robots 结论按 origin 缓存 24 小时，所以「拒绝」必须用独立主机，
      // 否则先前用例缓存的 allow 会让这条用例形同虚设。
      const body =
        args.url.host === "blocked.example"
          ? "User-agent: *\nDisallow: /\n"
          : "User-agent: *\nDisallow:\n";
      return send(200, body, { "content-type": "text/plain" });
    }
    if (path === "/full") return send(200, FULL_PAGE, { etag: '"a1"' });
    if (path === "/main") return send(200, MAIN_ONLY);
    if (path === "/spa") return send(200, SPA_SHELL);
    if (path === "/thin") return send(200, THIN_PAGE);
    if (path === "/big") return send(200, BIG_PAGE);
    if (path === "/pdf") return send(200, "%PDF-1.7 binary", { "content-type": "application/pdf" });
    if (path === "/403") return send(403, "<html>forbidden</html>");
    if (path === "/429") return send(429, "<html>slow down</html>", { "retry-after": "120" });
    if (path === "/503") return send(503, "<html>maintenance</html>", { "retry-after": "60" });
    if (path === "/500") return send(500, "<html>boom</html>");
    if (path === "/cond") {
      if (args.conditional?.etag === '"c1"') {
        state.conditionalHit = true;
        return send(304, "", { etag: '"c1"' });
      }
      return send(200, FULL_PAGE, { etag: '"c1"' });
    }
    if (path === "/redirect-ok") {
      return { status: 301, headers: { location: `${ORIGIN}/full` } as http.IncomingHttpHeaders, buffer: Buffer.alloc(0), truncated: false };
    }
    if (path === "/redirect-private") {
      return { status: 301, headers: { location: "http://169.254.169.254/latest/meta-data/" } as http.IncomingHttpHeaders, buffer: Buffer.alloc(0), truncated: false };
    }
    if (path === "/timeout") throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    return send(404, "<html>nope</html>");
  };

  const resolve: ResolveFn = async (hostname) => {
    if (hostname === "dns-fail.example") throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    if (hostname === "169.254.169.254") return ["169.254.169.254"];
    return [PUBLIC_IP];
  };
  return { transport, resolve };
}

// ---------------------------------------------------------------------------
// 夹具：建一个临时源 + 若干条目，用 publisher marker 标记以便幂等清理
// ---------------------------------------------------------------------------

async function purgeTestData(): Promise<number> {
  const sources = await prisma.contentSource.findMany({
    where: { publisher: MARKER },
    select: { id: true },
  });
  if (!sources.length) return 0;
  const ids = sources.map((s) => s.id);
  const items = await prisma.sourceItem.findMany({ where: { source_id: { in: ids } }, select: { id: true } });
  const itemIds = items.map((i) => i.id);
  if (itemIds.length) {
    await prisma.sourceItemEnrichmentRun.deleteMany({ where: { source_item_id: { in: itemIds } } });
    await prisma.bulkJobItem.updateMany({ where: { source_item_id: { in: itemIds } }, data: { source_item_id: null } });
  }
  await prisma.contentSourceRun.deleteMany({ where: { source_id: { in: ids } } });
  await prisma.bulkJobItem.deleteMany({ where: { source_id: { in: ids } } });
  await prisma.sourceItem.deleteMany({ where: { source_id: { in: ids } } });
  await prisma.contentSource.deleteMany({ where: { id: { in: ids } } });
  return sources.length;
}

let seq = 0;
async function makeSource(policy: ArticleFetchPolicy): Promise<number> {
  seq += 1;
  const src = await prisma.contentSource.create({
    data: {
      external_key: `enrich-test-${Date.now()}-${seq}`,
      name: "Enrich Test",
      kind: "rss",
      feed_url: `${ORIGIN}/feed-${Date.now()}-${seq}.xml`,
      publisher: MARKER,
      article_fetch_policy: policy,
    },
  });
  return src.id;
}

async function makeItem(sourceId: number, path: string, publishedAt?: Date): Promise<number> {
  seq += 1;
  const url = `${ORIGIN}${path}`;
  const item = await prisma.sourceItem.create({
    data: {
      source_id: sourceId,
      url,
      url_hash: crypto.createHash("sha256").update(`${url}#${seq}`).digest("hex").slice(0, 32),
      title: `Item ${seq}`,
      status: "link_only",
      raw_excerpt: "ORIGINAL_SNAPSHOT",
      ...(publishedAt ? { published_at: publishedAt } : {}),
    },
  });
  return item.id;
}

async function main() {
  const purgedBefore = await purgeTestData();
  if (purgedBefore) console.log(`  （清理上一轮残留的 ${purgedBefore} 个测试源）`);

  const state: MockState = { requests: [], conditionalHit: false };
  const { transport, resolve } = mock(state);
  const opts = { transport, resolve, skipPoliteDelay: true };

  const resourceBefore = await prisma.resourceContent.count();
  const healthBefore = await prisma.toolHealthEvent.count();

  // ── T1–T6 纯提取（无 I/O）────────────────────────────────────────────
  section("T1–T6  HTML 提取");
  const full = extractArticle(FULL_PAGE, `${ORIGIN}/full`);
  check("T1.1", "Open Graph 标题优先于 <title>", full.title === "OG Title", full.title ?? "null");
  check("T1.2", "JSON-LD 作者/日期被提取", full.metadata.jsonLdHeadline === "LD Headline"
    && full.metadata.jsonLdAuthor === "Grace Hopper", JSON.stringify({ h: full.metadata.jsonLdHeadline, a: full.metadata.jsonLdAuthor }));
  check("T2.1", "<article> 作为正文容器", full.container === "article", full.container);
  check("T2.2", "正文长度达标", full.visibleTextLength >= MIN_VISIBLE_TEXT_CHARS, `${full.visibleTextLength}`);
  const mainOnly = extractArticle(MAIN_ONLY, `${ORIGIN}/main`);
  check("T3.1", "无 <article> 时回落到 <main>", mainOnly.container === "main", mainOnly.container);
  const noise = ["SCRIPT_SHOULD_NOT_APPEAR", "NAV_SHOULD_NOT_APPEAR", "FOOTER_SHOULD_NOT_APPEAR",
    "HEADER_SHOULD_NOT_APPEAR", "ASIDE_SHOULD_NOT_APPEAR", "FORM_SHOULD_NOT_APPEAR", "secret-style"];
  const leaked = noise.filter((n) => full.visibleText.includes(n) || full.excerpt.includes(n));
  check("T4.1", "script/style/nav/footer/header/aside/form 不进正文", leaked.length === 0, leaked.join(",") || "无泄漏");
  check("T5.1", "canonical 被解析为绝对地址",
    full.canonicalUrl === `${ORIGIN}/canonical/article-1`, full.canonicalUrl ?? "null");
  check("T6.1", "author 来自 meta", full.author === "Ada Lovelace", full.author ?? "null");
  check("T6.2", "published_at 被解析",
    full.publishedAt?.toISOString() === "2026-07-20T08:00:00.000Z", full.publishedAt?.toISOString() ?? "null");
  check("T6.3", "language 取自 <html lang>", full.language === "en", full.language ?? "null");
  check("T6.4", "headings 至多 20 条且有内容", full.headings.length > 0 && full.headings.length <= 20,
    JSON.stringify(full.headings.map((h) => h.level)));

  // ── T7–T9 内容不足 / SPA / 非 HTML ───────────────────────────────────
  section("T7–T9  正文不足 / SPA 空壳 / 非 HTML");
  const okSource = await makeSource(ArticleFetchPolicy.ON_DEMAND);
  const thinId = await makeItem(okSource, "/thin");
  const thin = await enrichSourceItem(thinId, opts);
  check("T7.1", "正文不足记 CONTENT_INSUFFICIENT",
    thin.outcome === EnrichmentOutcome.CONTENT_INSUFFICIENT, `${thin.outcome}`);
  check("T7.2", "正文不足归因于源而非我们", thin.sourceAtFault === true);

  const spaId = await makeItem(okSource, "/spa");
  const spa = await enrichSourceItem(spaId, opts);
  check("T8.1", "SPA 空壳记 CONTENT_INSUFFICIENT",
    spa.outcome === EnrichmentOutcome.CONTENT_INSUFFICIENT, `visible=${spa.visibleTextLength}`);
  check("T8.2", "空壳不被当成成功", spa.ok === false);

  const pdfId = await makeItem(okSource, "/pdf");
  const pdf = await enrichSourceItem(pdfId, opts);
  check("T9.1", "非 HTML 记 UNSUPPORTED", pdf.outcome === EnrichmentOutcome.UNSUPPORTED, `${pdf.outcome}`);

  // ── T10–T12 robots / 403 / 429 ───────────────────────────────────────
  section("T10–T12  robots / WAF / 限流");
  seq += 1;
  const blockedItem = await prisma.sourceItem.create({
    data: {
      source_id: okSource, url: "https://blocked.example/full",
      url_hash: crypto.createHash("sha256").update(`blocked${seq}`).digest("hex").slice(0, 32),
      title: "blocked", status: "link_only",
    },
  });
  const blockedId = blockedItem.id;
  const blocked = await enrichSourceItem(blockedId, opts);
  check("T10.1", "robots disallow 记 BLOCKED/ROBOTS",
    blocked.outcome === EnrichmentOutcome.BLOCKED && blocked.errorDomain === SourceRunErrorDomain.ROBOTS,
    `${blocked.outcome}/${blocked.errorDomain}`);
  const blockedRun = await prisma.sourceItemEnrichmentRun.findFirst({
    where: { source_item_id: blockedId }, orderBy: { started_at: "desc" },
  });
  check("T10.2", "robots 拒绝时不请求页面本身",
    !state.requests.includes("GET blocked.example/full"),
    state.requests.filter((r) => r.includes("blocked.example")).join(" | "));
  check("T10.3", "robots_decision 已记录", blockedRun?.robots_decision === "disallow", `${blockedRun?.robots_decision}`);

  const wafId = await makeItem(okSource, "/403");
  const waf = await enrichSourceItem(wafId, opts);
  check("T11.1", "403 记 BLOCKED 而非系统故障",
    waf.outcome === EnrichmentOutcome.BLOCKED && waf.errorDomain === SourceRunErrorDomain.HTTP,
    `${waf.outcome}/${waf.errorDomain}`);

  const rateId = await makeItem(okSource, "/429");
  const rate = await enrichSourceItem(rateId, opts);
  const rateRun = await prisma.sourceItemEnrichmentRun.findFirst({
    where: { source_item_id: rateId }, orderBy: { started_at: "desc" },
  });
  check("T12.1", "429 记 BLOCKED", rate.outcome === EnrichmentOutcome.BLOCKED, `${rate.outcome}`);
  check("T12.2", "Retry-After 被读出并写进说明",
    (rateRun?.error_message ?? "").includes("120"), rateRun?.error_message ?? "null");
  const svcId = await makeItem(okSource, "/503");
  const svc = await enrichSourceItem(svcId, opts);
  check("T12.3", "带 Retry-After 的 503 记 BLOCKED 而非源故障",
    svc.outcome === EnrichmentOutcome.BLOCKED, `${svc.outcome}`);
  check("T12.4", "parseRetryAfter 支持秒数与 HTTP 日期",
    parseRetryAfter("120", new Date()) === 120_000
      && parseRetryAfter(new Date(Date.now() + 60_000).toUTCString(), new Date()) !== null
      && parseRetryAfter("garbage", new Date()) === null);

  // ── T13 DNS / TLS / timeout ─────────────────────────────────────────
  section("T13  DNS / 网络失败");
  const dnsSource = await makeSource(ArticleFetchPolicy.ON_DEMAND);
  seq += 1;
  const dnsItem = await prisma.sourceItem.create({
    data: {
      source_id: dnsSource, url: "https://dns-fail.example/x",
      url_hash: crypto.createHash("sha256").update(`dns${seq}`).digest("hex").slice(0, 32),
      title: "dns", status: "link_only",
    },
  });
  const dns = await enrichSourceItem(dnsItem.id, opts);
  check("T13.1", "DNS 失败记 SOURCE_ERROR/DNS",
    dns.outcome === EnrichmentOutcome.SOURCE_ERROR && dns.errorDomain === SourceRunErrorDomain.DNS,
    `${dns.outcome}/${dns.errorDomain}`);
  const toId = await makeItem(okSource, "/timeout");
  const to = await enrichSourceItem(toId, opts);
  check("T13.2", "连接中断记 SOURCE_ERROR 而非 INFRA",
    to.outcome === EnrichmentOutcome.SOURCE_ERROR && to.sourceAtFault === true,
    `${to.outcome}/${to.errorDomain}`);
  check("T13.3", "源侧域判定正确",
    isSourceSide(SourceRunErrorDomain.DNS) && isSourceSide(SourceRunErrorDomain.HTTP)
      && !isSourceSide(SourceRunErrorDomain.DATABASE) && !isSourceSide(SourceRunErrorDomain.LEASE));

  // ── T14–T15 重定向 ───────────────────────────────────────────────────
  section("T14–T15  重定向与 SSRF 复检");
  const redirId = await makeItem(okSource, "/redirect-ok");
  const redir = await enrichSourceItem(redirId, opts);
  const redirRun = await prisma.sourceItemEnrichmentRun.findFirst({
    where: { source_item_id: redirId }, orderBy: { started_at: "desc" },
  });
  check("T14.1", "跟随重定向后仍能提取", redir.outcome === EnrichmentOutcome.OK, `${redir.outcome}`);
  check("T14.2", "final_url 记录跳转后的地址",
    redirRun?.final_url === `${ORIGIN}/full`, redirRun?.final_url ?? "null");
  const chain = (redirRun?.evidence_json as { redirectChain?: { ssrfOk: boolean }[] } | null)?.redirectChain ?? [];
  check("T14.3", "每一跳都留下 SSRF 校验结论",
    chain.length >= 2 && chain.every((h) => h.ssrfOk === true), `hops=${chain.length}`);

  const privId = await makeItem(okSource, "/redirect-private");
  const priv = await enrichSourceItem(privId, opts);
  check("T15.1", "重定向到私网被拒", priv.outcome === EnrichmentOutcome.BLOCKED, `${priv.outcome}`);
  check("T15.2", "被拒时没有正文落库", priv.visibleTextLength === null, `${priv.visibleTextLength}`);

  // ── T16–T17 体积上限 ─────────────────────────────────────────────────
  section("T16–T17  体积上限与截断");
  const bigId = await makeItem(okSource, "/big");
  const big = await enrichSourceItem(bigId, opts);
  const bigRun = await prisma.sourceItemEnrichmentRun.findFirst({
    where: { source_item_id: bigId }, orderBy: { started_at: "desc" },
  });
  check("T16.1", "超过 512KB 被截断且如实标记", bigRun?.truncated === true, `bytes=${bigRun?.bytes_read}`);
  check("T16.2", "截断后不超过硬上限", (bigRun?.bytes_read ?? 0) <= ARTICLE_MAX_BYTES, `${bigRun?.bytes_read}`);
  check("T17.1", "截断后仍能安全提取出内容（不抛异常）",
    big.outcome === EnrichmentOutcome.OK || big.outcome === EnrichmentOutcome.CONTENT_INSUFFICIENT,
    `${big.outcome}`);

  // ── T18 完整 HTML 不落库 ─────────────────────────────────────────────
  section("T18  存储边界");
  const okId = await makeItem(okSource, "/full");
  const okRes = await enrichSourceItem(okId, opts);
  const okRun = await prisma.sourceItemEnrichmentRun.findFirstOrThrow({
    where: { source_item_id: okId }, orderBy: { started_at: "desc" },
  });
  check("T18.1", "成功提取记 OK", okRes.outcome === EnrichmentOutcome.OK, `${okRes.outcome}`);
  const serialized = JSON.stringify(okRun);
  const forbidden = ["<!doctype", "<html", "<script", "<style", "SCRIPT_SHOULD_NOT_APPEAR",
    "NAV_SHOULD_NOT_APPEAR", "cookie", "authorization"];
  const hits = forbidden.filter((f) => serialized.toLowerCase().includes(f.toLowerCase()));
  check("T18.2", "整条 run 不含 HTML 标签/脚本/凭据", hits.length === 0, hits.join(",") || "干净");
  check("T18.3", "excerpt 不超过 2000 字符", (okRun.excerpt?.length ?? 0) <= 2_000, `${okRun.excerpt?.length}`);
  check("T18.4", "headings 不超过 20 条",
    ((okRun.headings_json as unknown[]) ?? []).length <= 20,
    `${((okRun.headings_json as unknown[]) ?? []).length}`);
  check("T18.5", "只存正文长度与指纹，不存全文",
    okRun.visible_text_length !== null && okRun.content_hash !== null
      && (okRun.excerpt?.length ?? 0) < (okRun.visible_text_length ?? 0) + 1,
    `len=${okRun.visible_text_length} hash=${okRun.content_hash?.slice(0, 8)}`);

  // 条件请求
  const condId = await makeItem(okSource, "/cond");
  await enrichSourceItem(condId, opts);
  const cond2 = await enrichSourceItem(condId, opts);
  check("T18.6", "第二轮带上 ETag 并命中 304",
    state.conditionalHit && cond2.outcome === EnrichmentOutcome.NOT_MODIFIED, `${cond2.outcome}`);

  // ── T19 同 job 幂等 ──────────────────────────────────────────────────
  section("T19  同 job 重复执行只留一条 run");
  const job = await prisma.bulkJob.create({
    data: { type: "content_article_enrich", status: "queued", total_count: 1 },
  });
  const jobItem = await prisma.bulkJobItem.create({ data: { job_id: job.id, source_item_id: okId } });
  await enrichSourceItem(okId, { ...opts, jobId: job.id, jobItemId: jobItem.id });
  await enrichSourceItem(okId, { ...opts, jobId: job.id, jobItemId: jobItem.id });
  const jobRuns = await prisma.sourceItemEnrichmentRun.count({ where: { job_id: job.id, source_item_id: okId } });
  check("T19.1", "同 job 同条目只有一条 run", jobRuns === 1, `${jobRuns}`);
  let uniqueRejected = false;
  try {
    await prisma.sourceItemEnrichmentRun.create({
      data: { source_item_id: okId, job_id: job.id, outcome: EnrichmentOutcome.OK, requested_url: `${ORIGIN}/dup` },
    });
  } catch (e) {
    uniqueRejected = /Unique constraint/i.test(e instanceof Error ? e.message : "");
  }
  check("T19.2", "unique(job_id, source_item_id) 生效", uniqueRejected);
  await terminalizeJob(job.id, "canceled", "test_cleanup");

  // ── T20 数据库故障归因 ───────────────────────────────────────────────
  section("T20  基础设施故障归因");
  check("T20.1", "数据库错误识别为 DATABASE",
    infraDomainOf(new Error("Can't reach database server at db:5432")) === SourceRunErrorDomain.DATABASE);
  check("T20.2", "连接池耗尽识别为 DATABASE",
    infraDomainOf(new Error("Timed out fetching a new connection from the connection pool")) === SourceRunErrorDomain.DATABASE);
  check("T20.3", "租约丢失识别为 LEASE",
    infraDomainOf(new Error("lease_lost")) === SourceRunErrorDomain.LEASE);
  check("T20.4", "源站错误不被误判为基础设施", infraDomainOf(new Error("HTTP 500 from origin")) === null);
  const missing = await enrichSourceItem(999_999_999, opts);
  check("T20.5", "条目读不到时不写谎称抓过的 run",
    missing.runId === null && missing.sourceAtFault === false, `${missing.errorDomain}`);

  // ── T21 租约丢失不重复处理 ───────────────────────────────────────────
  section("T21  租约与策略闸门");
  check("T21.1", "INFRA_ERROR 永不归因于源",
    !isSourceSide(SourceRunErrorDomain.LEASE) && !isSourceSide(SourceRunErrorDomain.DATABASE)
      && !isSourceSide(SourceRunErrorDomain.INTERNAL));
  const feedOnly = await makeSource(ArticleFetchPolicy.FEED_ONLY);
  const feedOnlyItem = await makeItem(feedOnly, "/full");
  const refused = await enrichSourceItem(feedOnlyItem, opts);
  check("T21.2", "FEED_ONLY 源不抓文章页且不写 run",
    refused.runId === null && refused.ok === false, refused.error ?? "");
  const never = await makeSource(ArticleFetchPolicy.NEVER_FETCH);
  const neverItem = await makeItem(never, "/full");
  const neverRes = await enrichSourceItem(neverItem, opts);
  check("T21.3", "NEVER_FETCH 源同样被拒", neverRes.runId === null);
  const selectable = await selectEnrichableItems(50, [feedOnly, never]);
  check("T21.4", "选择器不会选中 FEED_ONLY / NEVER_FETCH 的条目",
    selectable.length === 0, `${selectable.length}`);
  const t0 = Date.now();
  await politeDelay("polite.example");
  await politeDelay("polite.example");
  check("T21.5", "同域连续请求间隔不少于 2 秒",
    Date.now() - t0 >= SAME_HOST_DELAY_MS - 50, `${Date.now() - t0}ms`);

  // ── T22–T23 不变量 ───────────────────────────────────────────────────
  section("T22–T23  不变量");
  const resourceAfter = await prisma.resourceContent.count();
  check("T22.1", "ResourceContent 未变化", resourceAfter === resourceBefore, `${resourceBefore} → ${resourceAfter}`);
  const healthAfter = await prisma.toolHealthEvent.count();
  check("T22.2", "未产生任何 ToolHealthEvent", healthAfter === healthBefore, `${healthBefore} → ${healthAfter}`);
  const snapshot = await prisma.sourceItem.findUniqueOrThrow({ where: { id: okId } });
  check("T23.1", "SourceItem 原始快照未被改写",
    snapshot.raw_excerpt === "ORIGINAL_SNAPSHOT" && snapshot.status === "link_only",
    `excerpt=${snapshot.raw_excerpt} status=${snapshot.status}`);
  check("T23.2", "增强不写 SourceItem 的正文字段",
    snapshot.raw_content === null && snapshot.content_hash === null);

  const purgedAfter = await purgeTestData();
  const residue = await prisma.contentSource.count({ where: { publisher: MARKER } });
  console.log(`\n收尾：清理 ${purgedAfter} 个测试源，残留 ${residue} 个 ${residue === 0 ? "✅" : "❌"}`);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) {
    console.log("\n失败项：");
    for (const f of failures) console.log(`  - ${f}`);
  }
  await prisma.$disconnect();
  if (fail) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await purgeTestData();
  } finally {
    await prisma.$disconnect();
  }
  process.exit(1);
});
