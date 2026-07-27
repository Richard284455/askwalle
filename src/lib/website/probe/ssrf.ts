import { isIP } from "net";
import { promises as dns } from "dns";

import { hostInfo } from "./registrable-domain";

/**
 * SSRF 防护（契约 §5）。
 *
 * 最关键的一条不是黑名单，而是 §5.4 的「连接固定」：先解析拿到全部地址、逐个
 * 校验、再把连接钉死在校验过的那个 IP 上。只做校验不做固定的话，DNS rebinding
 * （TTL=0，第二次解析返回 127.0.0.1）能在校验和连接之间的缝隙里把我们带进内网。
 */

export const ALLOWED_PROTOCOLS = ["http:", "https:"];
export const ALLOWED_PORTS = [80, 443];

export type UnsafeReason =
  | "protocol_not_allowed"
  | "port_not_allowed"
  | "url_unparsable"
  | "userinfo_in_url"
  | "hostname_not_allowed"
  | "private_ip"
  | "metadata_endpoint"
  | "dns_no_address"
  | "dns_error";

export type SafetyVerdict =
  | { safe: true; hostname: string; port: number; addresses: string[]; pinnedIp: string }
  | { safe: false; reason: UnsafeReason; detail: string };

// 云元数据端点：显式硬拒，不依赖网段推导。
// 169.254/16 本就在禁止段内，这里重复列出是为了让证据里的 reason 更准确。
const METADATA_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.com",
  "instance-data",
]);
const METADATA_IPS = new Set(["169.254.169.254", "fd00:ec2::254", "100.100.100.200"]);

// 主机名黑名单后缀
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".home.arpa",
  ".lan",
];
const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

type V4Range = { base: number; bits: number };

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

function range(cidr: string): V4Range {
  const [base, bits] = cidr.split("/");
  return { base: v4ToInt(base)!, bits: Number(bits) };
}

// 契约 §5.2 IPv4 禁止段
const BLOCKED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "100.100.100.0/24", // 阿里云元数据段
].map(range);

function isBlockedV4(ip: string): boolean {
  const value = v4ToInt(ip);
  if (value === null) return true; // 解析不出来一律当危险
  if (value === 0xffffffff) return true; // 255.255.255.255
  for (const { base, bits } of BLOCKED_V4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (base & mask) >>> 0) return true;
  }
  return false;
}

function expandV6(ip: string): string[] | null {
  const zoneless = ip.split("%")[0];
  const halves = zoneless.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 && fill < 0) return null;
  const groups =
    halves.length === 2
      ? [...head, ...Array(fill).fill("0"), ...tail]
      : head;
  if (groups.length !== 8) return null;
  return groups.map((g) => (g === "" ? "0" : g));
}

/** IPv4-mapped / NAT64 必须解映射后按 IPv4 规则重查，否则 ::ffff:127.0.0.1 会漏网 */
function unmapV6(ip: string): string | null {
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return mapped[1];
  const groups = expandV6(lower);
  if (!groups) return null;
  const hex = groups.map((g) => parseInt(g, 16));
  // ::ffff:a.b.c.d 的十六进制写法
  if (hex.slice(0, 5).every((h) => h === 0) && hex[5] === 0xffff) {
    return `${hex[6] >> 8}.${hex[6] & 0xff}.${hex[7] >> 8}.${hex[7] & 0xff}`;
  }
  // 64:ff9b::/96 NAT64
  if (hex[0] === 0x64 && hex[1] === 0xff9b && hex.slice(2, 6).every((h) => h === 0)) {
    return `${hex[6] >> 8}.${hex[6] & 0xff}.${hex[7] >> 8}.${hex[7] & 0xff}`;
  }
  return null;
}

function isBlockedV6(ip: string): boolean {
  const unmapped = unmapV6(ip);
  if (unmapped) return isBlockedV4(unmapped);

  const groups = expandV6(ip.toLowerCase());
  if (!groups) return true;
  const hex = groups.map((g) => parseInt(g, 16));
  if (hex.some((h) => Number.isNaN(h))) return true;

  if (hex.every((h) => h === 0)) return true; // ::
  if (hex.slice(0, 7).every((h) => h === 0) && hex[7] === 1) return true; // ::1
  if ((hex[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((hex[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((hex[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (hex[0] === 0x2001 && hex[1] === 0x0db8) return true; // 2001:db8::/32
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  if (METADATA_IPS.has(ip.toLowerCase())) return true;
  const family = isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true;
}

export function isMetadataAddress(ip: string): boolean {
  if (METADATA_IPS.has(ip.toLowerCase())) return true;
  const unmapped = isIP(ip) === 6 ? unmapV6(ip) : null;
  return unmapped ? METADATA_IPS.has(unmapped) : false;
}

function hostnameBlocked(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(lower)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  if (METADATA_HOSTNAMES.has(lower)) return true;
  // 无点裸主机名（intranet / router），IP 字面量除外
  if (!lower.includes(".") && isIP(lower) === 0) return true;
  return false;
}

export type ResolveFn = (hostname: string) => Promise<string[]>;

/** 默认解析器：同时取 A 与 AAAA，任一段命中黑名单即整体拒绝 */
export const defaultResolve: ResolveFn = async (hostname) => {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

/**
 * URL 安全校验 + 地址固定。
 *
 * 每一跳重定向都必须重跑本函数（契约 §5.4），包括同域跳转。
 */
export type SafetyOptions = {
  /**
   * **仅供契约测试**：放行私网/回环地址，让测试能连本地 mock。
   *
   * 生产路径从不传这个参数 —— probeReachability / runHealthCheckRound 都没有
   * 对应入口，只有 scripts/probe-contract-tests.ts 显式传 true。契约测试里有一条
   * 专门断言「默认参数下 127.0.0.1 会被拒」（T52），确保这个开关没有把规则改松。
   *
   * 刻意不做成环境变量：环境变量会在生产里被意外设上，函数参数不会。
   */
  allowPrivateAddresses?: boolean;
};

export async function assertSafeUrl(
  rawUrl: string,
  resolve: ResolveFn = defaultResolve,
  options: SafetyOptions = {}
): Promise<SafetyVerdict> {
  const allowPrivate = options.allowPrivateAddresses === true;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "url_unparsable", detail: rawUrl.slice(0, 200) };
  }

  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    return { safe: false, reason: "protocol_not_allowed", detail: url.protocol };
  }
  if (url.username || url.password) {
    return { safe: false, reason: "userinfo_in_url", detail: "URL 含 user:pass@" };
  }

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  // 测试模式下 mock 跑在随机高位端口，一并放开；生产仍只允许 80/443
  if (!allowPrivate && !ALLOWED_PORTS.includes(port)) {
    return { safe: false, reason: "port_not_allowed", detail: String(port) };
  }

  // URL 会把 IPv6 主机包在方括号里
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && hostnameBlocked(hostname)) {
    return { safe: false, reason: "hostname_not_allowed", detail: hostname };
  }

  // punycode 归一化后再看一次（URL 构造时已做，这里防御 tldts 解析异常）
  const info = hostInfo(hostname);

  if (info.isIp || isIP(hostname) !== 0) {
    // 元数据端点即使在测试模式下也绝不放行
    if (isMetadataAddress(hostname)) {
      return { safe: false, reason: "metadata_endpoint", detail: hostname };
    }
    if (!allowPrivate && isBlockedAddress(hostname)) {
      return { safe: false, reason: "private_ip", detail: hostname };
    }
    return { safe: true, hostname, port, addresses: [hostname], pinnedIp: hostname };
  }

  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch (error) {
    return {
      safe: false,
      reason: "dns_error",
      detail: error instanceof Error ? error.message.slice(0, 200) : "resolve failed",
    };
  }
  if (!addresses.length) {
    return { safe: false, reason: "dns_no_address", detail: hostname };
  }

  // 契约 §5.4 第 2 步：任意一个地址落在禁止段即整体拒绝。
  // 不能只看第一个 —— 轮询 DNS 可能先给公网 IP，再给内网 IP。
  for (const address of addresses) {
    if (isMetadataAddress(address)) {
      return { safe: false, reason: "metadata_endpoint", detail: address };
    }
    if (!allowPrivate && isBlockedAddress(address)) {
      return { safe: false, reason: "private_ip", detail: address };
    }
  }

  return { safe: true, hostname, port, addresses, pinnedIp: addresses[0] };
}
