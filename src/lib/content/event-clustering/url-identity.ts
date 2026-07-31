import { parse } from "tldts";

/**
 * 文档身份。
 *
 * canonical 权重最高：它是页面**自己声明**的规范地址，比我们跟到哪里更可信。
 * final host 只是取回证据 —— 用它推断发布者会直接判错（DeepMind 的条目
 * 会落到 blog.google 与 cloud.google.com）。
 */

/** 与采集层同一份追踪参数清单 */
const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "gclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "igshid", "ref", "ref_src",
  "spm", "from",
];

export type DocumentIdentity = {
  canonicalIdentity: string | null;
  finalIdentity: string | null;
  registrableDomain: string | null;
  normalizedPath: string | null;
};

/**
 * 归一化成可比较的身份串。
 *
 * 刻意**不做**的两件事：
 * - 不把 http 和 https 合并。协议不同就是不同的地址，除非 canonical 明确统一；
 * - 不删除任何 path 片段。path 常常带语义（/blog/2026/... vs /blog/），
 *   自作主张地剥掉会把两篇不同的文章判成同一份文档。
 */
export function normalizeIdentity(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hash = "";
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.includes(key.toLowerCase())) url.searchParams.delete(key);
  }
  // query 稳定排序：参数顺序不该改变身份
  const entries = [...url.searchParams.entries()].sort(([a, av], [b, bv]) =>
    a === b ? av.localeCompare(bv) : a.localeCompare(b)
  );
  url.search = "";
  for (const [k, v] of entries) url.searchParams.append(k, v);

  const host = url.host.toLowerCase();
  // 末尾斜杠不构成身份差异，但 path 本身一律保留
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const search = url.search;
  return `${url.protocol}//${host}${path}${search}`;
}

export function registrableDomainOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = parse(new URL(raw).host);
    return parsed.domain ?? null;
  } catch {
    return null;
  }
}

export function computeDocumentIdentity(input: {
  canonicalUrl: string | null;
  finalUrl: string | null;
  requestedUrl: string | null;
}): DocumentIdentity {
  const canonicalIdentity = normalizeIdentity(input.canonicalUrl);
  const finalIdentity = normalizeIdentity(input.finalUrl) ?? normalizeIdentity(input.requestedUrl);
  // canonical 优先：页面自己声明的规范地址比我们跟到哪里更可信
  const primary = canonicalIdentity ?? finalIdentity;
  let normalizedPath: string | null = null;
  if (primary) {
    try {
      normalizedPath = new URL(primary).pathname;
    } catch {
      normalizedPath = null;
    }
  }
  return {
    canonicalIdentity,
    finalIdentity,
    registrableDomain: registrableDomainOf(primary),
    normalizedPath,
  };
}
