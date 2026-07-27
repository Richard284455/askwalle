/**
 * Reachability Probe 判定契约 v1.0 —— 测试矩阵 T01–T80。
 *
 *   npx ts-node --project tsconfig.script.json scripts/probe-contract-tests.ts
 *
 * 全部走本地 mock，**不访问任何真实工具站点**，不连数据库，不调 AI。
 */
import { startMockServer, MockServer } from "./probe-mock-server";
import { probeReachability } from "../src/lib/website/probe/reachability-probe";
import { clearRobotsCache } from "../src/lib/website/probe/robots";
import { assertSafeUrl, isBlockedAddress } from "../src/lib/website/probe/ssrf";
import { extractText } from "../src/lib/website/probe/text-blocks";
import { sameRegistrableDomain } from "../src/lib/website/probe/registrable-domain";
import { applyRound, INITIAL_STATE, replay, DebounceState } from "../src/lib/website/probe/classifier";
import { PROBE_VERSION, ProbeOutcome, countsTowardBreaker } from "../src/lib/website/probe/types";

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

// 本地 mock 跑在 127.0.0.1 上，SSRF 会（正确地）拒绝私网地址。
// 探针类用例显式传 safety.allowPrivateAddresses —— 这是**仅测试**的注入点，
// 生产调用方一律不传。T52 专门断言默认参数下 127.0.0.1 仍被拒。
const testResolve = async () => ["127.0.0.1"];
const TEST_SAFETY = { allowPrivateAddresses: true };

// 「公网」测试地址：不能用 203.0.113.x / 192.0.2.x / 198.51.100.x —— 那些是
// 文档保留段，本来就在禁止列表里，拿来当公网会让 SSRF 用例自相矛盾。
const PUBLIC_IP = "93.184.216.34";
const PUBLIC_IP_2 = "8.8.8.8";

async function probeUrl(mock: MockServer, path: string, extra: Record<string, unknown> = {}) {
  clearRobotsCache();
  return probeReachability({
    url: `${mock.origin}${path}`,
    resolve: testResolve,
    safety: TEST_SAFETY,
    lookupNs: async () => {
      throw new Error("ns unavailable");
    },
    ...extra,
  });
}

// ---------------------------------------------------------------------------

async function stateMachineTests(mock: MockServer) {
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

  const t06 = await probeReachability({
    url: "http://does-not-exist.invalid/",
    resolve: async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    },
  });
  // 解析失败在 SSRF 阶段就会被判 dns_error → unsafe_target；
  // 契约上这属于「我方无法确认」，不该计入死链消抖
  check("T06", "DNS 解析失败不产生生命周期失败",
    t06.outcome === "unsafe_target" || t06.outcome === "dns", t06.outcome);

  const t09 = await probeUrl(mock, "/500");
  check("T09", "500 → http_5xx", t09.outcome === "http_5xx", t09.outcome);

  const t10 = await probeUrl(mock, "/404");
  check("T10", "404 → http_404", t10.outcome === "http_404", t10.outcome);

  const t11 = await probeUrl(mock, "/410");
  check("T11", "410 → http_410", t11.outcome === "http_410", t11.outcome);

  const t12 = await probeUrl(mock, "/redir/0");
  check(
    "T12",
    "超过 5 跳 → timeout/redirect_loop",
    t12.outcome === "timeout" && t12.errorKind === "redirect_loop",
    `${t12.outcome}/${t12.errorKind}`
  );

  const t13 = await probeUrl(mock, "/loop-a");
  check(
    "T13",
    "循环重定向 → timeout/redirect_loop",
    t13.outcome === "timeout" && t13.errorKind === "redirect_loop",
    `${t13.outcome}/${t13.errorKind}`
  );

  const t14 = await probeUrl(mock, "/pdf");
  check(
    "T14",
    "PDF 200 → ok（内容检查跳过）",
    t14.outcome === "ok" && t14.contentVerdict === "non_html",
    `${t14.outcome}/${t14.contentVerdict}`
  );

  const t15 = await probeUrl(mock, "/huge");
  check(
    "T15",
    "服务器忽略 Range → truncated 且仍 ok",
    t15.outcome === "ok" && t15.evidence.truncated,
    `${t15.outcome} truncated=${t15.evidence.truncated}`
  );
}

async function soft404Tests(mock: MockServer) {
  console.log("\n8.2 soft_404\n");

  const t16 = await probeUrl(mock, "/soft404-title");
  check("T16", "title=404 且正文短", t16.outcome === "soft_404", t16.outcome);

  const t17 = await probeUrl(mock, "/soft404-h1");
  check("T17", "h1=页面不存在", t17.outcome === "soft_404", t17.outcome);

  const t18 = await probeUrl(mock, "/soft404-body");
  check("T18", "正文块含中文 404 语", t18.outcome === "soft_404", t18.outcome);

  const t19 = await probeUrl(mock, "/soft404-long");
  check("T19", "title 含 404 但正文很长 → ok", t19.outcome === "ok", t19.outcome);

  const t21 = await probeUrl(mock, "/spa");
  check(
    "T21",
    "SPA 壳 → ok / low / spa_shell",
    t21.outcome === "ok" && t21.confidence === "low" && t21.contentVerdict === "spa_shell",
    `${t21.outcome}/${t21.confidence}/${t21.contentVerdict}`
  );

  const t22 = await probeUrl(mock, "/notfound-in-script");
  check("T22", "<script> 内的 not found 不算", t22.outcome === "ok", t22.outcome);

  const t23 = await probeUrl(mock, "/notfound-in-comment");
  check("T23", "HTML 注释内的不算", t23.outcome === "ok", t23.outcome);

  const t24 = await probeUrl(mock, "/notfound-in-alt");
  check("T24", "alt 属性内的不算", t24.outcome === "ok", t24.outcome);
}

async function parkedTests(mock: MockServer) {
  console.log("\n8.3 parked\n");

  const t25 = await probeUrl(mock, "/parked-en");
  check(
    "T25",
    "英文 for sale + 结构条件 → parked/weak",
    t25.outcome === "parked" && t25.evidenceStrength === "weak",
    `${t25.outcome}/${t25.evidenceStrength}`
  );

  const t26 = await probeUrl(mock, "/parked-cn");
  check(
    "T26",
    "中文该域名待售 → parked/weak",
    t26.outcome === "parked" && t26.evidenceStrength === "weak",
    `${t26.outcome}/${t26.evidenceStrength}`
  );

  // 内容丰富的页面 Content-Length > 512，HEAD 就短路了，根本走不到内容分类。
  // 结果仍然正确（ok），只是 E1 没机会记录 —— 这是契约 §1.1 的既定代价。
  const t30 = await probeUrl(mock, "/parked-long");
  check("T30", "正文 >1500 的页面 HEAD 短路 → ok（不取正文）", t30.outcome === "ok", t30.outcome);
  check(
    "T30a",
    "  └ 确实没走 GET（methodSequence 只有 HEAD）",
    t30.evidence.methodSequence.length === 1 && t30.evidence.methodSequence[0] === "HEAD",
    t30.evidence.methodSequence.join(",")
  );

  // 同样的页面但 HEAD 不可用 → 强制 GET，此时 E1 必须真的挡住
  const t30b = await probeUrl(mock, "/parked-long-nohead");
  check(
    "T30b",
    "HEAD 不可用时走 GET，正文 >1500 → E1 否决",
    t30b.outcome === "ok" && t30b.evidence.exclusionsHit.includes("E1"),
    `${t30b.outcome} exclusions=[${t30b.evidence.exclusionsHit.join(",")}]`
  );

  const t31 = await probeUrl(mock, "/parked-manylinks");
  check(
    "T31",
    "内链 >5 → ok（E2 否决）",
    t31.outcome === "ok" && t31.evidence.exclusionsHit.includes("E2"),
    `${t31.outcome} ${t31.evidence.exclusionsHit.join(",")}`
  );

  const t32 = await probeUrl(mock, "/parked-en", { isDomainCategory: true });
  check(
    "T32",
    "域名类目工具 → ok（E5 否决）",
    t32.outcome === "ok" && t32.evidence.exclusionsHit.includes("E5"),
    `${t32.outcome} ${t32.evidence.exclusionsHit.join(",")}`
  );

  const t33 = await probeUrl(mock, "/coming-soon");
  check("T33", "仅 coming soon（L3）→ ok", t33.outcome === "ok", t33.outcome);

  const t34 = await probeUrl(mock, "/parked-brand", { title: "Acme Writer" });
  check(
    "T34",
    "品牌名仍在 title → ok（E3 否决）",
    t34.outcome === "ok" && t34.evidence.exclusionsHit.includes("E3"),
    `${t34.outcome} ${t34.evidence.exclusionsHit.join(",")}`
  );
}

async function antiConcatTests(mock: MockServer) {
  console.log("\n8.4 反拼接边界（★ 8 词 + 8 词 ≠ 16 词的同源问题）\n");

  const t35 = await probeUrl(mock, "/split-buy-domain");
  check(
    "T35",
    "<div>Buy</div><div>this domain now</div> 不得拼成 buy this domain",
    t35.outcome !== "parked",
    t35.outcome
  );

  const t36 = await probeUrl(mock, "/split-not-found");
  check("T36", "<li>Not</li><li>found here</li> 不得拼成 not found", t36.outcome !== "soft_404", t36.outcome);

  const t37 = await probeUrl(mock, "/split-cn");
  check("T37", "中文跨块「此域|名待售」不得拼接", t37.outcome !== "parked", t37.outcome);

  const t38 = await probeUrl(mock, "/inblock-buy-domain");
  check(
    "T38",
    "块内完整命中仍要拦（确认没矫枉过正）",
    t38.outcome === "parked",
    t38.outcome
  );

  const t39 = await probeUrl(mock, "/mixed-split-and-inblock");
  const spanning = t39.evidence.matchedSignatures.filter((s) => s.matchedText.includes("\x00"));
  check(
    "T39",
    "跨块与块内并存时只记块内命中",
    t39.outcome === "parked" && spanning.length === 0,
    `${t39.outcome} 跨界命中 ${spanning.length}`
  );

  // 直接测分块器本身
  const blocks = extractText("<div>Buy</div><div>this domain</div>").blocks;
  check(
    "T39b",
    "分块器把两段分开",
    blocks.length === 2 && blocks[0] === "Buy" && blocks[1] === "this domain",
    JSON.stringify(blocks)
  );
}

async function blockedDeferredTests(mock: MockServer) {
  console.log("\n8.5 blocked / deferred\n");

  const t40 = await probeUrl(mock, "/cf-challenge");
  check("T40", "Cloudflare challenge → blocked", t40.outcome === "blocked", t40.outcome);

  const t41 = await probeUrl(mock, "/verify-human");
  check("T41", "verify you are human → blocked", t41.outcome === "blocked", t41.outcome);

  const t42 = await probeUrl(mock, "/451");
  check("T42", "451 → blocked", t42.outcome === "blocked", t42.outcome);

  // robots
  await fetch(`${mock.origin}/__robots?mode=disallow`);
  mock.reset();
  const t43 = await probeUrl(mock, "/robots-disallowed/page");
  const mainRequests = mock.log.filter((l) => l.path === "/robots-disallowed/page");
  check(
    "T43",
    "robots Disallow → blocked 且零主请求",
    t43.outcome === "blocked" && mainRequests.length === 0,
    `${t43.outcome} 主请求 ${mainRequests.length}`
  );

  await fetch(`${mock.origin}/__robots?mode=500`);
  const t44 = await probeUrl(mock, "/ok");
  check(
    "T44",
    "robots 500 → deferred（不当允许也不当失败）",
    t44.outcome === "deferred",
    t44.outcome
  );

  await fetch(`${mock.origin}/__robots?mode=delay`);
  const t45 = await probeUrl(mock, "/robots-delay/page");
  check("T45", "Crawl-delay 60s → deferred", t45.outcome === "deferred", t45.outcome);

  await fetch(`${mock.origin}/__robots?mode=allow`);

  const t46 = await probeUrl(mock, "/429");
  check(
    "T46",
    "429 + Retry-After → deferred",
    t46.outcome === "deferred" && t46.retryAfterMs === 3600_000,
    `${t46.outcome} retry=${t46.retryAfterMs}`
  );

  const t47 = await probeUrl(mock, "/429-bare");
  check(
    "T47",
    "429 无 Retry-After → deferred +6h",
    t47.outcome === "deferred" && t47.retryAfterMs === 6 * 3600_000,
    `${t47.outcome} retry=${t47.retryAfterMs}`
  );

  const t48 = await probeUrl(mock, "/503-retry");
  check(
    "T48",
    "503 + Retry-After → deferred（下限钳到 1h）",
    t48.outcome === "deferred" && t48.retryAfterMs === 3600_000,
    `${t48.outcome} retry=${t48.retryAfterMs}`
  );

  const t49 = await probeUrl(mock, "/503-plain");
  check("T49", "503 无 Retry-After → http_5xx", t49.outcome === "http_5xx", t49.outcome);

  const t50 = (["blocked", "deferred", "unsafe_target", "unknown"] as ProbeOutcome[]).every(
    (o) => !countsTowardBreaker(o)
  );
  check("T50", "blocked/deferred/unsafe/unknown 均不计熔断", t50);
}

async function ssrfTests() {
  console.log("\n8.6 SSRF\n");

  const cases: [string, string, string][] = [
    ["T51", "file:///etc/passwd", "protocol_not_allowed"],
    ["T52", "http://127.0.0.1/", "private_ip"],
    ["T53", "http://10.1.2.3/", "private_ip"],
    ["T54", "http://169.254.169.254/", "metadata_endpoint"],
    ["T55", "http://100.100.100.200/", "metadata_endpoint"],
    ["T59", "http://[::ffff:127.0.0.1]/", "private_ip"],
    ["T60", "http://example.com:22/", "port_not_allowed"],
    ["T61", "http://evil.com@127.0.0.1/", "userinfo_in_url"],
    ["T62", "http://foo.internal/", "hostname_not_allowed"],
  ];
  for (const [id, url, expected] of cases) {
    const verdict = await assertSafeUrl(url, async () => [PUBLIC_IP]);
    check(
      id,
      `${url} → ${expected}`,
      !verdict.safe && verdict.reason === expected,
      verdict.safe ? "safe!" : verdict.reason
    );
  }

  // T57：多 A 记录，任一命中即拒
  const t57 = await assertSafeUrl("http://multi.example.com/", async () => [
    PUBLIC_IP,
    "127.0.0.1",
  ]);
  check("T57", "多 A 记录任一私网即拒", !t57.safe && t57.reason === "private_ip", t57.safe ? "safe!" : t57.reason);

  // T58：DNS rebinding —— 校验时公网，第二次解析给内网
  let calls = 0;
  const rebinding = async () => {
    calls++;
    return calls === 1 ? [PUBLIC_IP] : ["127.0.0.1"];
  };
  const t58 = await assertSafeUrl("http://rebind.example.com/", rebinding);
  check(
    "T58",
    "rebinding：校验通过时 pinnedIp 已固定为首解析地址",
    t58.safe && t58.pinnedIp === PUBLIC_IP,
    t58.safe ? t58.pinnedIp : t58.reason
  );

  // T56：重定向到私网 —— 在 http-client 层每跳重校验
  const t56 = await assertSafeUrl("http://192.168.1.1/", async () => ["192.168.1.1"]);
  check("T56", "重定向目标 192.168.1.1 会被拒", !t56.safe && t56.reason === "private_ip");

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
  check("T51c", "真实公网地址不被误拒",
    publicOk.every((ip) => !isBlockedAddress(ip)),
    publicOk.filter((ip) => isBlockedAddress(ip)).join(","));

  // 文档保留段确实在黑名单里（确认上面换 IP 的理由成立）
  const docRanges = ["203.0.113.1", "192.0.2.1", "198.51.100.1"];
  check("T51d", "文档保留段仍被拒", docRanges.every(isBlockedAddress));

  // ★ 默认参数（不传 safety）下 loopback 必须被拒 —— 证明测试注入点没有放松生产规则
  const prodDefault = await assertSafeUrl("http://127.0.0.1:8080/", async () => ["127.0.0.1"]);
  check("T52b", "生产默认参数下 loopback 仍被拒（测试开关未放松规则）",
    !prodDefault.safe, prodDefault.safe ? "safe!" : prodDefault.reason);
  const prodPort = await assertSafeUrl("http://example.com:8080/", async () => [PUBLIC_IP]);
  check("T60b", "生产默认参数下非 80/443 端口仍被拒",
    !prodPort.safe && prodPort.reason === "port_not_allowed",
    prodPort.safe ? "safe!" : prodPort.reason);
}

async function redirectSsrfTest(mock: MockServer) {
  const r = await probeUrl(mock, "/redir-private");
  check(
    "T56b",
    "探针跟随重定向到私网 → unsafe_target",
    r.outcome === "unsafe_target",
    `${r.outcome}/${r.unsafeReason}`
  );
}

function debounceTests() {
  console.log("\n8.7 消抖与轮次\n");

  const day = (n: number) => new Date(Date.UTC(2026, 0, n, 4, 0, 0));
  const failRound = (kind: string, at: Date, outcome: ProbeOutcome = "timeout") => ({
    outcome,
    errorKind: kind,
    evidenceStrength: null,
    confidence: "high" as const,
    domainMigrated: false,
    finalUrl: null,
    probeVersion: PROBE_VERSION,
    at,
  });
  const okRound = (at: Date) => ({
    outcome: "ok" as ProbeOutcome,
    errorKind: null,
    evidenceStrength: null,
    confidence: "high" as const,
    domainMigrated: false,
    finalUrl: null,
    probeVersion: PROBE_VERSION,
    at,
  });

  // T64：同日 3 次失败只计一轮
  let s: DebounceState = INITIAL_STATE;
  for (let i = 0; i < 3; i++) {
    const d = applyRound(s, failRound("timeout", day(1)));
    if (d.ok) s = d.next;
  }
  check(
    "T64",
    "同日 3 次失败 → streak=1, distinct=1",
    s.consecutiveFails === 1 && s.distinctFailDates === 1,
    `streak=${s.consecutiveFails} distinct=${s.distinctFailDates}`
  );

  // T66：第 1/8/15 天各失败一次 → dead
  const r66 = replay([failRound("timeout", day(1)), failRound("timeout", day(8)), failRound("timeout", day(15))]);
  check(
    "T66",
    "1/8/15 天各一次 timeout → dead",
    r66.state.reach === "dead" && r66.state.distinctFailDates === 3,
    `${r66.state.reach} distinct=${r66.state.distinctFailDates}`
  );

  // T67：跨度仅 13 天
  const r67 = replay([failRound("timeout", day(1)), failRound("timeout", day(7)), failRound("timeout", day(14))]);
  check("T67", "跨度 13 天 → 不判 dead", r67.state.reach !== "dead", r67.state.reach);

  // T68：连续 3 天
  const r68 = replay([failRound("timeout", day(1)), failRound("timeout", day(2)), failRound("timeout", day(3))]);
  check("T68", "连续 3 天（跨度 2 天）→ 不判 dead", r68.state.reach !== "dead", r68.state.reach);

  // T69：族变更重置
  const r69 = replay([
    failRound("timeout", day(1)),
    failRound("timeout", day(8)),
    failRound("http_404", day(15), "http_404"),
  ]);
  check(
    "T69",
    "network → gone 族变更后重新计数",
    r69.state.consecutiveFails === 2 && r69.state.distinctFailDates === 1 && r69.state.reach !== "dead",
    `streak=${r69.state.consecutiveFails} distinct=${r69.state.distinctFailDates} reach=${r69.state.reach}`
  );

  // T70：同族不同 kind 累加
  const r70 = replay([
    failRound("timeout", day(1)),
    failRound("dns", day(8), "dns"),
    failRound("tls", day(15), "tls"),
  ]);
  check(
    "T70",
    "timeout/dns/tls 同属 network → 累加至 dead",
    r70.state.reach === "dead" && r70.state.distinctFailDates === 3,
    `${r70.state.reach} distinct=${r70.state.distinctFailDates}`
  );

  // T71：404 权重 2，两轮 streak=4 但 distinct=2
  const r71 = replay([failRound("http_404", day(1), "http_404"), failRound("http_404", day(20), "http_404")]);
  check(
    "T71",
    "404 权重 ×2：streak=4 但 distinct=2 → 不判 dead",
    r71.state.consecutiveFails === 4 && r71.state.distinctFailDates === 2 && r71.state.reach !== "dead",
    `streak=${r71.state.consecutiveFails} distinct=${r71.state.distinctFailDates} reach=${r71.state.reach}`
  );

  // T72：失败后恢复
  const r72 = replay([
    failRound("timeout", day(1)),
    failRound("timeout", day(8)),
    failRound("timeout", day(15)),
    okRound(day(16)),
  ]);
  const lastFlags = r72.steps[3].ok ? r72.steps[3].changeFlags : [];
  check(
    "T72",
    "dead 后一次 ok → 清零 + recovered",
    r72.state.reach === "ok" && r72.state.consecutiveFails === 0 && lastFlags.includes("recovered"),
    `${r72.state.reach} flags=${lastFlags.join(",")}`
  );

  // T74：dead 状态下 blocked 保持 dead
  const deadState = replay([failRound("timeout", day(1)), failRound("timeout", day(8)), failRound("timeout", day(15))]).state;
  const afterBlocked = applyRound(deadState, {
    outcome: "blocked", errorKind: "blocked", evidenceStrength: null,
    confidence: "high", domainMigrated: false, finalUrl: null,
    probeVersion: PROBE_VERSION, at: day(20),
  });
  check(
    "T74",
    "已 dead 遇 blocked → 保持 dead（不退回 unverifiable）",
    afterBlocked.ok && afterBlocked.next.reach === "dead",
    afterBlocked.ok ? afterBlocked.next.reach : "?"
  );

  // 非 dead 遇 blocked → unverifiable
  const afterBlockedFresh = applyRound(INITIAL_STATE, {
    outcome: "blocked", errorKind: "blocked", evidenceStrength: null,
    confidence: "high", domainMigrated: false, finalUrl: null,
    probeVersion: PROBE_VERSION, at: day(1),
  });
  check(
    "T74b",
    "非 dead 遇 blocked → unverifiable",
    afterBlockedFresh.ok && afterBlockedFresh.next.reach === "unverifiable",
    afterBlockedFresh.ok ? afterBlockedFresh.next.reach : "?"
  );

  // T75：parked 强证据单次即 dead
  const t75 = applyRound(INITIAL_STATE, {
    outcome: "parked", errorKind: "parked", evidenceStrength: "strong",
    confidence: "high", domainMigrated: false, finalUrl: null,
    probeVersion: PROBE_VERSION, at: day(1),
  });
  check("T75", "parked 强证据 → 单次 dead", t75.ok && t75.next.reach === "dead", t75.ok ? t75.next.reach : "?");

  const t75b = applyRound(INITIAL_STATE, {
    outcome: "parked", errorKind: "parked", evidenceStrength: "weak",
    confidence: "high", domainMigrated: false, finalUrl: null,
    probeVersion: PROBE_VERSION, at: day(1),
  });
  check("T75b", "parked 弱证据 → 走消抖，不立即 dead", t75b.ok && t75b.next.reach !== "dead", t75b.ok ? t75b.next.reach : "?");

  // unsafe_target 永不 dead
  const r63 = replay([
    { outcome: "unsafe_target", errorKind: "unsafe_target", evidenceStrength: null, confidence: "high", domainMigrated: false, finalUrl: null, probeVersion: PROBE_VERSION, at: day(1) },
    { outcome: "unsafe_target", errorKind: "unsafe_target", evidenceStrength: null, confidence: "high", domainMigrated: false, finalUrl: null, probeVersion: PROBE_VERSION, at: day(20) },
    { outcome: "unsafe_target", errorKind: "unsafe_target", evidenceStrength: null, confidence: "high", domainMigrated: false, finalUrl: null, probeVersion: PROBE_VERSION, at: day(40) },
  ]);
  check(
    "T63",
    "unsafe_target 三轮 → 始终 unverifiable，绝不 dead",
    r63.state.reach === "unverifiable" && r63.state.needsManualCheck,
    `${r63.state.reach} manual=${r63.state.needsManualCheck}`
  );

  // deferred 不改任何字段
  const beforeDeferred = { ...INITIAL_STATE, consecutiveFails: 2, distinctFailDates: 2 };
  const afterDeferred = applyRound(beforeDeferred, {
    outcome: "deferred", errorKind: null, evidenceStrength: null,
    confidence: "high", domainMigrated: false, finalUrl: null,
    probeVersion: PROBE_VERSION, at: day(9),
  });
  check(
    "T46b",
    "deferred 不改消抖字段",
    afterDeferred.ok &&
      afterDeferred.next.consecutiveFails === 2 &&
      afterDeferred.next.distinctFailDates === 2,
    afterDeferred.ok ? `streak=${afterDeferred.next.consecutiveFails}` : "?"
  );

  // 版本不匹配
  const mismatch = applyRound(INITIAL_STATE, {
    outcome: "ok", errorKind: null, evidenceStrength: null, confidence: "high",
    domainMigrated: false, finalUrl: null, probeVersion: PROBE_VERSION + 99, at: day(1),
  });
  check(
    "T79",
    "probe_version 不匹配 → version_mismatch，不静默混算",
    !mismatch.ok && mismatch.reason === "version_mismatch",
    mismatch.ok ? "被静默接受了！" : mismatch.reason
  );

  const mixedReplay = replay([
    okRound(day(1)),
    { ...okRound(day(2)), probeVersion: PROBE_VERSION + 99 },
    failRound("timeout", day(3)),
  ]);
  check("T79b", "replay 计数版本不匹配轮次", mixedReplay.versionMismatches === 1, String(mixedReplay.versionMismatches));

  // domain_migrated
  const migrated = applyRound(INITIAL_STATE, {
    outcome: "ok", errorKind: null, evidenceStrength: null, confidence: "high",
    domainMigrated: true, finalUrl: "https://new-brand.com/", probeVersion: PROBE_VERSION, at: day(1),
  });
  check(
    "T29b",
    "domain_migrated → 标 flag + needs_manual_check，不自动改 URL",
    migrated.ok &&
      migrated.changeFlags.includes("domain_migrated") &&
      migrated.next.needsManualCheck &&
      migrated.next.reach === "ok",
    migrated.ok ? migrated.changeFlags.join(",") : "?"
  );
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
  const mock = await startMockServer();
  console.log(`mock server: ${mock.origin}\n（不访问任何真实站点）`);
  try {
    await stateMachineTests(mock);
    await soft404Tests(mock);
    await parkedTests(mock);
    await antiConcatTests(mock);
    await blockedDeferredTests(mock);
    await ssrfTests();
    await redirectSsrfTest(mock);
    debounceTests();
    pslTests();
  } finally {
    await mock.close();
  }

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
