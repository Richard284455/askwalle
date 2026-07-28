import { safeFetch, Transport } from "./http-client";
import { ResolveFn } from "./ssrf";

/**
 * robots.txt（契约 §1.4）。
 *
 * 关键取舍：robots 取不回来时**不当作允许**，也**不当作站点失败**，而是 deferred。
 * 把 5xx 当允许是不礼貌；把它当失败会让对方一次运维事故变成我们判死链的证据。
 */

export type RobotsDecision =
  | { decision: "allow"; crawlDelayMs: number; cachedAt: number }
  | { decision: "disallow"; rule: string; cachedAt: number }
  | { decision: "deferred"; reason: string; retryAfterMs: number };

const UA = "askwallebot";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CRAWL_DELAY_MS = 10_000;

type CacheEntry = { at: number; value: RobotsDecision };
const CACHE = Symbol.for("askwalle.robotsCache");
type RobotsGlobal = typeof globalThis & { [CACHE]?: Map<string, CacheEntry> };

function cache(): Map<string, CacheEntry> {
  const g = globalThis as RobotsGlobal;
  if (!g[CACHE]) g[CACHE] = new Map();
  return g[CACHE]!;
}

type Group = { agents: string[]; allow: string[]; disallow: string[]; crawlDelay: number | null };

export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (!current) continue;
    lastWasAgent = false;
    if (field === "disallow") current.disallow.push(value);
    else if (field === "allow") current.allow.push(value);
    else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  return groups;
}

function patternMatches(pattern: string, path: string): boolean {
  if (pattern === "") return false;
  // 支持 * 通配与 $ 锚定（robots.txt 事实标准）
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  const anchored = escaped.endsWith("\\$") ? `^${escaped.slice(0, -2)}$` : `^${escaped}`;
  try {
    return new RegExp(anchored).test(path);
  } catch {
    return path.startsWith(pattern);
  }
}

export function evaluateRobots(groups: Group[], path: string): {
  allowed: boolean;
  rule: string;
  crawlDelayMs: number;
} {
  // 先精确匹配我们的 UA，无则退到 *
  const exact = groups.filter((g) => g.agents.includes(UA));
  const wildcard = groups.filter((g) => g.agents.includes("*"));
  const chosen = exact.length ? exact : wildcard;
  if (!chosen.length) return { allowed: true, rule: "", crawlDelayMs: 0 };

  let best: { len: number; allow: boolean; rule: string } = { len: -1, allow: true, rule: "" };
  let crawlDelay = 0;

  for (const group of chosen) {
    if (group.crawlDelay !== null) crawlDelay = Math.max(crawlDelay, group.crawlDelay * 1000);
    for (const rule of group.allow) {
      if (patternMatches(rule, path) && rule.length > best.len) {
        best = { len: rule.length, allow: true, rule: `Allow: ${rule}` };
      }
    }
    for (const rule of group.disallow) {
      // Disallow: 空值表示「允许全部」，不参与最长匹配
      if (rule === "") continue;
      if (patternMatches(rule, path) && rule.length > best.len) {
        best = { len: rule.length, allow: false, rule: `Disallow: ${rule}` };
      }
    }
  }
  return { allowed: best.allow, rule: best.rule, crawlDelayMs: crawlDelay };
}

export async function checkRobots(
  targetUrl: string,
  resolve?: ResolveFn,
  transport?: Transport
): Promise<RobotsDecision> {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return { decision: "allow", crawlDelayMs: 0, cachedAt: Date.now() };
  }
  const key = `${url.protocol}//${url.host}`;
  const hit = cache().get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const robotsUrl = `${key}/robots.txt`;
  const result = await safeFetch(robotsUrl, { method: "GET", resolve, transport });

  let decision: RobotsDecision;
  if (result.kind === "network_error") {
    // DNS/连接失败：robots 拿不到，但主请求同样会失败并被正确分类。
    // 这里放行，让主请求去产出真正的 error_kind。
    decision = { decision: "allow", crawlDelayMs: 0, cachedAt: Date.now() };
  } else if (result.kind === "unsafe") {
    // 安全拒绝也放行到主请求：同一主机的主 URL 会被同一条规则拒掉，
    // 由它产出权威的 unsafe_target。两者都在建连之前就被拦下，不多一个包。
    //
    // 这里若 deferred，一个解析到私网的主机就只会得到「稍后重试」，
    // 安全告警队列反而看不到它 —— 分类必须由主请求统一给出。
    decision = { decision: "allow", crawlDelayMs: 0, cachedAt: Date.now() };
  } else if (result.kind === "redirect_loop") {
    decision = { decision: "allow", crawlDelayMs: 0, cachedAt: Date.now() };
  } else if (result.status >= 500) {
    decision = { decision: "deferred", reason: `robots_${result.status}`, retryAfterMs: 24 * 3600_000 };
  } else if (result.status >= 400) {
    decision = { decision: "allow", crawlDelayMs: 0, cachedAt: Date.now() };
  } else {
    const groups = parseRobots(result.body ?? "");
    const verdict = evaluateRobots(groups, `${url.pathname}${url.search}` || "/");
    if (!verdict.allowed) {
      decision = { decision: "disallow", rule: verdict.rule, cachedAt: Date.now() };
    } else if (verdict.crawlDelayMs > MAX_CRAWL_DELAY_MS) {
      decision = {
        decision: "deferred",
        reason: `crawl_delay_${Math.round(verdict.crawlDelayMs / 1000)}s`,
        retryAfterMs: Math.min(verdict.crawlDelayMs, 7 * 24 * 3600_000),
      };
    } else {
      decision = { decision: "allow", crawlDelayMs: verdict.crawlDelayMs, cachedAt: Date.now() };
    }
  }

  // deferred 不进缓存：它是临时状态，缓存 24h 会让恢复也要等 24h
  if (decision.decision !== "deferred") cache().set(key, { at: Date.now(), value: decision });
  return decision;
}

/** 测试用：清空进程内缓存 */
export function clearRobotsCache(): void {
  cache().clear();
}
