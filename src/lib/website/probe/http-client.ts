import http from "http";
import https from "https";
import { constants, gunzipSync, inflateSync, inflateRawSync } from "zlib";

import { assertSafeUrl, ResolveFn, UnsafeVerdict } from "./ssrf";

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
  // Node 默认 16KB。Gemini 的响应头就有 24KB，超限时抛 HPE_HEADER_OVERFLOW，
  // v3 把它记成 timeout —— 活站被推向 dead，且每轮必现，消抖挡不住。
  maxHeaderSize: 65_536,
} as const;

export type RedirectHop = {
  hop: number;
  status: number;
  location: string | null;
  host: string;
  resolvedIp: string | null;
  ssrfOk: boolean;
};

/**
 * `internal` 是探针**客户端自身**的缺陷（参数错、不变量被破坏），
 * 与站点无关，绝不能记成生命周期失败。A8 Canary 的教训：
 * ERR_INVALID_IP_ADDRESS 被归成 connection→timeout，20 个活站全被记了一次假失败。
 */
export type NetworkErrorKind = "dns" | "timeout" | "tls" | "connection" | "internal";

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
      verdict: UnsafeVerdict;
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

// 客户端内部错误：我们自己写错了，不是对方站点的问题
const INTERNAL_ERROR_CODES = new Set([
  "ERR_INVALID_IP_ADDRESS",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "ERR_INVALID_URL",
  "ERR_INVALID_HTTP_TOKEN",
  "ERR_HTTP_INVALID_HEADER_VALUE",
  "ERR_INVALID_CHAR",
  "ERR_ASSERTION",
]);

export function classifyNetworkError(error: NodeJS.ErrnoException): {
  errorKind: NetworkErrorKind;
  code: string;
} {
  const code = error.code ?? error.name ?? "UNKNOWN";
  // 先判内部错误：这类必须与「站点不可达」彻底分开。
  // HPE_* 是 Node HTTP 解析器的自身上限（头过大、块过大…），
  // 站点可能完全健康，绝不能算成 network 失败。
  if (
    INTERNAL_ERROR_CODES.has(code) ||
    code.startsWith("HPE_") ||
    error instanceof TypeError ||
    error instanceof RangeError ||
    code === "TypeError" ||
    code === "RangeError"
  ) {
    return { errorKind: "internal", code };
  }
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

/**
 * 容忍截断的解压。
 *
 * GET 只取前 64KB，压缩流因此几乎总是不完整的。默认 finishFlush 遇到不完整的流
 * 会抛 Z_BUF_ERROR —— v3 里 Grammarly / Cursor / ElevenLabs 这类重点工具的正文
 * 全部因此判成 undecodable，内容分类整体空转。Z_SYNC_FLUSH 的语义正是
 * 「解出多少算多少」，这才是我们要的。
 *
 * maxOutputLength 把单次分配钉在 1MB，压缩炸弹撑不爆内存；真超限时折半重试 ——
 * 压缩流的前缀解出来就是正文的前缀，而分类只需要前缀。
 */
function inflateTruncated(buffer: Buffer, gzip: boolean): Buffer | null {
  const options = {
    finishFlush: constants.Z_SYNC_FLUSH,
    maxOutputLength: LIMITS.decompressedMax,
  } as const;

  let input = buffer;
  for (let attempt = 0; attempt < 6 && input.length > 0; attempt++) {
    try {
      if (gzip) return gunzipSync(input, options);
      // deflate 有带 zlib 头和裸流两种发法，标准没规定清楚，两种都试
      try {
        return inflateSync(input, options);
      } catch {
        return inflateRawSync(input, options);
      }
    } catch (error) {
      // 只有「输出超过 1MB」值得折半重试；流本身坏了再试也没用
      if ((error as NodeJS.ErrnoException).code !== "ERR_BUFFER_TOO_LARGE") return null;
      input = input.subarray(0, Math.floor(input.length / 2));
    }
  }
  return null;
}

function decodeBody(buffer: Buffer, encoding: string | undefined): string | null {
  let raw = buffer;
  if (encoding && /gzip|deflate/i.test(encoding)) {
    const inflated = inflateTruncated(buffer, /gzip/i.test(encoding));
    if (!inflated) return null;
    raw = inflated;
  }
  if (raw.length > LIMITS.decompressedMax) {
    raw = raw.subarray(0, LIMITS.decompressedMax);
  }
  return raw.toString("utf8");
}

export type TransportArgs = {
  method: "HEAD" | "GET";
  url: URL;
  /** 已通过 SSRF 校验、连接必须钉死的地址 */
  pinnedIp: string;
  wantBody: boolean;
  signalDeadline: number;
};

export type TransportResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  buffer: Buffer;
  truncated: boolean;
};

/**
 * 网络传输层。抽成接口是为了让契约测试能注入内存 fixture ——
 * 测试因此可以跑**完整的生产 SSRF 校验**（解析器返回真实公网 IP），
 * 而不需要任何「放行私网」的开关，也不需要真的建 TCP 连接。
 */
export type Transport = (args: TransportArgs) => Promise<TransportResponse>;

export const nodeTransport: Transport = (args) => {
  const { method, url, pinnedIp, wantBody, signalDeadline } = args;
  const transport = url.protocol === "https:" ? https : http;
  const family = pinnedIp.includes(":") ? 6 : 4;

  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      "accept-encoding": "gzip, deflate", // 不要 br：解压体积不可控
      // 显式 Host：连的是 IP，主机名只能靠这个头传递
      host: url.host,
    };
    if (wantBody) headers.range = `bytes=0-${LIMITS.rangeBytes - 1}`;

    // autoSelectFamily / family / lookup 会透传给 net.connect，
    // 但 @types/node 没把它们放进 RequestOptions，只能显式断言
    const requestOptions = {
      method,
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers,
      // ★ 连接固定：把解析结果强制换成已校验的 IP，运行时不再发生第二次 DNS 解析。
      //
      // 回调形态必须按 options.all 分支。Node 20 起 autoSelectFamily 默认开启，
      // net.connect 会以 { all: true } 调用自定义 lookup 并期望**地址数组**；
      // 只回三元组会让 Node 读到 addresses[0].address = undefined，
      // 报 ERR_INVALID_IP_ADDRESS —— A8 Canary 20/20 全废就是栽在这里。
      lookup: (_hostname: string, options: unknown, callback: unknown) => {
        if ((options as { all?: boolean } | undefined)?.all) {
          (callback as unknown as (
            e: Error | null,
            a: { address: string; family: number }[]
          ) => void)(null, [{ address: pinnedIp, family }]);
        } else {
          (callback as unknown as (e: Error | null, a: string, f: number) => void)(
            null,
            pinnedIp,
            family
          );
        }
      },
      // 关掉 Happy Eyeballs：它会并行尝试多个地址，与「只连已校验的那一个」冲突。
      // 我们只给一个地址，关掉它是为了让语义确定，而不是依赖「碰巧只有一个」。
      autoSelectFamily: false,
      // 只允许连我们钉死的那一族，避免 Node 因 family 不符再去解析
      family,
      // 大站的响应头常常超过 Node 默认的 16KB（Gemini 就有 24KB）
      maxHeaderSize: LIMITS.maxHeaderSize,
      // SNI 用原主机名，否则 TLS 握手会失败
      servername: url.hostname.replace(/^\[|\]$/g, ""),
      setHost: false,
    } as unknown as https.RequestOptions;

    const request = transport.request(requestOptions, (response) => {
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
    });

    request.setTimeout(Math.max(1_000, signalDeadline - Date.now()), () => {
      request.destroy(Object.assign(new Error("request timeout"), { code: "ETIMEDOUT" }));
    });
    request.on("error", reject);
    request.end();
  });
};

/**
 * 带 SSRF 校验与连接固定的取回。每一跳重定向都重新校验 + 重新固定。
 */
export async function safeFetch(
  startUrl: string,
  options: { method: "HEAD" | "GET"; resolve?: ResolveFn; transport?: Transport }
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
    const verdict = await assertSafeUrl(currentUrl, options.resolve);
    if (!verdict.safe) {
      // 解析失败是站点侧信号，必须走 network_error/dns，让它计入 dead 消抖；
      // 只有真正的安全拒绝才是 unsafe_target。主请求与 robots 共用这一条规则。
      if (verdict.kind === "dns") {
        return {
          kind: "network_error",
          errorKind: "dns",
          code: verdict.code,
          message: verdict.detail,
          redirectChain,
          latencyMs: Date.now() - started,
        };
      }
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

    let response: TransportResponse;
    try {
      response = await (options.transport ?? nodeTransport)({
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
            ? decodeBody(response.buffer, response.headers["content-encoding"])
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
        verdict: { safe: false, kind: "unsafe", reason: "url_unparsable", detail: "bad Location" },
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
