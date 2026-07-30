/**
 * C4.1 采集完整性与溯源测试。
 *
 *   npm run test:acquisition-integrity
 *
 * 全部走真实 Prisma + 真实 SSRF + 真实 robots，网络层注入内存 fixture ——
 * **不访问任何真实站点、不调 AI、不写 ResourceContent、不改 Website/Lifecycle**。
 *
 * 核心命题：**证明不了完整就不许声称完整**。服务端接受 Range 时会恰好返回上限
 * 字节而不报任何错，正则解析器又能从截断的 XML 里读出前半部分完整的 <item> ——
 * 两件事叠加，半个订阅会被安静地记成完整成功。
 */
import http from "http";
import crypto from "crypto";

import { ArticleFetchPolicy, EnrichmentOutcome } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { enrichSourceItem, safeHost } from "@/lib/content/article-enrich";
import {
  assessFeedCompleteness,
  ingestSource,
  redirectCountOf,
  xmlDocumentClosed,
  FEED_MAX_BYTES,
} from "@/lib/content/ingest";
import { extractArticle, gradeContent } from "@/lib/content/html-extract";
import { parseContentRange, safeFetch, type Transport, type TransportArgs } from "@/lib/website/probe/http-client";
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
const section = (t: string) => console.log(`\n${t}\n`);

const ORIGIN = "https://integrity.example";
const PUBLIC_IP = "93.184.216.34";
const MARKER = "__integrity_test_publisher__";

const RSS_ITEMS = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    `<item><title>I${i}</title><link>${ORIGIN}/a/${i}</link><description>d${i}</description></item>`
  ).join("");
const SMALL_RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${RSS_ITEMS(3)}</channel></rss>`;
/** 掐掉结尾：最后一个 item 断在半路，根元素没有闭合标签 */
const CUT_RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${RSS_ITEMS(3)}<item><title>half`;

const BODY_LONG = "完整正文段落。".repeat(300); // 远超 1500
const BODY_THIN = "简短正文。".repeat(80); // 300–1499 之间

const page = (body: string, head = "") => `<!doctype html><html lang="en"><head><title>T</title>${head}</head>
<body><article><h1>H</h1><p>${body}</p></article></body></html>`;

const PAGE_SUBSTANTIAL = page(BODY_LONG, `<meta property="article:published_time" content="2026-07-20T08:00:00Z">
  <meta name="author" content="Page Author">`);
const PAGE_THIN = page(BODY_THIN);
const PAGE_NO_META = page(BODY_LONG); // 无 author / published：应回落 Feed
const PAGE_MAIN = `<!doctype html><html><head><title>M</title></head><body><main><p>${BODY_LONG}</p></main></body></html>`;

type State = { requests: string[]; resolveCalls: string[] };

function mock(state: State): { transport: Transport; resolve: ResolveFn } {
  const transport: Transport = async (args: TransportArgs) => {
    state.requests.push(`${args.method} ${args.url.host}${args.url.pathname}`);
    const make = (status: number, body: string, headers: Record<string, string> = {}, opts: { limit?: boolean; ended?: boolean } = {}) => {
      const buf = Buffer.from(args.wantBody ? body : "", "utf8");
      const max = args.maxBytes ?? 65_536;
      const sliced = buf.subarray(0, max);
      return {
        status,
        headers: { "content-type": "application/xml", ...headers } as http.IncomingHttpHeaders,
        buffer: sliced,
        truncated: opts.limit ?? false,
        bodyLimitReached: opts.limit ?? sliced.length >= max,
        streamEndedNormally: opts.ended ?? !(opts.limit ?? false),
      };
    };
    const p = args.url.pathname;
    if (p === "/robots.txt") return make(200, "User-agent: *\nDisallow:\n", { "content-type": "text/plain" });

    // ── Feed 完整性场景 ──
    if (p === "/feed-200-small") return make(200, SMALL_RSS);
    if (p === "/feed-206-full") {
      const len = Buffer.byteLength(SMALL_RSS);
      return make(206, SMALL_RSS, { "content-range": `bytes 0-${len - 1}/${len}` });
    }
    if (p === "/feed-206-partial") {
      return make(206, SMALL_RSS, { "content-range": `bytes 0-${Buffer.byteLength(SMALL_RSS) - 1}/9999999` });
    }
    if (p === "/feed-206-norange") return make(206, SMALL_RSS);
    if (p === "/feed-200-limit") {
      return make(200, CUT_RSS, {}, { limit: true, ended: false });
    }
    if (p === "/feed-200-shortread") {
      return make(200, SMALL_RSS, { "content-length": "9999999" });
    }
    if (p === "/feed-cut-xml") return make(200, CUT_RSS);
    if (p === "/feed-304") return make(304, "", { etag: '"e1"' });

    // ── 重定向链 ──
    const redirect = (to: string) => ({
      status: 301,
      headers: { location: to } as http.IncomingHttpHeaders,
      buffer: Buffer.alloc(0),
      truncated: false,
      bodyLimitReached: false,
      streamEndedNormally: true,
    });
    if (p === "/hop1") return redirect(`${ORIGIN}/page-substantial`);
    if (p === "/hop2a") return redirect(`${ORIGIN}/hop2b`);
    if (p === "/hop2b") return redirect(`${ORIGIN}/page-substantial`);
    if (p === "/cross") return redirect("https://other.example/page-substantial");
    if (p === "/to-private") return redirect("http://169.254.169.254/latest/meta-data/");

    // ── 文章页 ──
    const html = { "content-type": "text/html; charset=utf-8" };
    if (p === "/page-substantial") return make(200, PAGE_SUBSTANTIAL, html);
    if (p === "/page-thin") return make(200, PAGE_THIN, html);
    if (p === "/page-nometa") return make(200, PAGE_NO_META, html);
    if (p === "/page-main") return make(200, PAGE_MAIN, html);
    if (p === "/page-pdf") return make(200, "%PDF-1.7", { "content-type": "application/pdf" });
    if (p === "/dns-hell") return make(200, PAGE_SUBSTANTIAL, html);
    return make(404, "<html>nope</html>", html);
  };

  const resolve: ResolveFn = async (hostname) => {
    state.resolveCalls.push(hostname);
    if (hostname === "dns-fail.example") {
      await new Promise((r) => setTimeout(r, 20));
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    }
    if (hostname === "slow-dns.example") await new Promise((r) => setTimeout(r, 25));
    if (hostname === "169.254.169.254") return ["169.254.169.254"];
    return [PUBLIC_IP];
  };
  return { transport, resolve };
}

// ---------------------------------------------------------------------------

async function purge(): Promise<number> {
  const sources = await prisma.contentSource.findMany({ where: { publisher: MARKER }, select: { id: true } });
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
async function makeSource(path: string, policy: ArticleFetchPolicy = ArticleFetchPolicy.FEED_ONLY): Promise<number> {
  seq += 1;
  const s = await prisma.contentSource.create({
    data: {
      external_key: `integrity-${Date.now()}-${seq}`,
      name: "Integrity Test",
      kind: "rss",
      // 同一条 fixture 路径会被多个用例复用，靠 query 保证 feed_url 唯一；
      // mock 按 pathname 分派，query 不影响路由
      feed_url: `${ORIGIN}${path}?s=${seq}`,
      publisher: MARKER,
      article_fetch_policy: policy,
    },
  });
  return s.id;
}

async function makeItem(
  sourceId: number,
  url: string,
  extra: { author?: string | null; publishedAt?: Date | null } = {}
): Promise<number> {
  seq += 1;
  const it = await prisma.sourceItem.create({
    data: {
      source_id: sourceId,
      url,
      url_hash: crypto.createHash("sha256").update(`${url}#${seq}`).digest("hex").slice(0, 32),
      title: `Feed Title ${seq}`,
      status: "link_only",
      raw_excerpt: "ORIGINAL_SNAPSHOT",
      ...(extra.author !== undefined ? { author: extra.author } : {}),
      ...(extra.publishedAt !== undefined ? { published_at: extra.publishedAt } : {}),
    },
  });
  return it.id;
}

async function main() {
  const purged = await purge();
  if (purged) console.log(`  （清理上一轮残留的 ${purged} 个测试源）`);

  const state: State = { requests: [], resolveCalls: [] };
  const { transport, resolve } = mock(state);
  const opts = { transport, resolve };
  const enrichOpts = { ...opts, skipPoliteDelay: true };

  const resourceBefore = await prisma.resourceContent.count();
  const itemsBefore = await prisma.sourceItem.count();

  // ── A. 206 与完整性语义 ─────────────────────────────────────────────
  section("A  206 语义与 Feed 完整性");
  check("A0.1", "parseContentRange 解析正常值",
    JSON.stringify(parseContentRange("bytes 0-99/100")) === JSON.stringify({ start: 0, end: 99, total: 100 }));
  check("A0.2", "星号与垃圾值不产生假数据",
    parseContentRange("bytes */100").start === null && parseContentRange("garbage").total === null);
  check("A0.3", "xmlDocumentClosed 认闭合根元素",
    xmlDocumentClosed(SMALL_RSS) && !xmlDocumentClosed(CUT_RSS));

  const run = async (path: string) => {
    const id = await makeSource(path);
    const r = await ingestSource(id, opts);
    const dbRun = await prisma.contentSourceRun.findFirst({ where: { source_id: id }, orderBy: { id: "desc" } });
    return { r, dbRun };
  };

  const a1 = await run("/feed-206-full");
  check("A1.1", "206 且 Content-Range 覆盖完整资源 → 判完整",
    a1.r.runOutcome === "OK" && a1.dbRun?.truncated === false, `${a1.r.runOutcome} truncated=${a1.dbRun?.truncated}`);
  check("A1.2", "不误记 truncated", a1.r.status === "ok", `${a1.r.status}`);

  const a2 = await run("/feed-206-partial");
  check("A2.1", "206 只覆盖前部 → PARTIAL_SUCCESS/TRUNCATED",
    a2.r.runOutcome === "PARTIAL_SUCCESS" && a2.r.errorDomain === "TRUNCATED",
    `${a2.r.runOutcome}/${a2.r.errorDomain}`);
  check("A2.2", "已解析条目仍然保留", (a2.r.itemsCreated ?? 0) > 0, `created=${a2.r.itemsCreated}`);
  check("A2.3", "不计入来源失败", a2.r.sourceAtFault === false);
  check("A2.4", "run 写明不完整原因",
    (a2.dbRun?.error_message ?? "").includes("Content-Range"), a2.dbRun?.error_message ?? "null");

  const a3 = await run("/feed-206-norange");
  check("A3.1", "206 无 Content-Range → 证明不了完整即判不完整",
    a3.r.runOutcome === "PARTIAL_SUCCESS", `${a3.r.runOutcome}`);
  check("A3.2", "原因指明无法证明", (a3.dbRun?.error_message ?? "").includes("206"), a3.dbRun?.error_message ?? "");

  const a4 = await run("/feed-200-limit");
  check("A4.1", "200 但读满上限 → 必须报告",
    a4.r.runOutcome === "PARTIAL_SUCCESS" && a4.dbRun?.truncated === true, `${a4.r.runOutcome}`);

  const a5src = await makeSource("/feed-304");
  await prisma.contentSource.update({ where: { id: a5src }, data: { etag: '"e1"' } });
  const a5 = await ingestSource(a5src, opts);
  check("A5.1", "304 记 NOT_MODIFIED 且不参与完整性判断",
    a5.runOutcome === "NOT_MODIFIED" && a5.errorDomain === "NONE", `${a5.runOutcome}/${a5.errorDomain}`);

  const a6 = await run("/feed-200-small");
  check("A6.1", "小于上限且正常结束的 200 → 完整，不误判",
    a6.r.runOutcome === "OK" && a6.dbRun?.truncated === false, `${a6.r.runOutcome}`);

  const a7 = await run("/feed-200-shortread");
  check("A7.1", "Content-Length 大于实际读取 → 不完整",
    a7.r.runOutcome === "PARTIAL_SUCCESS", `${a7.r.runOutcome}`);

  const a8 = await run("/feed-cut-xml");
  check("A8.1", "XML 根元素未闭合 → 不完整",
    a8.r.runOutcome === "PARTIAL_SUCCESS", `${a8.r.runOutcome}`);
  check("A8.2", "已解析的完整 item 仍保留", (a8.r.itemsCreated ?? 0) >= 3, `created=${a8.r.itemsCreated}`);
  check("A8.3", "不伪装为完整成功", a8.r.status !== "ok", `${a8.r.status}`);
  check("A8.4", "maxItems 上限未被改动", FEED_MAX_BYTES === 1_048_576);

  // ── B. redirect_count ───────────────────────────────────────────────
  section("B  redirect_count 语义");
  check("B0.1", "纯函数：单元素链 = 0 跳", redirectCountOf([{ hop: 0 }]) === 0);
  check("B0.2", "两元素链 = 1 跳", redirectCountOf([{ hop: 0 }, { hop: 1 }]) === 1);
  check("B0.3", "三元素链 = 2 跳", redirectCountOf([{ hop: 0 }, { hop: 1 }, { hop: 2 }]) === 2);
  check("B0.4", "链缺失时返回 null，不盲目改写",
    redirectCountOf(null) === null && redirectCountOf(undefined) === null);

  const b1 = await run("/feed-200-small");
  check("B1.1", "无重定向的真实采集 redirect_count = 0", b1.dbRun?.redirect_count === 0, `${b1.dbRun?.redirect_count}`);
  check("B1.2", "evidence 仍保留完整请求链（含首次请求）",
    ((b1.dbRun?.evidence_json as { redirectChain?: unknown[] })?.redirectChain ?? []).length === 1);

  const bSrc = await makeSource("/x", ArticleFetchPolicy.ON_DEMAND);
  const b2Item = await makeItem(bSrc, `${ORIGIN}/hop1`);
  await enrichSourceItem(b2Item, enrichOpts);
  const b2Run = await prisma.sourceItemEnrichmentRun.findFirstOrThrow({ where: { source_item_id: b2Item } });
  check("B2.1", "一跳重定向 redirect_count = 1", b2Run.redirect_count === 1, `${b2Run.redirect_count}`);
  const b3Item = await makeItem(bSrc, `${ORIGIN}/hop2a`);
  await enrichSourceItem(b3Item, enrichOpts);
  const b3Run = await prisma.sourceItemEnrichmentRun.findFirstOrThrow({ where: { source_item_id: b3Item } });
  check("B3.1", "两跳重定向 redirect_count = 2", b3Run.redirect_count === 2, `${b3Run.redirect_count}`);
  check("B3.2", "两张 run 表使用同一语义（均为真实跳数）",
    b1.dbRun?.redirect_count === 0 && b2Run.redirect_count === 1 && b3Run.redirect_count === 2);

  // ── C. DNS 延迟 ─────────────────────────────────────────────────────
  section("C  DNS 延迟");
  const beforeCalls = state.resolveCalls.length;
  const c1 = await safeFetch(`${ORIGIN}/page-substantial`, { method: "GET", ...opts });
  const c1Calls = state.resolveCalls.length - beforeCalls;
  check("C1.1", "单跳记录 DNS 耗时", c1.kind === "response" && typeof c1.dnsLatencyMs === "number",
    c1.kind === "response" ? `${c1.dnsLatencyMs}ms` : c1.kind);
  check("C1.2", "单跳只解析一次（未因计时多解析）", c1Calls === 1, `${c1Calls} 次`);

  const beforeSlow = state.resolveCalls.length;
  const c2 = await safeFetch(`${ORIGIN}/hop2a`, { method: "GET", ...opts });
  const c2Calls = state.resolveCalls.length - beforeSlow;
  check("C2.1", "多跳累计 DNS 耗时", c2.kind === "response" && c2.dnsLatencyMs >= 0,
    c2.kind === "response" ? `${c2.dnsLatencyMs}ms` : c2.kind);
  check("C2.2", "三次请求恰好三次解析（每跳一次，不重复）", c2Calls === 3, `${c2Calls} 次`);

  const c3 = await safeFetch("https://dns-fail.example/x", { method: "GET", ...opts });
  check("C3.1", "DNS 失败仍记录已消耗的解析时间",
    c3.kind === "network_error" && c3.dnsLatencyMs > 0, c3.kind === "network_error" ? `${c3.dnsLatencyMs}ms` : c3.kind);
  check("C3.2", "DNS 失败仍归为 network_error/dns",
    c3.kind === "network_error" && c3.errorKind === "dns");

  const c4 = await safeFetch("https://slow-dns.example/page-substantial", { method: "GET", ...opts });
  check("C4.1", "慢解析被如实计时（≥20ms）",
    c4.kind === "response" && c4.dnsLatencyMs >= 20, c4.kind === "response" ? `${c4.dnsLatencyMs}ms` : c4.kind);
  check("C5.1", "pinned IP 仍属已校验地址",
    c4.kind === "response" && c4.resolvedIps.includes(c4.pinnedIp));

  const c6 = await safeFetch(`${ORIGIN}/to-private`, { method: "GET", ...opts });
  check("C6.1", "重定向到私网仍被拒（rebinding 防护未退化）", c6.kind === "unsafe", c6.kind);
  check("C6.2", "被拒时也记录已消耗的 DNS 时间", c6.kind === "unsafe" && c6.dnsLatencyMs >= 0);

  const cSrc = await makeSource("/feed-200-small");
  const cRun = await ingestSource(cSrc, opts);
  const cDb = await prisma.contentSourceRun.findFirstOrThrow({ where: { source_id: cSrc }, orderBy: { id: "desc" } });
  check("C7.1", "Feed run 的 latency_dns_ms 不再为 null", cDb.latency_dns_ms !== null, `${cDb.latency_dns_ms}`);
  void cRun;
  const cItem = await makeItem(bSrc, `${ORIGIN}/page-substantial`);
  await enrichSourceItem(cItem, enrichOpts);
  const cItemRun = await prisma.sourceItemEnrichmentRun.findFirstOrThrow({ where: { source_item_id: cItem } });
  check("C7.2", "Article run 的 latency_dns_ms 不再为 null", cItemRun.latency_dns_ms !== null, `${cItemRun.latency_dns_ms}`);

  // ── D. 提取质量分级 ─────────────────────────────────────────────────
  section("D  提取质量分级");
  check("D0.1", "<300 → INSUFFICIENT", gradeContent(299) === "INSUFFICIENT");
  check("D0.2", "300 → THIN", gradeContent(300) === "THIN");
  check("D0.3", "1499 → THIN", gradeContent(1499) === "THIN");
  check("D0.4", "1500 → SUBSTANTIAL", gradeContent(1500) === "SUBSTANTIAL");

  const thinItem = await makeItem(bSrc, `${ORIGIN}/page-thin`);
  const thinRes = await enrichSourceItem(thinItem, enrichOpts);
  const thinRun = await prisma.sourceItemEnrichmentRun.findFirstOrThrow({ where: { source_item_id: thinItem } });
  const thinMeta = thinRun.metadata_json as Record<string, string>;
  check("D1.1", "薄内容判 THIN 但 outcome 仍是 OK",
    thinMeta.contentQuality === "THIN" && thinRes.outcome === EnrichmentOutcome.OK,
    `${thinMeta.contentQuality}/${thinRes.outcome} len=${thinRun.visible_text_length}`);
  check("D1.2", "OK + THIN 是允许的组合", thinRes.ok === true);

  const subRun = cItemRun.metadata_json as Record<string, string>;
  check("D2.1", "长文判 SUBSTANTIAL", subRun.contentQuality === "SUBSTANTIAL",
    `${subRun.contentQuality} len=${cItemRun.visible_text_length}`);
  check("D2.2", "extraction_method 记 ARTICLE", subRun.extractionMethod === "ARTICLE", subRun.extractionMethod);

  const mainItem = await makeItem(bSrc, `${ORIGIN}/page-main`);
  await enrichSourceItem(mainItem, enrichOpts);
  const mainRun = await prisma.sourceItemEnrichmentRun.findFirstOrThrow({ where: { source_item_id: mainItem } });
  check("D3.1", "回落 <main> 时 extraction_method 记 MAIN",
    (mainRun.metadata_json as Record<string, string>).extractionMethod === "MAIN",
    (mainRun.metadata_json as Record<string, string>).extractionMethod);

  const pdfItem = await makeItem(bSrc, `${ORIGIN}/page-pdf`);
  const pdfRes = await enrichSourceItem(pdfItem, enrichOpts);
  check("D4.1", "非 HTML → UNSUPPORTED", pdfRes.outcome === EnrichmentOutcome.UNSUPPORTED, `${pdfRes.outcome}`);
  check("D5.1", "质量分级不触发重新抓取（每条只请求一次页面）",
    state.requests.filter((r) => r.endsWith("/page-thin")).length === 1,
    `${state.requests.filter((r) => r.endsWith("/page-thin")).length} 次`);

  // ── E. 字段溯源 ─────────────────────────────────────────────────────
  section("E  字段溯源");
  const pageMeta = extractArticle(PAGE_SUBSTANTIAL, `${ORIGIN}/page-substantial`);
  check("E0.1", "页面有 meta 时间 → publishedAtSource=META",
    pageMeta.publishedAtSource === "META", pageMeta.publishedAtSource);
  check("E0.2", "页面有 meta 作者 → authorSource=META", pageMeta.authorSource === "META", pageMeta.authorSource);
  const noMeta = extractArticle(PAGE_NO_META, `${ORIGIN}/page-nometa`);
  check("E0.3", "页面无时间/作者 → NONE",
    noMeta.publishedAtSource === "NONE" && noMeta.authorSource === "NONE",
    `${noMeta.publishedAtSource}/${noMeta.authorSource}`);
  check("E0.4", "titleSource 记 HTML_TITLE", noMeta.titleSource === "HTML_TITLE", noMeta.titleSource);

  const feedDate = new Date("2026-07-01T00:00:00Z");
  const fbItem = await makeItem(bSrc, `${ORIGIN}/page-nometa`, { author: "Feed Author", publishedAt: feedDate });
  await enrichSourceItem(fbItem, enrichOpts);
  const fbRun = await prisma.sourceItemEnrichmentRun.findFirstOrThrow({ where: { source_item_id: fbItem } });
  const fbMeta = fbRun.metadata_json as Record<string, string>;
  check("E1.1", "页面缺时间 → 回落 Feed 且标记 FEED",
    fbMeta.publishedAtSource === "FEED" && fbRun.page_published_at?.toISOString() === feedDate.toISOString(),
    `${fbMeta.publishedAtSource} ${fbRun.page_published_at?.toISOString()}`);
  check("E1.2", "页面缺作者 → 回落 Feed 且标记 FEED",
    fbMeta.authorSource === "FEED" && fbRun.author === "Feed Author", `${fbMeta.authorSource} ${fbRun.author}`);
  check("E1.3", "**不得**把 Feed 日期伪装成页面声明", fbMeta.publishedAtSource !== "META" && fbMeta.publishedAtSource !== "JSON_LD");
  const fbSnapshot = await prisma.sourceItem.findUniqueOrThrow({ where: { id: fbItem } });
  check("E1.4", "回落不修改 SourceItem 原始快照",
    fbSnapshot.author === "Feed Author" && fbSnapshot.raw_excerpt === "ORIGINAL_SNAPSHOT" && fbSnapshot.status === "link_only");

  const noneItem = await makeItem(bSrc, `${ORIGIN}/page-nometa`, { author: null, publishedAt: null });
  await enrichSourceItem(noneItem, enrichOpts);
  const noneRun = await prisma.sourceItemEnrichmentRun.findFirstOrThrow({ where: { source_item_id: noneItem } });
  const noneMeta = noneRun.metadata_json as Record<string, string>;
  check("E2.1", "都没有作者时保留 null", noneRun.author === null, `${noneRun.author}`);
  check("E2.2", "**不得**用 publisher 顶替作者", noneRun.author !== MARKER && noneMeta.authorSource === "NONE");

  // ── F. 跨域跳转与发布者身份 ──────────────────────────────────────────
  section("F  跨域跳转与发布者身份");
  const xItem = await makeItem(bSrc, `${ORIGIN}/cross`);
  await enrichSourceItem(xItem, enrichOpts);
  const xRun = await prisma.sourceItemEnrichmentRun.findFirstOrThrow({ where: { source_item_id: xItem } });
  const xMeta = xRun.metadata_json as Record<string, string>;
  check("F1.1", "记录 requestedHost / finalHost",
    xMeta.requestedHost === "integrity.example" && xMeta.finalHost === "other.example",
    `${xMeta.requestedHost} → ${xMeta.finalHost}`);
  check("F1.2", "跨域跳转被标记", xMeta.crossDomainRedirect === "true", xMeta.crossDomainRedirect);
  check("F2.1", "publisher 身份仍来自 ContentSource，未被 final host 覆盖",
    xMeta.sourcePublisher === MARKER, xMeta.sourcePublisher);
  const xSource = await prisma.contentSource.findUniqueOrThrow({ where: { id: bSrc } });
  check("F2.2", "ContentSource.publisher / tier 未被改写",
    xSource.publisher === MARKER, xSource.publisher);
  check("F3.1", "canonical host 差异只记录不动作", "canonicalHostDiffers" in xMeta);
  check("F3.2", "safeHost 对垃圾输入返回 null", safeHost("not a url") === null && safeHost(null) === null);

  // ── G. 派生字段幂等 ─────────────────────────────────────────────────
  section("G  派生字段幂等");
  const gChain = [{ hop: 0 }, { hop: 1 }];
  check("G1.1", "重算两次结果相同", redirectCountOf(gChain) === redirectCountOf(gChain));
  check("G1.2", "对已修正的值再算一次不变", redirectCountOf([{ hop: 0 }]) === 0);
  const gQuality = gradeContent(cItemRun.visible_text_length ?? 0);
  check("G1.3", "质量分级对同一输入恒定", gQuality === gradeContent(cItemRun.visible_text_length ?? 0));
  check("G2.1", "完整性判定为纯函数（同输入同输出）",
    JSON.stringify(assessFeedCompleteness({ httpStatus: 200, truncated: false, bytesRead: 100, maxBytes: 1000, integrity: null, body: SMALL_RSS, itemsParsed: 3 })) ===
    JSON.stringify(assessFeedCompleteness({ httpStatus: 200, truncated: false, bytesRead: 100, maxBytes: 1000, integrity: null, body: SMALL_RSS, itemsParsed: 3 })));

  // ── H. 不变量 ───────────────────────────────────────────────────────
  section("H  不变量");
  const resourceAfter = await prisma.resourceContent.count();
  check("H1.1", "ResourceContent 未变化", resourceAfter === resourceBefore, `${resourceBefore} → ${resourceAfter}`);
  const snap = await prisma.sourceItem.findUniqueOrThrow({ where: { id: cItem } });
  check("H2.1", "SourceItem 原始快照未被改写",
    snap.raw_excerpt === "ORIGINAL_SNAPSHOT" && snap.status === "link_only" && snap.raw_content === null);
  const hosts = new Set(state.requests.map((r) => r.split(" ")[1].split("/")[0]));
  check("H3.1", "全程只访问 fixture 主机",
    [...hosts].every((h) => h.endsWith(".example")), [...hosts].join(", "));

  const purgedAfter = await purge();
  const residue = await prisma.contentSource.count({ where: { publisher: MARKER } });
  const itemsAfter = await prisma.sourceItem.count();
  console.log(`\n收尾：清理 ${purgedAfter} 个测试源，残留 ${residue} 个 ${residue === 0 ? "✅" : "❌"}`);
  console.log(`SourceItem ${itemsBefore} → ${itemsAfter} ${itemsBefore === itemsAfter ? "✅" : "❌"}`);

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
    await purge();
  } finally {
    await prisma.$disconnect();
  }
  process.exit(1);
});
