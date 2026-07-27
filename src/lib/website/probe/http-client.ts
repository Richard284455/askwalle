import http from "http";
import https from "https";
import { gunzipSync, inflateSync } from "zlib";

import { assertSafeUrl, ResolveFn, SafetyOptions, SafetyVerdict } from "./ssrf";

/**
 * 探针专用 HTTP 客户端。
 *
 * 刻意不用全局 fetch：Next 会给 fetch 打补丁，且 undici 在建连时会自己再解析一次
 * DNS —— 那就等于把契约 §5.4 的连接固定作废了，rebinding 攻击的窗口重新打开。
 * 这里用 node:https 的 `lookup` 钩子把地址钉死，Host 头与 TLS SNI 仍用原主机名。
 *
 * 另外三条硬约束：不发 Cookie、不发认证头、不保存完整正文。
 */

export const USER_AGENT = "AskWalleBot/1.0 (+https://askwalle.com/bot)";

export const LIMITS = {
  rangeBytes: 65_536, // GET 只要前 64KB
  hardAbortBytes: 262_144, // 服务器忽略 Range 时的兜底
  decompressedMax: 1_048_576, // 压缩炸弹防护
  headerTimeoutMs: 8_000,
  totalTimeoutMs: 15_000,
  maxRedirects: 5,
} as const;

export type RedirectHop = {
  hop: number;
  status: number;
  location: string | null;
  host: string;
  resolvedIp: string | null;
  ssrfOk: boolean;
};

export type NetworkErrorKind = "dns" | "timeout" | "tls" | "connection";

export type FetchResult =
  | {
      kind: "response";
      status: number;
      headers: Record<string, string>;
      body: string | null;
      bytesRead: number;
      truncated: boolean;
      finalUrl: string;
      redirectChain: RedirectHop[];
      pinnedIp: string;
      resolvedIps: string[];
      latencyMs: number;
    }
  | {
      kind: "network_error";
      errorKind: NetworkErrorKind;
      code: string;
      message: string;
      redirectChain: RedirectHop[];
      latencyMs: number;
    }
  | {
      kind: "unsafe";
      verdict: Extract<SafetyVerdict, { safe: false }>;
      atHop: number;
      redirectChain: RedirectHop[];
    }
  | {
      kind: "redirect_loop";
      redirectChain: RedirectHop[];
      latencyMs: number;
    };

// 只保留判定与取证需要的响应头，不整包存
const KEPT_HEADERS = [
  "server",
  "content-type",
  "content-length",
  "retry-after",
  "location",
  "cf-ray",
  "cf-mitigated",
  "cf-cache-status",
  "x-parking-provider",
  "x-served-by",
  "content-encoding",
];

function pickHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of KEPT_HEADERS) {
    const value = raw[key];
    if (typeof value === "string") out[key] = value.slice(0, 300);
    else if (Array.isArray(value)) out[key] = value.join(", ").slice(0, 300);
  }
  return out;
}

function classifyNetworkError(error: NodeJS.ErrnoException): {
  errorKind: NetworkErrorKind;
  code: string;
} {
  const code = error.code ?? error.name ?? "UNKNOWN";
  if (
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ENODATA" ||
    code === "ESERVFAIL"
  ) {
    return { errorKind: "dns", code };
  }
  if (
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "ABORT_ERR"
  ) {
    return { errorKind: "timeout", code };
  }
  if (
    code.startsWith("ERR_TLS") ||
    code.startsWith("ERR_SSL") ||
    code === "CERT_HAS_EXPIRED" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    code === "EPROTO"
  ) {
    return { errorKind: "tls", code };
  }
  return { errorKind: "connection", code };
}

function decodeBody(
  buffer: Buffer,
  encoding: string | undefined,
  truncated: boolean
): string | null {
  let raw = buffer;
  if (encoding && /gzip|deflate/i.test(encoding)) {
    // 截断的压缩流解不开，这属于正常情况，不当错误
    if (truncated) return null;
    try {
      raw = /gzip/i.test(encoding) ? gunzipSync(buffer) : inflateSync(buffer);
    } catch {
      return null;
    }
    if (raw.length > LIMITS.decompressedMax) {
      raw = raw.subarray(0, LIMITS.decompressedMax);
    }
  }
  return raw.toString("utf8");
}

type SingleRequestArgs = {
  method: "HEAD" | "GET";
  url: URL;
  pinnedIp: string;
  wantBody: boolean;
  signalDeadline: number;
};

function singleRequest(args: SingleRequestArgs): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  buffer: Buffer;
  truncated: boolean;
}> {
  const { method, url, pinnedIp, wantBody, signalDeadline } = args;
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      "accept-encoding": "gzip, deflate", // 不要 br：解压体积不可控
      // 显式 Host：连的是 IP，主机名只能靠这个头传递
      host: url.host,
    };
    if (wantBody) headers.range = `bytes=0-${LIMITS.rangeBytes - 1}`;

    const request = transport.request(
      {
        method,
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers,
        // ★ 连接固定：强制把解析结果替换成已校验的 IP，
        //   运行时不会再发生第二次 DNS 解析
        lookup: (_hostname, _options, callback) => {
          const family = pinnedIp.includes(":") ? 6 : 4;
          (callback as (e: Error | null, a: string, f: number) => void)(
            null,
            pinnedIp,
            family
          );
        },
        // SNI 用原主机名，否则 TLS 握手会失败
        servername: url.hostname.replace(/^\[|\]$/g, ""),
        setHost: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;

        if (!wantBody) {
          response.resume();
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              buffer: Buffer.alloc(0),
              truncated: false,
            })
          );
          return;
        }

        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > LIMITS.hardAbortBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, chunk.length - (bytes - LIMITS.hardAbortBytes)));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("close", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            buffer: Buffer.concat(chunks),
            truncated: truncated || bytes >= LIMITS.rangeBytes,
          })
        );
        response.on("error", reject);
      }
    );

    request.setTimeout(Math.max(1_000, signalDeadline - Date.now()), () => {
      request.destroy(Object.assign(new Error("request timeout"), { code: "ETIMEDOUT" }));
    });
    request.on("error", reject);
    request.end();
  });
}

/**
 * 带 SSRF 校验与连接固定的取回。每一跳重定向都重新校验 + 重新固定。
 */
export async function safeFetch(
  startUrl: string,
  options: { method: "HEAD" | "GET"; resolve?: ResolveFn; safety?: SafetyOptions }
): Promise<FetchResult> {
  const started = Date.now();
  const deadline = started + LIMITS.totalTimeoutMs;
  const redirectChain: RedirectHop[] = [];
  const seen = new Set<string>();

  let currentUrl = startUrl;
  let lastPinned = "";
  let lastResolved: string[] = [];

  for (let hop = 0; hop <= LIMITS.maxRedirects; hop++) {
    // ★ 每一跳都重跑安全校验，同域跳转也不例外
    const verdict = await assertSafeUrl(currentUrl, options.resolve, options.safety);
    if (!verdict.safe) {
      return { kind: "unsafe", verdict, atHop: hop, redirectChain };
    }
    lastPinned = verdict.pinnedIp;
    lastResolved = verdict.addresses;

    const url = new URL(currentUrl);
    const dedupeKey = `${url.origin}${url.pathname}${url.search}`;
    if (seen.has(dedupeKey)) {
      return { kind: "redirect_loop", redirectChain, latencyMs: Date.now() - started };
    }
    seen.add(dedupeKey);

    let response: Awaited<ReturnType<typeof singleRequest>>;
    try {
      response = await singleRequest({
        method: options.method,
        url,
        pinnedIp: verdict.pinnedIp,
        wantBody: options.method === "GET",
        signalDeadline: deadline,
      });
    } catch (error) {
      const { errorKind, code } = classifyNetworkError(error as NodeJS.ErrnoException);
      return {
        kind: "network_error",
        errorKind,
        code,
        message: (error as Error).message?.slice(0, 300) ?? "",
        redirectChain,
        latencyMs: Date.now() - started,
      };
    }

    const headers = pickHeaders(response.headers);
    const isRedirect =
      response.status >= 300 && response.status < 400 && Boolean(response.headers.location);

    redirectChain.push({
      hop,
      status: response.status,
      location: isRedirect ? String(response.headers.location).slice(0, 500) : null,
      host: url.host,
      resolvedIp: verdict.pinnedIp,
      ssrfOk: true,
    });

    if (!isRedirect) {
      return {
        kind: "response",
        status: response.status,
        headers,
        body:
          options.method === "GET"
            ? decodeBody(
                response.buffer,
                response.headers["content-encoding"],
                response.truncated
              )
            : null,
        bytesRead: response.buffer.length,
        truncated: response.truncated,
        finalUrl: currentUrl,
        redirectChain,
        pinnedIp: verdict.pinnedIp,
        resolvedIps: verdict.addresses,
        latencyMs: Date.now() - started,
      };
    }

    try {
      currentUrl = new URL(String(response.headers.location), currentUrl).toString();
    } catch {
      return {
        kind: "unsafe",
        verdict: { safe: false, reason: "url_unparsable", detail: "bad Location" },
        atHop: hop,
        redirectChain,
      };
    }
    if (Date.now() > deadline) {
      return { kind: "redirect_loop", redirectChain, latencyMs: Date.now() - started };
    }
  }

  // 跳数用尽
  void lastPinned;
  void lastResolved;
  return { kind: "redirect_loop", redirectChain, latencyMs: Date.now() - started };
}
