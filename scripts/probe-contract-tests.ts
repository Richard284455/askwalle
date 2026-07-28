/**
 * Reachability Probe 判定契约 —— 测试矩阵。
 *
 *   npm run test:probe
 *
 * 全部走**内存 fixture transport**：不起 HTTP 服务、不建 TCP 连接、不访问任何
 * 真实站点、不连数据库、不调 AI。
 *
 * 重要：测试跑的是**完整的生产 SSRF 校验** —— resolver 返回真实公网地址，
 * assertSafeUrl 按生产规则一字不改地跑一遍，transport 才把请求映射到 fixture。
 * 不存在任何「放行私网」的开关。
 */
import { createMockTransport, MOCK_ORIGIN, MockControl } from "./probe-mock-transport";
import { probeReachability } from "../src/lib/website/probe/reachability-probe";
import { clearRobotsCache } from "../src/lib/website/probe/robots";
import { assertSafeUrl, isBlockedAddress } from "../src/lib/website/probe/ssrf";
import { extractText } from "../src/lib/website/probe/text-blocks";
import { sameRegistrableDomain } from "../src/lib/website/probe/registrable-domain";
import { applyRound, INITIAL_STATE, replay, DebounceState } from "../src/lib/website/probe/classifier";
import {
  PROBE_VERSION,
  ProbeOutcome,
  countsTowardBreaker,
  isContentCheckDue,
} from "../src/lib/website/probe/types";

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

// 真实公网地址（不能用 203.0.113.x / 192.0.2.x / 198.51.100.x —— 文档保留段本就在禁止列表里）
const PUBLIC_IP = "93.184.216.34";
const PUBLIC_IP_2 = "8.8.8.8";

async function probeUrl(mock: MockControl, path: string, extra: Record<string, unknown> = {}) {
  clearRobotsCache();
  return probeReachability({
    url: `${MOCK_ORIGIN}${path}`,
    resolve: mock.resolve,
    transport: mock.transport,
    lookupNs: async () => {
      throw new Error("ns unavailable");
    },
    ...extra,
  });
}

// ---------------------------------------------------------------------------

async function stateMachineTests(mock: MockControl) {
  console.log("\n8.1 状态机与网络层\n");

  const t01 = await probeUrl(mock, "/ok");
  check("T01", "HEAD 200 正常", t01.outcome === "ok", t01.outcome);

  mock.reset();
  const t02 = await probeUrl(mock, "/head-405");
  check("T02", "HEAD 405 → GET 200", t02.outcome === "ok", t02.outcome);
  check("T02b", "确实做了 GET 复核", mock.log.some((l) => l.method === "GET" && l.path === "/head-405"));

  const t03 = await probeUrl(mock, "/head-403");
  check("T03", "HEAD 403 → GET 200 不判 blocked", t03.outcome === "ok", t03.outcome);

  const t04 = await probeUrl(mock, "/head-404");
  check("T04", "HEAD 404 → GET 200 不判死链", t04.outcome === "ok", t04.outcome);

  const t05 = await probeUrl(mock, "/head-tiny");
  check("T05", "HEAD 200 但 Content-Length<512 → GET 复核", t05.outcome === "ok", t05.outcome);

  // ── D1：DNS 失败必须与 unsafe_target 彻底分开 ─────────────────────────
  // v3 把解析失败折进安全通道，43 个 NXDOMAIN 域名判成 unsafe_target →
  // unverifiable，而 unverifiable 永不计入 dead 消抖，真死链一条都抓不到。
  const dnsFail = (code: string) =>
    probeReachability({
      url: "https://does-not-exist.example/",
      resolve: async () => {
        throw Object.assign(new Error(code), { code });
      },
      transport: mock.transport,
    });

  const t06 = await dnsFail("ENOTFOUND");
  check("T06", "NXDOMAIN → dns（不是 unsafe_target）",
    t06.outcome === "dns" && t06.unsafeReason === null, `${t06.outcome}/${t06.unsafeReason}`);
  check("T06b", "  └ error_family=network，计入消抖",
    t06.errorFamily === "network", String(t06.errorFamily));

  const t06c = await dnsFail("EAI_AGAIN");
  check("T06c", "EAI_AGAIN（临时解析失败）→ dns",
    t06c.outcome === "dns" && t06c.unsafeReason === null, `${t06c.outcome}/${t06c.unsafeReason}`);

  const t06d = await probeReachability({
    url: "https://empty-answer.example/",
    resolve: async () => [],
    transport: mock.transport,
  });
  check("T06d", "解析结果为空 → dns",
    t06d.outcome === "dns" && t06d.unsafeReason === null, `${t06d.outcome}/${t06d.unsafeReason}`);

  const t06e = await probeReachability({
    url: "https://rebind.example/",
    resolve: async () => ["10.0.0.5"],
    transport: mock.transport,
  });
  check("T06e", "解析成功但落在私网 → 仍是 unsafe_target",
    t06e.outcome === "unsafe_target" && t06e.unsafeReason === "private_ip",
    `${t06e.outcome}/${t06e.unsafeReason}`);

  const t06f = await probeReachability({
    url: "https://metadata-rebind.example/",
    resolve: async () => ["169.254.169.254"],
    transport: mock.transport,
  });
  check("T06f", "解析到元数据端点 → 仍是 unsafe_target",
    t06f.outcome === "unsafe_target" && t06f.unsafeReason === "metadata_endpoint",
    `${t06f.outcome}/${t06f.unsafeReason}`);

  // 安全告警队列只认 unsafe_target；DNS 失败混进来会把告警淹掉
  check("T06g", "DNS 失败不进安全告警队列",
    [t06, t06c, t06d].every((r) => r.outcome !== "unsafe_target" && r.unsafeReason === null));
  check("T06h", "  └ 真安全拒绝仍在队列里",
    [t06e, t06f].every((r) => r.outcome === "unsafe_target" && r.unsafeReason !== null));

  // ── D3：截断压缩流必须仍能提取正文 ───────────────────────────────────
  // v3 里 gunzipSync 对不完整的流抛 Z_BUF_ERROR，直接判 undecodable ——
  // Grammarly / Cursor / ElevenLabs 等 37 个重点工具的内容分类整体空转。
  const t07 = await probeUrl(mock, "/gzip-big", { forceContentCheck: true });
  check("T07", "截断的 gzip 仍能解出正文",
    t07.outcome === "ok" && t07.contentVerdict !== "undecodable" && t07.evidence.visibleTextLen > 500,
    `${t07.outcome}/${t07.contentVerdict}/${t07.evidence.visibleTextLen}字`);
  check("T07b", "  └ 标题解析正确",
    (t07.evidence.titleExcerpt ?? "").includes("Bigwriter"), String(t07.evidence.titleExcerpt));
  check("T07c", "  └ truncated 仍如实记录在证据里",
    t07.evidence.truncated === true, String(t07.evidence.truncated));

  const t07d = await probeUrl(mock, "/deflate-big", { forceContentCheck: true });
  check("T07d", "截断的 deflate 仍能解出正文",
    t07d.outcome === "ok" && t07d.contentVerdict !== "undecodable" && t07d.evidence.visibleTextLen > 500,
    `${t07d.outcome}/${t07d.contentVerdict}/${t07d.evidence.visibleTextLen}字`);

  const t07e = await probeUrl(mock, "/deflate-raw-big", { forceContentCheck: true });
  check("T07e", "裸 deflate（无 zlib 头）同样能解",
    t07e.outcome === "ok" && t07e.evidence.visibleTextLen > 500,
    `${t07e.outcome}/${t07e.evidence.visibleTextLen}字`);

  const t07f = await probeUrl(mock, "/gzip-bomb", { forceContentCheck: true });
  check("T07f", "解压后超 1MB → 安全截断，不抛异常",
    t07f.outcome === "ok" && t07f.evidence.visibleTextLen <= 1_048_576,
    `${t07f.outcome}/${t07f.evidence.visibleTextLen}字`);

  const t07g = await probeUrl(mock, "/gzip-corrupt", { forceContentCheck: true });
  check("T07g", "损坏的压缩流 → undecodable，退回状态码结论且不判死",
    t07g.outcome === "ok" && t07g.contentVerdict === "undecodable",
    `${t07g.outcome}/${t07g.contentVerdict}`);

  const t07h = await probeUrl(mock, "/gzip-soft404", { forceContentCheck: true });
  check("T07h", "压缩过的软 404，解压修好后仍能判 soft_404",
    t07h.outcome === "soft_404", t07h.outcome);

  const t09 = await probeUrl(mock, "/500");
  check("T09", "500 → http_5xx", t09.outcome === "http_5xx", t09.outcome);

  const t10 = await probeUrl(mock, "/404");
  check("T10", "404 → http_404", t10.outcome === "http_404", t10.outcome);

  const t11 = await probeUrl(mock, "/410");
  check("T11", "410 → http_410", t11.outcome === "http_410", t11.outcome);

  const t12 = await probeUrl(mock, "/redir/0");
  check("T12", "超过 5 跳 → timeout/redirect_loop",
    t12.outcome === "timeout" && t12.errorKind === "redirect_loop", `${t12.outcome}/${t12.errorKind}`);

  const t13 = await probeUrl(mock, "/loop-a");
  check("T13", "循环重定向 → timeout/redirect_loop",
    t13.outcome === "timeout" && t13.errorKind === "redirect_loop", `${t13.outcome}/${t13.errorKind}`);

  const t14 = await probeUrl(mock, "/pdf");
  check("T14", "PDF 200 → ok（内容检查跳过，记 non_html）",
    t14.outcome === "ok" && t14.contentVerdict === "non_html", `${t14.outcome}/${t14.contentVerdict}`);
  check("T14b", "  └ non_html 仍算完成内容检查（否则每轮白 GET）", t14.contentChecked);

  const t15 = await probeUrl(mock, "/huge");
  check("T15", "服务器忽略 Range → truncated 且仍 ok",
    t15.outcome === "ok" && t15.evidence.truncated, `${t15.outcome} truncated=${t15.evidence.truncated}`);
}

async function contentCheckTests(mock: MockControl) {
  console.log("\n8.1b 深度内容检查（v2 新增）\n");

  // ★ 核心回归：正常体积（>512B）的软 404
  const big = await probeUrl(mock, "/big-soft404", { forceContentCheck: false });
  check("V01", "未到期时正常体积软 404 被 HEAD 短路掩盖（v1 的老问题）",
    big.outcome === "ok" && big.evidence.methodSequence.join() === "HEAD",
    `${big.outcome} ${big.evidence.methodSequence.join(",")}`);

  const bigForced = await probeUrl(mock, "/big-soft404", { forceContentCheck: true });
  check("V02", "首次/到期强制 GET → 命中 soft_404",
    bigForced.outcome === "soft_404" && bigForced.evidence.methodSequence.join() === "HEAD,GET",
    `${bigForced.outcome} ${bigForced.evidence.methodSequence.join(",")}`);
  check("V03", "  └ 标记 contentChecked", bigForced.contentChecked);

  const bigParked = await probeUrl(mock, "/big-parked-excluded", { forceContentCheck: true });
  check("V04", "正常体积页面含 parked 关键词 → GET 后被 E1 排除，判 ok",
    bigParked.outcome === "ok" && bigParked.evidence.exclusionsHit.includes("E1"),
    `${bigParked.outcome} exclusions=[${bigParked.evidence.exclusionsHit.join(",")}]`);

  const okForced = await probeUrl(mock, "/ok", { forceContentCheck: true });
  check("V05", "强制内容检查下正常页仍判 ok 且完成正文分类",
    okForced.outcome === "ok" && okForced.contentChecked &&
      okForced.evidence.methodSequence.join() === "HEAD,GET",
    `${okForced.outcome} checked=${okForced.contentChecked}`);

  // 排期纯函数
  const now = new Date("2026-07-27T00:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  check("V06", "从未检查过 → 必须 GET", isContentCheckDue(null, "standard", now));
  check("V07", "featured_candidate 6 天 → 不强制", !isContentCheckDue(daysAgo(6), "featured_candidate", now));
  check("V08", "featured_candidate 7 天 → 强制", isContentCheckDue(daysAgo(7), "featured_candidate", now));
  check("V09", "featured 8 天 → 强制", isContentCheckDue(daysAgo(8), "featured", now));
  check("V10", "standard 29 天 → 不强制", !isContentCheckDue(daysAgo(29), "standard", now));
  check("V11", "standard 31 天 → 强制", isContentCheckDue(daysAgo(31), "standard", now));
  check("V12", "longtail 89 天 → 不强制（HEAD 可短路）", !isContentCheckDue(daysAgo(89), "longtail", now));
  check("V13", "longtail 91 天 → 强制 GET", isContentCheckDue(daysAgo(91), "longtail", now));
  check("V14", "未知 tier 回落 standard", isContentCheckDue(daysAgo(31), "weird", now));

  // 未完成正文分类的轮次不得推进排期
  const blocked = await probeUrl(mock, "/cf-challenge", { forceContentCheck: true });
  check("V15", "blocked 轮次不算完成内容检查",
    blocked.outcome === "blocked" && !blocked.contentChecked, `${blocked.outcome}/${blocked.contentChecked}`);
  const err = await probeUrl(mock, "/500", { forceContentCheck: true });
  check("V16", "http_5xx 轮次不算完成内容检查",
    err.outcome === "http_5xx" && !err.contentChecked, `${err.outcome}/${err.contentChecked}`);
}

async function soft404Tests(mock: MockControl) {
  console.log("\n8.2 soft_404\n");

  const t16 = await probeUrl(mock, "/soft404-title");
  check("T16", "title=404 且正文短", t16.outcome === "soft_404", t16.outcome);

  const t17 = await probeUrl(mock, "/soft404-h1");
  check("T17", "h1=页面不存在", t17.outcome === "soft_404", t17.outcome);

  const t18 = await probeUrl(mock, "/soft404-body");
  check("T18", "正文块含中文 404 语", t18.outcome === "soft_404", t18.outcome);

  const t19 = await probeUrl(mock, "/soft404-long", { forceContentCheck: true });
  check("T19", "title 含 404 但正文很长 → ok", t19.outcome === "ok", t19.outcome);

  const t21 = await probeUrl(mock, "/spa");
  check("T21", "SPA 壳 → ok / low / spa_shell",
    t21.outcome === "ok" && t21.confidence === "low" && t21.contentVerdict === "spa_shell",
    `${t21.outcome}/${t21.confidence}/${t21.contentVerdict}`);

  const t22 = await probeUrl(mock, "/notfound-in-script", { forceContentCheck: true });
  check("T22", "<script> 内的 not found 不算", t22.outcome === "ok", t22.outcome);

  const t23 = await probeUrl(mock, "/notfound-in-comment", { forceContentCheck: true });
  check("T23", "HTML 注释内的不算", t23.outcome === "ok", t23.outcome);

  const t24 = await probeUrl(mock, "/notfound-in-alt", { forceContentCheck: true });
  check("T24", "alt 属性内的不算", t24.outcome === "ok", t24.outcome);
}

async function parkedTests(mock: MockControl) {
  console.log("\n8.3 parked\n");

  const t25 = await probeUrl(mock, "/parked-en");
  check("T25", "英文 for sale + 结构条件 → parked/weak",
    t25.outcome === "parked" && t25.evidenceStrength === "weak", `${t25.outcome}/${t25.evidenceStrength}`);

  const t26 = await probeUrl(mock, "/parked-cn");
  check("T26", "中文该域名待售 → parked/weak",
    t26.outcome === "parked" && t26.evidenceStrength === "weak", `${t26.outcome}/${t26.evidenceStrength}`);

  const t31 = await probeUrl(mock, "/parked-manylinks");
  check("T31", "内链 >5 → ok（E2 否决）",
    t31.outcome === "ok" && t31.evidence.exclusionsHit.includes("E2"),
    `${t31.outcome} ${t31.evidence.exclusionsHit.join(",")}`);

  const t32 = await probeUrl(mock, "/parked-en", { isDomainCategory: true });
  check("T32", "域名类目工具 → ok（E5 否决）",
    t32.outcome === "ok" && t32.evidence.exclusionsHit.includes("E5"),
    `${t32.outcome} ${t32.evidence.exclusionsHit.join(",")}`);

  const t33 = await probeUrl(mock, "/coming-soon");
  check("T33", "仅 coming soon（L3）→ ok", t33.outcome === "ok", t33.outcome);

  const t34 = await probeUrl(mock, "/parked-brand", { title: "Acme Writer" });
  check("T34", "品牌名仍在 title → ok（E3 否决）",
    t34.outcome === "ok" && t34.evidence.exclusionsHit.includes("E3"),
    `${t34.outcome} ${t34.evidence.exclusionsHit.join(",")}`);

  const t29 = await probeUrl(mock, "/redir-cross-brand", { forceContentCheck: true });
  check("T29", "跨域跳到正常新站 → ok + domain_migrated，不判 parked",
    t29.outcome === "ok" && t29.domainMigrated, `${t29.outcome} migrated=${t29.domainMigrated}`);
}

async function antiConcatTests(mock: MockControl) {
  console.log("\n8.4 反拼接边界（★ 8 词 + 8 词 ≠ 16 词的同源问题）\n");

  const t35 = await probeUrl(mock, "/split-buy-domain");
  check("T35", "<div>Buy</div><div>this domain now</div> 不得拼成 buy this domain",
    t35.outcome !== "parked", t35.outcome);

  const t36 = await probeUrl(mock, "/split-not-found");
  check("T36", "<li>Not</li><li>found here</li> 不得拼成 not found",
    t36.outcome !== "soft_404", t36.outcome);

  const t37 = await probeUrl(mock, "/split-cn");
  check("T37", "中文跨块「此域|名待售」不得拼接", t37.outcome !== "parked", t37.outcome);

  const t38 = await probeUrl(mock, "/inblock-buy-domain");
  check("T38", "块内完整命中仍要拦（确认没矫枉过正）", t38.outcome === "parked", t38.outcome);

  const t39 = await probeUrl(mock, "/mixed-split-and-inblock");
  const spanning = t39.evidence.matchedSignatures.filter((s) => s.matchedText.includes("\x00"));
  check("T39", "跨块与块内并存时只记块内命中",
    t39.outcome === "parked" && spanning.length === 0, `${t39.outcome} 跨界命中 ${spanning.length}`);

  const blocks = extractText("<div>Buy</div><div>this domain</div>").blocks;
  check("T39b", "分块器把两段分开",
    blocks.length === 2 && blocks[0] === "Buy" && blocks[1] === "this domain", JSON.stringify(blocks));
}

async function blockedDeferredTests(mock: MockControl) {
  console.log("\n8.5 blocked / deferred\n");

  const t40 = await probeUrl(mock, "/cf-challenge");
  check("T40", "Cloudflare challenge → blocked", t40.outcome === "blocked", t40.outcome);

  const t41 = await probeUrl(mock, "/verify-human");
  check("T41", "verify you are human → blocked", t41.outcome === "blocked", t41.outcome);

  const t42 = await probeUrl(mock, "/451");
  check("T42", "451 → blocked", t42.outcome === "blocked", t42.outcome);

  mock.setRobots("disallow");
  mock.reset();
  const t43 = await probeUrl(mock, "/robots-disallowed/page");
  const mainRequests = mock.log.filter((l) => l.path === "/robots-disallowed/page");
  check("T43", "robots Disallow → blocked 且零主请求",
    t43.outcome === "blocked" && mainRequests.length === 0,
    `${t43.outcome} 主请求 ${mainRequests.length}`);

  mock.setRobots("500");
  const t44 = await probeUrl(mock, "/ok");
  check("T44", "robots 500 → deferred（不当允许也不当失败）", t44.outcome === "deferred", t44.outcome);

  mock.setRobots("delay");
  const t45 = await probeUrl(mock, "/robots-delay/page");
  check("T45", "Crawl-delay 60s → deferred", t45.outcome === "deferred", t45.outcome);

  mock.setRobots("allow");

  const t46 = await probeUrl(mock, "/429");
  check("T46", "429 + Retry-After → deferred",
    t46.outcome === "deferred" && t46.retryAfterMs === 3600_000, `${t46.outcome} retry=${t46.retryAfterMs}`);

  const t47 = await probeUrl(mock, "/429-bare");
  check("T47", "429 无 Retry-After → deferred +6h",
    t47.outcome === "deferred" && t47.retryAfterMs === 6 * 3600_000, `${t47.outcome} retry=${t47.retryAfterMs}`);

  const t48 = await probeUrl(mock, "/503-retry");
  check("T48", "503 + Retry-After → deferred（下限钳到 1h）",
    t48.outcome === "deferred" && t48.retryAfterMs === 3600_000, `${t48.outcome} retry=${t48.retryAfterMs}`);

  const t49 = await probeUrl(mock, "/503-plain");
  check("T49", "503 无 Retry-After → http_5xx", t49.outcome === "http_5xx", t49.outcome);

  const t50 = (["blocked", "deferred", "unsafe_target", "unknown"] as ProbeOutcome[]).every(
    (o) => !countsTowardBreaker(o)
  );
  check("T50", "blocked/deferred/unsafe/unknown 均不计熔断", t50);
}

async function ssrfTests(mock: MockControl) {
  console.log("\n8.6 SSRF（全部走生产默认参数，代码里已无任何绕过开关）\n");

  const cases: [string, string, string][] = [
    ["T51", "file:///etc/passwd", "protocol_not_allowed"],
    ["T52", "http://127.0.0.1/", "private_ip"],
    ["T53", "http://10.1.2.3/", "private_ip"],
    ["T54", "http://169.254.169.254/", "metadata_endpoint"],
    ["T55", "http://100.100.100.200/", "metadata_endpoint"],
    ["T59", "http://[::ffff:127.0.0.1]/", "private_ip"],
    ["T60", "http://example.com:22/", "port_not_allowed"],
    ["T60c", "http://example.com:8080/", "port_not_allowed"],
    ["T61", "http://evil.com@127.0.0.1/", "userinfo_in_url"],
    ["T62", "http://foo.internal/", "hostname_not_allowed"],
    ["T62b", "http://localhost/", "hostname_not_allowed"],
  ];
  for (const [id, url, expected] of cases) {
    const verdict = await assertSafeUrl(url, async () => [PUBLIC_IP]);
    check(id, `${url} → ${expected}`,
      !verdict.safe && verdict.reason === expected, verdict.safe ? "safe!" : verdict.reason);
  }

  const t57 = await assertSafeUrl("http://multi.example.com/", async () => [PUBLIC_IP, "127.0.0.1"]);
  check("T57", "多 A 记录任一私网即拒",
    !t57.safe && t57.reason === "private_ip", t57.safe ? "safe!" : t57.reason);

  let calls = 0;
  const rebinding = async () => {
    calls++;
    return calls === 1 ? [PUBLIC_IP] : ["127.0.0.1"];
  };
  const t58 = await assertSafeUrl("http://rebind.example.com/", rebinding);
  check("T58", "rebinding：pinnedIp 固定为已校验的首解析地址",
    t58.safe && t58.pinnedIp === PUBLIC_IP, t58.safe ? t58.pinnedIp : t58.reason);
  check("T58b", "  └ 只解析一次，连接不会再解析第二遍", calls === 1, `resolve 调用 ${calls} 次`);

  const ranges = [
    "0.0.0.0", "10.255.255.255", "100.64.0.1", "127.0.0.1", "169.254.1.1",
    "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.168.1.1", "198.18.0.1",
    "224.0.0.1", "240.0.0.1", "255.255.255.255",
  ];
  check("T51b", "IPv4 禁止段全覆盖", ranges.every(isBlockedAddress),
    ranges.filter((r) => !isBlockedAddress(r)).join(","));

  const v6 = ["::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:10.0.0.1"];
  check("T59b", "IPv6 禁止段全覆盖", v6.every(isBlockedAddress),
    v6.filter((r) => !isBlockedAddress(r)).join(","));

  const publicOk = [PUBLIC_IP, PUBLIC_IP_2, "2606:4700::1"];
  check("T51c", "真实公网地址不被误拒", publicOk.every((ip) => !isBlockedAddress(ip)),
    publicOk.filter((ip) => isBlockedAddress(ip)).join(","));

  const docRanges = ["203.0.113.1", "192.0.2.1", "198.51.100.1"];
  check("T51d", "文档保留段仍被拒", docRanges.every(isBlockedAddress));

  // 逐跳重校验：跳到私网 / 元数据都必须中止
  const t56 = await probeUrl(mock, "/redir-private");
  check("T56", "重定向到私网 IP → unsafe_target",
    t56.outcome === "unsafe_target" && t56.unsafeReason === "private_ip",
    `${t56.outcome}/${t56.unsafeReason}`);

  const t56b = await probeUrl(mock, "/redir-metadata");
  check("T56b", "重定向到元数据端点 → unsafe_target",
    t56b.outcome === "unsafe_target" && t56b.unsafeReason === "metadata_endpoint",
    `${t56b.outcome}/${t56b.unsafeReason}`);
}

function debounceTests() {
  console.log("\n8.7 消抖与轮次\n");

  const day = (n: number) => new Date(Date.UTC(2026, 0, n, 4, 0, 0));
  const failRound = (kind: string, at: Date, outcome: ProbeOutcome = "timeout") => ({
    outcome, errorKind: kind, evidenceStrength: null, confidence: "high" as const,
    domainMigrated: false, finalUrl: null, probeVersion: PROBE_VERSION, at,
  });
  const okRound = (at: Date) => ({
    outcome: "ok" as ProbeOutcome, errorKind: null, evidenceStrength: null,
    confidence: "high" as const, domainMigrated: false, finalUrl: null,
    probeVersion: PROBE_VERSION, at,
  });

  let s: DebounceState = INITIAL_STATE;
  for (let i = 0; i < 3; i++) {
    const d = applyRound(s, failRound("timeout", day(1)));
    if (d.ok) s = d.next;
  }
  check("T64", "同日 3 次失败 → streak=1, distinct=1",
    s.consecutiveFails === 1 && s.distinctFailDates === 1,
    `streak=${s.consecutiveFails} distinct=${s.distinctFailDates}`);

  const r66 = replay([failRound("timeout", day(1)), failRound("timeout", day(8)), failRound("timeout", day(15))]);
  check("T66", "1/8/15 天各一次 timeout → dead",
    r66.state.reach === "dead" && r66.state.distinctFailDates === 3,
    `${r66.state.reach} distinct=${r66.state.distinctFailDates}`);

  const r67 = replay([failRound("timeout", day(1)), failRound("timeout", day(7)), failRound("timeout", day(14))]);
  check("T67", "跨度 13 天 → 不判 dead", r67.state.reach !== "dead", r67.state.reach);

  const r68 = replay([failRound("timeout", day(1)), failRound("timeout", day(2)), failRound("timeout", day(3))]);
  check("T68", "连续 3 天（跨度 2 天）→ 不判 dead", r68.state.reach !== "dead", r68.state.reach);

  const r69 = replay([failRound("timeout", day(1)), failRound("timeout", day(8)), failRound("http_404", day(15), "http_404")]);
  check("T69", "network → gone 族变更后重新计数",
    r69.state.consecutiveFails === 2 && r69.state.distinctFailDates === 1 && r69.state.reach !== "dead",
    `streak=${r69.state.consecutiveFails} distinct=${r69.state.distinctFailDates}`);

  const r70 = replay([failRound("timeout", day(1)), failRound("dns", day(8), "dns"), failRound("tls", day(15), "tls")]);
  check("T70", "timeout/dns/tls 同属 network → 累加至 dead",
    r70.state.reach === "dead" && r70.state.distinctFailDates === 3, r70.state.reach);

  const r71 = replay([failRound("http_404", day(1), "http_404"), failRound("http_404", day(20), "http_404")]);
  check("T71", "404 权重×2：streak=4 但 distinct=2 → 不判 dead",
    r71.state.consecutiveFails === 4 && r71.state.distinctFailDates === 2 && r71.state.reach !== "dead",
    `streak=${r71.state.consecutiveFails} distinct=${r71.state.distinctFailDates}`);

  const r72 = replay([
    failRound("timeout", day(1)), failRound("timeout", day(8)),
    failRound("timeout", day(15)), okRound(day(16)),
  ]);
  const lastFlags = r72.steps[3].ok ? r72.steps[3].changeFlags : [];
  check("T72", "dead 后一次 ok → 清零 + recovered",
    r72.state.reach === "ok" && r72.state.consecutiveFails === 0 && lastFlags.includes("recovered"),
    `${r72.state.reach} flags=${lastFlags.join(",")}`);

  const deadState = replay([failRound("timeout", day(1)), failRound("timeout", day(8)), failRound("timeout", day(15))]).state;
  const afterBlocked = applyRound(deadState, {
    outcome: "blocked", errorKind: "blocked", evidenceStrength: null, confidence: "high",
    domainMigrated: false, finalUrl: null, probeVersion: PROBE_VERSION, at: day(20),
  });
  check("T74", "已 dead 遇 blocked → 保持 dead",
    afterBlocked.ok && afterBlocked.next.reach === "dead", afterBlocked.ok ? afterBlocked.next.reach : "?");

  const afterBlockedFresh = applyRound(INITIAL_STATE, {
    outcome: "blocked", errorKind: "blocked", evidenceStrength: null, confidence: "high",
    domainMigrated: false, finalUrl: null, probeVersion: PROBE_VERSION, at: day(1),
  });
  check("T74b", "非 dead 遇 blocked → unverifiable",
    afterBlockedFresh.ok && afterBlockedFresh.next.reach === "unverifiable",
    afterBlockedFresh.ok ? afterBlockedFresh.next.reach : "?");

  const t75 = applyRound(INITIAL_STATE, {
    outcome: "parked", errorKind: "parked", evidenceStrength: "strong", confidence: "high",
    domainMigrated: false, finalUrl: null, probeVersion: PROBE_VERSION, at: day(1),
  });
  check("T75", "parked 强证据 → 单次 dead", t75.ok && t75.next.reach === "dead", t75.ok ? t75.next.reach : "?");

  const t75b = applyRound(INITIAL_STATE, {
    outcome: "parked", errorKind: "parked", evidenceStrength: "weak", confidence: "high",
    domainMigrated: false, finalUrl: null, probeVersion: PROBE_VERSION, at: day(1),
  });
  check("T75b", "parked 弱证据 → 走消抖", t75b.ok && t75b.next.reach !== "dead", t75b.ok ? t75b.next.reach : "?");

  const unsafeRound = (at: Date) => ({
    outcome: "unsafe_target" as ProbeOutcome, errorKind: "unsafe_target", evidenceStrength: null,
    confidence: "high" as const, domainMigrated: false, finalUrl: null, probeVersion: PROBE_VERSION, at,
  });
  const r63 = replay([unsafeRound(day(1)), unsafeRound(day(20)), unsafeRound(day(40))]);
  check("T63", "unsafe_target 三轮 → 始终 unverifiable，绝不 dead",
    r63.state.reach === "unverifiable" && r63.state.needsManualCheck,
    `${r63.state.reach} manual=${r63.state.needsManualCheck}`);

  const beforeDeferred = { ...INITIAL_STATE, consecutiveFails: 2, distinctFailDates: 2 };
  const afterDeferred = applyRound(beforeDeferred, {
    outcome: "deferred", errorKind: null, evidenceStrength: null, confidence: "high",
    domainMigrated: false, finalUrl: null, probeVersion: PROBE_VERSION, at: day(9),
  });
  check("T46b", "deferred 不改消抖字段",
    afterDeferred.ok && afterDeferred.next.consecutiveFails === 2 && afterDeferred.next.distinctFailDates === 2,
    afterDeferred.ok ? `streak=${afterDeferred.next.consecutiveFails}` : "?");

  // ★ 旧版本证据不得被当前判定层静默接受（A8 那 20 条就是 v2 的）
  const v1Round = { ...okRound(day(1)), probeVersion: PROBE_VERSION - 1 };
  const mismatch = applyRound(INITIAL_STATE, v1Round);
  check("T79", `v${PROBE_VERSION - 1} 证据喂给 v${PROBE_VERSION} → version_mismatch，不静默混算`,
    !mismatch.ok && mismatch.reason === "version_mismatch",
    mismatch.ok ? "被静默接受了！" : `expected=${mismatch.expected} got=${mismatch.got}`);

  const mixedReplay = replay([okRound(day(1)), v1Round, failRound("timeout", day(3))]);
  check("T79b", "replay 计数版本不匹配轮次并跳过",
    mixedReplay.versionMismatches === 1, String(mixedReplay.versionMismatches));

  // D1/D2/D3 改了 DNS、内容与内部错误三类判定口径，v3 基线不能与 v4 混算。
  // 这里把版本号写死，避免将来再升版本时这条断言跟着漂走。
  check("T79c", "当前 PROBE_VERSION 为 4", PROBE_VERSION === 4, String(PROBE_VERSION));
  for (const old of [1, 2, 3]) {
    const r = applyRound(INITIAL_STATE, { ...okRound(day(1)), probeVersion: old });
    check(`T79d.v${old}`, `  └ v${old} 证据 → version_mismatch`,
      !r.ok && r.reason === "version_mismatch", r.ok ? "被接受了！" : "version_mismatch");
  }

  const migrated = applyRound(INITIAL_STATE, {
    outcome: "ok", errorKind: null, evidenceStrength: null, confidence: "high",
    domainMigrated: true, finalUrl: "https://new-brand.com/", probeVersion: PROBE_VERSION, at: day(1),
  });
  check("T29b", "domain_migrated → 标 flag + needs_manual_check，不自动改 URL",
    migrated.ok && migrated.changeFlags.includes("domain_migrated") &&
      migrated.next.needsManualCheck && migrated.next.reach === "ok",
    migrated.ok ? migrated.changeFlags.join(",") : "?");
}

function pslTests() {
  console.log("\n8.8 registrable domain（PSL）\n");
  check("PSL1", "www ↔ apex 同域", sameRegistrableDomain("www.acme.com", "acme.com"));
  check("PSL2", "子域同域", sameRegistrableDomain("a.b.acme.com", "acme.com"));
  check("PSL3", "co.uk 两个不同站不算同域", !sameRegistrableDomain("foo.co.uk", "bar.co.uk"));
  check("PSL4", "com.cn 正确解析", !sameRegistrableDomain("a.com.cn", "b.com.cn"));
  check("PSL5", "同一 co.uk 站算同域", sameRegistrableDomain("www.foo.co.uk", "foo.co.uk"));
  check("PSL6", "跨域识别", !sameRegistrableDomain("acme.com", "evil.com"));
}

async function main() {
  const mock = createMockTransport();
  console.log(`fixture transport（内存，无网络）· PROBE_VERSION=${PROBE_VERSION}`);

  await stateMachineTests(mock);
  await contentCheckTests(mock);
  await soft404Tests(mock);
  await parkedTests(mock);
  await antiConcatTests(mock);
  await blockedDeferredTests(mock);
  await ssrfTests(mock);
  debounceTests();
  pslTests();

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) {
    console.log("\n失败用例:");
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
