import { prisma } from "@/lib/prisma";

import { AIHOT_BASE_URL } from "./types";

/**
 * AI HOT API v1 客户端。
 *
 * 只走 v1；**不抓网页**，也不碰已废弃的 `/api/public/*`。
 *
 * 礼貌性由三件事保证：条件请求（ETag）、429 按 Retry-After 等待、5xx 指数退避。
 * 前两者是对方明确表达的意愿，退避是对方没表达意愿时的保守默认。
 */

const USER_AGENT = "AskWalle-ContentBot/1.0 (+https://askwalle.com)";
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 800;
/** 单次响应体上限。API 是我们自己接的，但上限仍要有 —— 没有上限的读取不是读取 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** 429 时最长愿意等多久；超过就放弃本轮，交给下一次调度 */
const MAX_RETRY_AFTER_MS = 120_000;

export type AihotFetchOutcome =
  | { ok: true; status: 200; data: unknown; etag: string | null }
  | { ok: true; status: 304; data: null; etag: string | null }
  | { ok: false; status: number | null; reason: string };

/**
 * HTTP 传输层。抽成接口只为让离线测试能注入 fixture ——
 * 测试因此跑的是**完整的重试、退避与 304 逻辑**，不需要任何「测试模式」开关。
 *
 * 刻意不复用 probe 的 SSRF 钉 IP 传输：那一层是为「抓取任意第三方站点」设计的，
 * 而这里的目标主机是单一、固定、已批准的 API。
 */
export type AihotTransport = (args: {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Promise<{ status: number; headers: Record<string, string>; text: string }>;

export const fetchTransport: AihotTransport = async ({ url, headers, signal }) => {
  const res = await fetch(url, { headers, signal, redirect: "follow" });
  const buf = Buffer.from(await res.arrayBuffer());
  const h: Record<string, string> = {};
  res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  return {
    status: res.status,
    headers: h,
    text: buf.subarray(0, MAX_BODY_BYTES).toString("utf8"),
  };
};

/** Retry-After 既可能是秒数，也可能是 HTTP 日期 */
export function parseRetryAfter(raw: string | undefined, now = Date.now()): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d+$/.test(s)) return Math.max(0, Number(s) * 1000);
  const at = Date.parse(s);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 退避事件。定时任务的审计要能回答「这一轮到底被限流了几次」，
 * 而计数只有客户端自己知道 —— 返回值里看不到中途重试过几轮。
 */
export type AihotRetryEvent = {
  kind: "rate_limited" | "server_error" | "network_error";
  status: number | null;
  waitMs: number;
  attempt: number;
};

export type AihotClientOptions = {
  transport?: AihotTransport;
  baseUrl?: string;
  /** 注入等待，测试里用来免去真实 sleep */
  wait?: (ms: number) => Promise<void>;
  /** 条件请求用的 ETag；不传则不发 If-None-Match */
  etag?: string | null;
  maxAttempts?: number;
  /** 只观察，不影响行为 */
  observe?: (ev: AihotRetryEvent) => void;
};

/**
 * 取一个 v1 端点。
 *
 * 返回 304 时 data 为 null —— 调用方**不得**据此写库。「没变化」不是「没内容」，
 * 把 304 当成空结果去覆盖，会把已入库的内容清掉。
 */
export async function fetchAihot(path: string, opts: AihotClientOptions = {}): Promise<AihotFetchOutcome> {
  const transport = opts.transport ?? fetchTransport;
  const wait = opts.wait ?? sleep;
  const base = opts.baseUrl ?? AIHOT_BASE_URL;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const observe = opts.observe ?? (() => undefined);

  if (!path.startsWith("/api/v1/")) {
    return { ok: false, status: null, reason: `只允许 v1 端点，收到: ${path}` };
  }
  const url = `${base}${path}`;

  let lastReason = "未发起请求";
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (opts.etag) headers["If-None-Match"] = opts.etag;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Awaited<ReturnType<AihotTransport>>;
    try {
      res = await transport({ url, headers, signal: controller.signal });
    } catch (e) {
      lastStatus = null;
      lastReason = e instanceof Error ? e.message.slice(0, 160) : "请求失败";
      const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1);
      observe({ kind: "network_error", status: null, waitMs: attempt < maxAttempts ? backoff : 0, attempt });
      if (attempt < maxAttempts) await wait(backoff);
      continue;
    } finally {
      clearTimeout(timer);
    }

    lastStatus = res.status;
    const etag = res.headers["etag"] ?? null;

    if (res.status === 304) return { ok: true, status: 304, data: null, etag: etag ?? opts.etag ?? null };

    if (res.status === 200) {
      try {
        return { ok: true, status: 200, data: JSON.parse(res.text), etag };
      } catch {
        // 解析失败不重试：同一份响应再取一次还是同样解析不了
        return { ok: false, status: 200, reason: "响应不是合法 JSON" };
      }
    }

    if (res.status === 429) {
      const retryMs = parseRetryAfter(res.headers["retry-after"]) ?? BACKOFF_BASE_MS * 2 ** (attempt - 1);
      observe({ kind: "rate_limited", status: 429, waitMs: retryMs, attempt });
      if (retryMs > MAX_RETRY_AFTER_MS) {
        return { ok: false, status: 429, reason: `限流要求等待 ${Math.round(retryMs / 1000)}s，超过单轮上限，本轮放弃` };
      }
      lastReason = `限流 429，按 Retry-After 等待 ${Math.round(retryMs / 1000)}s`;
      if (attempt < maxAttempts) { await wait(retryMs); continue; }
      return { ok: false, status: 429, reason: lastReason };
    }

    if (res.status >= 500) {
      lastReason = `上游 ${res.status}`;
      const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1);
      observe({ kind: "server_error", status: res.status, waitMs: attempt < maxAttempts ? backoff : 0, attempt });
      if (attempt < maxAttempts) { await wait(backoff); continue; }
      return { ok: false, status: res.status, reason: lastReason };
    }

    // 4xx（非 429）是我们自己请求写错了，重试没有意义。
    // **不回显响应体** —— 错误详情可能带 requestId 之类的内部信息
    return { ok: false, status: res.status, reason: `请求被拒绝 HTTP ${res.status}` };
  }

  return { ok: false, status: lastStatus, reason: lastReason };
}

// ── ETag 持久化（复用 Setting 键值表，不新增 schema）─────────────────────

const ETAG_PREFIX = "aihot:etag:";

export async function loadEtag(endpointKey: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: `${ETAG_PREFIX}${endpointKey}` } });
  return row?.value ?? null;
}

export async function saveEtag(endpointKey: string, etag: string | null): Promise<void> {
  if (!etag) return;
  const key = `${ETAG_PREFIX}${endpointKey}`;
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: etag },
    update: { value: etag },
  });
}

// ── 端点封装 ──────────────────────────────────────────────────────────────

/** API 侧的上限，写死在这里免得调用方各猜一个 */
export const LIMITS = {
  /** /selected/snapshot 每页最多 1000 */
  snapshotPage: 1000,
  /** /selected/changes 每页最多 100 */
  changesPage: 100,
  /** /dailies 索引最多 180 天 */
  dailyIndex: 180,
  /** /items 每页最多 100 */
  itemsPage: 100,
} as const;

export const ENDPOINTS = {
  selectedRecent: (windowSpec: string, limit: number) =>
    ({ key: `items-selected-${windowSpec}-${limit}`, path: `/api/v1/items?mode=selected&window=${encodeURIComponent(windowSpec)}&limit=${limit}` }),
  /**
   * 全量同步的起点。分页用 `page`（不是 cursor）——
   * cursor 是**增量水位**，两者不是一回事，混用会让增量从错误的位置开始。
   */
  selectedSnapshot: (args: { limit: number; page?: string | null; fields?: "default" | "minimal" }) => {
    const qs = new URLSearchParams({ fields: args.fields ?? "default", limit: String(args.limit) });
    if (args.page) qs.set("page", args.page);
    // 分页请求不做条件请求：每页内容不同，共用一个 ETag 键只会互相顶掉
    return { key: `selected-snapshot`, path: `/api/v1/selected/snapshot?${qs.toString()}` };
  },
  /** 增量。cursor 必填，来自 snapshot 或上一页 changes */
  selectedChanges: (cursor: string, limit: number) =>
    ({ key: "selected-changes", path: `/api/v1/selected/changes?cursor=${encodeURIComponent(cursor)}&limit=${limit}` }),
  /** 未筛选的全量条目流。只覆盖最近 window，且没有增量契约 */
  itemsAll: (windowSpec: string, limit: number, cursor?: string | null) => {
    const qs = new URLSearchParams({ mode: "all", window: windowSpec, limit: String(limit) });
    if (cursor) qs.set("cursor", cursor);
    return { key: `items-all-${windowSpec}`, path: `/api/v1/items?${qs.toString()}` };
  },
  hotTopics: () => ({ key: "hot-topics", path: "/api/v1/hot-topics" }),
  /** publicId 必须来自 links.story 末段，**不得自行构造** */
  story: (publicId: string) =>
    ({ key: `story-${publicId}`, path: `/api/v1/stories/${encodeURIComponent(publicId)}` }),
  dailyLatest: () => ({ key: "dailies-latest", path: "/api/v1/dailies/latest" }),
  dailyIndex: (limit: number) => ({ key: `dailies-index-${limit}`, path: `/api/v1/dailies?limit=${limit}` }),
  dailyByDate: (date: string) => ({ key: `dailies-${date}`, path: `/api/v1/dailies/${date}` }),
} as const;

// ── 增量水位（cursor）持久化 ──────────────────────────────────────────────

const CURSOR_KEY = "aihot:selected-cursor";

/**
 * cursor 是**流水账水位**，不是会话票据：存几天也不会过期，
 * 客户端离线再上线仍能从同一位置续上。所以它必须落库，不能只放内存。
 */
export async function loadSelectedCursor(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: CURSOR_KEY } });
  return row?.value?.trim() || null;
}

export async function saveSelectedCursor(cursor: string | null): Promise<void> {
  if (!cursor) return;
  await prisma.setting.upsert({
    where: { key: CURSOR_KEY },
    create: { key: CURSOR_KEY, value: cursor },
    update: { value: cursor },
  });
}

export async function clearSelectedCursor(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: CURSOR_KEY } });
}
