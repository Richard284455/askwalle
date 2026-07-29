import { createHash } from "crypto";

/**
 * URL 规范化与去重键。
 *
 * 同一篇文章在订阅、分享链接、站内跳转里往往带着不同的跟踪参数，
 * 不归一化就会把同一篇文章反复记成新条目 —— 原始层一旦重复，
 * 上层的事件聚类和事实溯源都会跟着虚高。
 */

/** 跟踪参数：只影响归因统计，不影响指向的内容 */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^gbraid$/i,
  /^wbraid$/i,
  /^msclkid$/i,
  /^mc_(cid|eid)$/i,
  /^igshid$/i,
  /^ref$/i,
  /^referrer$/i,
  /^source$/i,
  /^_source$/i,
  /^spm$/i,
  /^scm$/i,
  /^from$/i,
  /^share_(source|token|medium)$/i,
  /^__twitter_impression$/i,
];

function isTracking(key: string): boolean {
  return TRACKING_PARAMS.some((re) => re.test(key));
}

export type NormalizedUrl = {
  /** 规范化后的绝对地址 */
  url: string;
  /** 去重键：规范化地址的 sha256 前 32 位 */
  hash: string;
};

/**
 * 规范化规则（保守优先——宁可少归一，也不要把两篇不同的文章合成一条）：
 *   - 协议与主机名转小写，去掉默认端口
 *   - 丢弃跟踪参数，其余查询参数按键排序
 *   - 去掉 fragment（#anchor 指向同一篇文档）
 *   - 去掉末尾斜杠（根路径除外）
 *
 * 刻意**不做**的：不去 www、不强制 https、不删 index.html —— 这些在不同站点上
 * 可能指向真正不同的页面。
 */
export function normalizeUrl(raw: string, base?: string): NormalizedUrl | null {
  let u: URL;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  if (
    (u.protocol === "http:" && u.port === "80") ||
    (u.protocol === "https:" && u.port === "443")
  ) {
    u.port = "";
  }
  u.hash = "";
  // 认证信息不该出现在存档地址里
  u.username = "";
  u.password = "";

  const params = [...u.searchParams.entries()].filter(([k]) => !isTracking(k));
  params.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  u.search = "";
  for (const [k, v] of params) u.searchParams.append(k, v);

  // 末尾斜杠要在 pathname 上剥，不能在序列化后的整串上剥 ——
  // 否则 /blog/x/?a=1 会保留斜杠而 /blog/x?a=1 不会，同一篇文章记成两条
  if (u.pathname !== "/" && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }

  const out = u.toString();
  return { url: out, hash: sha256Short(out) };
}

/** 内容指纹：识别「同一篇文章换了地址」，本阶段只记录不判定 */
export function contentHash(text: string): string {
  // 折叠空白再取哈希：同一篇文章重抓时缩进/换行常有细微差别
  return sha256Short(text.replace(/\s+/g, " ").trim());
}

function sha256Short(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}
