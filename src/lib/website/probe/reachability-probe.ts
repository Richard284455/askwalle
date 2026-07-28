import { promises as dns } from "dns";

import { safeFetch, FetchResult, Transport } from "./http-client";
import { checkRobots } from "./robots";
import { hostInfo, registrableDomainOf, sameRegistrableDomain } from "./registrable-domain";
import { ResolveFn } from "./ssrf";
import { extractText, ExtractedText } from "./text-blocks";
import {
  SignatureHit,
  PARKED_STRUCTURE,
  SOFT_404_LIMITS,
  countInternalLinks,
  hasProductPaths,
  matchBodySignatures,
  matchChallenge,
  matchParkingHeaders,
  matchParkingHost,
  matchParkingNs,
  matchSoft404,
} from "./signatures";
import {
  ContentVerdict,
  ERROR_FAMILY,
  ProbeEvidence,
  ProbeOutcome,
  ProbeResult,
  PROBE_VERSION,
} from "./types";

/**
 * Reachability Probe —— 契约 v1.0 的实现。
 *
 * 一个 scheduled round 恰好产出一个 outcome。HEAD→GET 升级、重定向、robots 预检
 * 全都在轮次内部，不产生额外轮次。
 */

export type ProbeInput = {
  url: string;
  /** 工具标题：用于排除项 E3（品牌词仍在页面上 → 不判 parked） */
  title?: string | null;
  /** 是否属于「域名/建站」类目：排除项 E5 */
  isDomainCategory?: boolean;
  /** 注入点，测试用 */
  resolve?: ResolveFn;
  lookupNs?: (domain: string) => Promise<string[]>;
  /** 契约测试注入内存 fixture；生产走默认 nodeTransport。SSRF 校验两边完全一致 */
  transport?: Transport;
  /**
   * 本轮强制做深度内容检查：禁用 HEAD 短路，一定取正文。
   * 由服务层按 last_content_checked_at + tier 算出（types.isContentCheckDue）。
   */
  forceContentCheck?: boolean;
};

const defaultLookupNs = async (domain: string): Promise<string[]> => dns.resolveNs(domain);

function emptyEvidence(url: string): ProbeEvidence {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    /* 交给 SSRF 校验去报 url_unparsable */
  }
  return {
    probeVersion: PROBE_VERSION,
    requestedUrl: url.slice(0, 500),
    scheme: parsed?.protocol.replace(":", "") ?? null,
    host: parsed?.hostname ?? null,
    port: parsed ? Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)) : null,
    resolvedIps: [],
    pinnedIp: null,
    redirectChain: [],
    methodSequence: [],
    finalStatus: null,
    finalUrl: null,
    finalRegistrableDomain: null,
    headersSubset: {},
    tlsError: null,
    networkError: null,
    bytesRead: 0,
    truncated: false,
    contentType: null,
    contentVerdict: null,
    visibleTextLen: 0,
    textBlockCount: 0,
    internalLinkCount: 0,
    titleExcerpt: null,
    h1Excerpt: null,
    matchedSignatures: [],
    weakSignals: [],
    exclusionsHit: [],
    robotsDecision: "allow",
    robotsRule: null,
    retryAfterSeconds: null,
    unsafeReason: null,
    nsRecords: null,
    nsLookupFailed: false,
    latency: { dnsMs: null, headMs: null, getMs: null, totalMs: 0 },
  };
}

function result(
  outcome: ProbeOutcome,
  evidence: ProbeEvidence,
  extra: Partial<ProbeResult> = {}
): ProbeResult {
  const errorKind = extra.errorKind !== undefined ? extra.errorKind : outcome === "ok" ? null : outcome;
  return {
    probeVersion: PROBE_VERSION,
    outcome,
    errorKind,
    errorFamily: errorKind ? ERROR_FAMILY[errorKind] ?? null : null,
    evidenceStrength: null,
    confidence: "high",
    contentVerdict: evidence.contentVerdict,
    finalStatus: evidence.finalStatus,
    finalUrl: evidence.finalUrl,
    latencyMs: evidence.latency.totalMs,
    retryAfterMs: null,
    domainMigrated: false,
    unsafeReason: evidence.unsafeReason,
    contentChecked: false,
    evidence,
    ...extra,
  };
}

function parseRetryAfter(value: string | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, Math.round((at - Date.now()) / 1000));
  return null;
}

const clampRetry = (seconds: number | null, fallbackMs: number): number =>
  seconds === null
    ? fallbackMs
    : Math.min(Math.max(seconds * 1000, 3_600_000), 7 * 24 * 3_600_000);

/** 契约 §1.1：HEAD 短路的六个条件必须全满足 */
function headCanShortCircuit(
  response: Extract<FetchResult, { kind: "response" }>,
  requestedHost: string
): boolean {
  if (response.status < 200 || response.status > 299) return false;
  if (!sameRegistrableDomain(new URL(response.finalUrl).hostname, requestedHost)) return false;

  const length = response.headers["content-length"];
  // 只在 Content-Length 存在时生效：分块传输普遍不带该头，
  // 把「缺失」也当触发器等于取消 HEAD 短路
  if (length !== undefined && Number(length) < 512) return false;

  const type = response.headers["content-type"];
  if (type && !/text\/html|application\/xhtml\+xml|text\/plain/i.test(type)) return false;

  if (response.headers["cf-mitigated"]) return false;
  return true;
}

function classifyContentVerdict(
  response: Extract<FetchResult, { kind: "response" }>,
  text: ExtractedText | null
): ContentVerdict {
  const type = response.headers["content-type"] ?? "";
  if (type && !/text\/html|application\/xhtml\+xml|text\/plain/i.test(type)) return "non_html";
  if (response.body === null) return "undecodable";
  if (
    text &&
    text.textLength < 50 &&
    text.hasScriptSrc &&
    !text.hasNoscriptContent
  ) {
    return "spa_shell";
  }
  // 截断本身不是「读不懂」。64KB 上限让大站几乎必然截断，若在这里短路，
  // soft-404 / parked 分类永远轮不到 —— v3 就有 101 轮卡在 truncated。
  // 只有连一个字都没解出来时，truncated 才是比 normal 更准确的结论。
  if (response.truncated && (!text || text.textLength === 0)) return "truncated";
  return "normal";
}

export async function probeReachability(input: ProbeInput): Promise<ProbeResult> {
  const started = Date.now();
  const evidence = emptyEvidence(input.url);
  const finish = <T extends ProbeResult>(r: T): T => {
    evidence.latency.totalMs = Date.now() - started;
    r.latencyMs = evidence.latency.totalMs;
    return r;
  };

  // ── S0 PREFLIGHT: robots ──────────────────────────────────────────────
  const robots = await checkRobots(input.url, input.resolve, input.transport);
  evidence.robotsDecision = robots.decision;
  if (robots.decision === "disallow") {
    evidence.robotsRule = robots.rule;
    return finish(
      result("blocked", evidence, { errorKind: "blocked", confidence: "high" })
    );
  }
  if (robots.decision === "deferred") {
    evidence.robotsRule = robots.reason;
    return finish(
      result("deferred", evidence, { errorKind: null, retryAfterMs: robots.retryAfterMs })
    );
  }
  if (robots.crawlDelayMs > 0) {
    await new Promise((r) => setTimeout(r, robots.crawlDelayMs));
  }

  // ── S1 HEAD ───────────────────────────────────────────────────────────
  const requestedHost = (() => {
    try {
      return new URL(input.url).hostname;
    } catch {
      return "";
    }
  })();

  evidence.methodSequence.push("HEAD");
  const headStart = Date.now();
  const head = await safeFetch(input.url, { method: "HEAD", resolve: input.resolve, transport: input.transport });
  evidence.latency.headMs = Date.now() - headStart;

  // 内联判别而非提取成 helper：TS 的联合收窄穿不过函数调用
  if (head.kind === "unsafe") {
    evidence.unsafeReason = head.verdict.reason;
    evidence.redirectChain = head.redirectChain;
    return finish(result("unsafe_target", evidence, { errorKind: "unsafe_target" }));
  }

  if (head.kind === "response") {
    evidence.redirectChain = head.redirectChain;
    evidence.resolvedIps = head.resolvedIps;
    evidence.pinnedIp = head.pinnedIp;
    evidence.finalStatus = head.status;
    evidence.finalUrl = head.finalUrl;
    evidence.headersSubset = head.headers;
    // 深度内容检查到期时不许短路：必须取正文，否则正常体积的 soft-404 /
    // 停放页会一直被 HEAD 的 200 掩盖过去
    if (!input.forceContentCheck && headCanShortCircuit(head, requestedHost)) {
      evidence.finalRegistrableDomain = registrableDomainOf(new URL(head.finalUrl).hostname);
      return finish(result("ok", evidence));
    }
  }

  // ── S2 GET（契约 §1.2：除 §1.1 全满足外的所有情况都要复核）─────────────
  evidence.methodSequence.push("GET");
  const getStart = Date.now();
  const get = await safeFetch(input.url, { method: "GET", resolve: input.resolve, transport: input.transport });
  evidence.latency.getMs = Date.now() - getStart;

  if (get.kind === "unsafe") {
    evidence.unsafeReason = get.verdict.reason;
    evidence.redirectChain = get.redirectChain;
    return finish(result("unsafe_target", evidence, { errorKind: "unsafe_target" }));
  }

  if (get.kind === "redirect_loop") {
    evidence.redirectChain = get.redirectChain;
    return finish(result("timeout", evidence, { errorKind: "redirect_loop" }));
  }

  if (get.kind === "network_error") {
    evidence.redirectChain = get.redirectChain;
    evidence.networkError = `${get.code}: ${get.message}`;
    if (get.errorKind === "tls") evidence.tlsError = get.code;

    // ★ 客户端内部错误：我们自己的 bug，不能算在站点头上。
    // 记 unknown（探测结果而非生命周期失败），不进消抖、不触发熔断，
    // 但在证据里留下明确标记，便于事后一眼看出是探针坏了。
    if (get.errorKind === "internal") {
      evidence.clientInternalError = true;
      return finish(
        result("unknown", evidence, { errorKind: null, confidence: "low" })
      );
    }

    const outcome: ProbeOutcome =
      get.errorKind === "dns" ? "dns" : get.errorKind === "tls" ? "tls" : "timeout";
    // connection 类归入 timeout 族：对判定而言两者都是 network，且不需要再分
    return finish(result(outcome, evidence));
  }

  evidence.redirectChain = get.redirectChain;
  evidence.resolvedIps = get.resolvedIps;
  evidence.pinnedIp = get.pinnedIp;
  evidence.finalStatus = get.status;
  evidence.finalUrl = get.finalUrl;
  evidence.headersSubset = get.headers;
  evidence.bytesRead = get.bytesRead;
  evidence.truncated = get.truncated;
  evidence.contentType = get.headers["content-type"] ?? null;

  const finalHost = (() => {
    try {
      return new URL(get.finalUrl).hostname;
    } catch {
      return requestedHost;
    }
  })();
  evidence.finalRegistrableDomain = registrableDomainOf(finalHost);
  const crossDomain = requestedHost ? !sameRegistrableDomain(finalHost, requestedHost) : false;

  const text = get.body ? extractText(get.body) : null;
  if (text) {
    evidence.visibleTextLen = text.textLength;
    evidence.textBlockCount = text.blocks.length;
    evidence.titleExcerpt = text.title?.slice(0, 200) ?? null;
    evidence.h1Excerpt = text.h1?.slice(0, 200) ?? null;
    evidence.internalLinkCount = countInternalLinks(text, get.finalUrl);
  }
  const contentVerdict = classifyContentVerdict(get, text);
  evidence.contentVerdict = contentVerdict;
  const contentUsable = contentVerdict === "normal";

  // ── S3 CLASSIFY ──────────────────────────────────────────────────────

  // blocked：状态码 + 挑战特征
  const challenge = text ? matchChallenge(get.headers, text.blocks) : null;
  if (get.status === 401 || get.status === 403 || get.status === 451) {
    if (challenge) evidence.matchedSignatures.push(challenge);
    return finish(result("blocked", evidence, { errorKind: "blocked" }));
  }
  if (challenge) {
    evidence.matchedSignatures.push(challenge);
    return finish(result("blocked", evidence, { errorKind: "blocked" }));
  }

  // deferred：429 恒定；503 仅在带 Retry-After 时
  const retryAfter = parseRetryAfter(get.headers["retry-after"]);
  evidence.retryAfterSeconds = retryAfter;
  if (get.status === 429) {
    return finish(
      result("deferred", evidence, {
        errorKind: null,
        retryAfterMs: clampRetry(retryAfter, 6 * 3_600_000),
      })
    );
  }
  if (get.status === 503 && retryAfter !== null) {
    return finish(
      result("deferred", evidence, {
        errorKind: null,
        retryAfterMs: clampRetry(retryAfter, 6 * 3_600_000),
      })
    );
  }

  if (get.status === 404) return finish(result("http_404", evidence));
  if (get.status === 410) return finish(result("http_410", evidence));
  if (get.status >= 500) return finish(result("http_5xx", evidence));
  if (get.status >= 400) {
    // 400/402/405/406/409 等：含糊，不计失败
    return finish(result("unknown", evidence, { errorKind: null }));
  }
  if (get.status < 200 || get.status > 299) {
    return finish(result("unknown", evidence, { errorKind: null }));
  }

  // ── 2xx：内容分类 ────────────────────────────────────────────────────
  // 契约 R3：内容检查只做减分。拿不到正文就退回状态码结论（2xx → ok）。
  if (!text || !contentUsable) {
    // 非 HTML / 截断 / 解不开：正文分类做不了，但 GET 已经完成，
    // 再来一轮也是同样结果 —— 记为已检查，避免每轮都白 GET
    return finish(
      result("ok", evidence, {
        confidence: "low",
        domainMigrated: crossDomain,
        contentChecked: contentVerdict !== null,
      })
    );
  }

  // parked
  const parked = classifyParked({
    text,
    headers: get.headers,
    finalHost,
    finalUrl: get.finalUrl,
    evidence,
    title: input.title ?? null,
    isDomainCategory: input.isDomainCategory === true,
    lookupNs: input.lookupNs ?? defaultLookupNs,
  });
  const parkedVerdict = await parked;
  if (parkedVerdict) {
    return finish(
      result("parked", evidence, {
        errorKind: "parked",
        evidenceStrength: parkedVerdict,
        domainMigrated: false,
        contentChecked: true,
      })
    );
  }

  // soft_404
  const soft = matchSoft404(text);
  const titleOrH1 = soft.titleHit ?? soft.h1Hit;
  if (titleOrH1 && text.textLength < SOFT_404_LIMITS.titleOrH1MaxText) {
    evidence.matchedSignatures.push(titleOrH1);
    return finish(result("soft_404", evidence, { contentChecked: true }));
  }
  if (
    soft.bodyHits.length &&
    text.textLength < SOFT_404_LIMITS.bodyMaxText &&
    evidence.internalLinkCount <= SOFT_404_LIMITS.bodyMaxInternalLinks
  ) {
    evidence.matchedSignatures.push(soft.bodyHits[0]);
    return finish(result("soft_404", evidence, { contentChecked: true }));
  }

  return finish(
    result("ok", evidence, {
      domainMigrated: crossDomain,
      confidence: "high",
      contentChecked: true,
    })
  );
}

/** 契约 §3.6 判定式 + §3.7 排除项 */
async function classifyParked(args: {
  text: ExtractedText;
  headers: Record<string, string>;
  finalHost: string;
  finalUrl: string;
  evidence: ProbeEvidence;
  title: string | null;
  isDomainCategory: boolean;
  lookupNs: (domain: string) => Promise<string[]>;
}): Promise<"strong" | "weak" | null> {
  const { text, headers, finalHost, evidence } = args;

  const body = matchBodySignatures(text.blocks);
  evidence.weakSignals = body.weakSignals.map((s) => s.ruleId);

  // L1：host / header
  const hostHit = matchParkingHost(finalHost);
  const headerHit = matchParkingHeaders(headers);
  let strong: SignatureHit | null = hostHit ?? headerHit;

  // L1：NS —— best-effort，且只在正文已命中 L2 时才查，不对全量做
  if (!strong && body.strongBody.length) {
    const domain = hostInfo(finalHost).registrableDomain;
    if (domain) {
      try {
        const ns = await args.lookupNs(domain);
        evidence.nsRecords = ns.slice(0, 8);
        const nsHit = matchParkingNs(ns);
        if (nsHit) strong = nsHit;
      } catch {
        // 契约决策：NS 查询 best-effort，失败不阻塞探针
        evidence.nsLookupFailed = true;
      }
    }
  }

  if (strong) {
    evidence.matchedSignatures.push(strong);
    for (const hit of body.strongBody.slice(0, 3)) evidence.matchedSignatures.push(hit);
    return "strong";
  }

  if (!body.strongBody.length) return null;

  // 结构条件
  const structureOk =
    text.textLength < PARKED_STRUCTURE.maxTextLength &&
    evidence.internalLinkCount <= PARKED_STRUCTURE.maxInternalLinks &&
    text.blocks.length <= PARKED_STRUCTURE.maxBlocks;

  // 排除项 E1–E7
  const exclusions: string[] = [];
  if (text.textLength > 1500) exclusions.push("E1");
  if (evidence.internalLinkCount > PARKED_STRUCTURE.maxInternalLinks) exclusions.push("E2");
  if (args.title) {
    const brand = args.title.trim().toLowerCase();
    const haystack = `${text.title ?? ""} ${text.h1 ?? ""}`.toLowerCase();
    if (brand.length >= 3 && haystack.includes(brand)) exclusions.push("E3");
  }
  if (hasProductPaths(text)) exclusions.push("E4");
  if (args.isDomainCategory) exclusions.push("E5");
  evidence.exclusionsHit = exclusions;

  if (!structureOk || exclusions.length) {
    // 记下命中但被否决的签名，供人工复核
    for (const hit of body.strongBody.slice(0, 3)) evidence.matchedSignatures.push(hit);
    return null;
  }

  for (const hit of body.strongBody.slice(0, 3)) evidence.matchedSignatures.push(hit);
  return "weak";
}
