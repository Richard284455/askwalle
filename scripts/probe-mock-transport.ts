/**
 * 契约测试用的内存 fixture transport + resolver。
 *
 * 关键点：**不起真实 HTTP 服务，不建 TCP 连接**。
 *
 * 以前用本地 http server 跑在 127.0.0.1 上，为了让探针连得上，就得给 SSRF
 * 开一个「放行私网」的口子 —— 那意味着测试跑的不是生产那套校验。现在改成
 * 注入 transport：resolver 返回真实公网 IP，SSRF **完整地、按生产规则**跑一遍，
 * transport 再把请求映射到内存 fixture。测的就是生产代码本身。
 */
import http from "http";

import type { Transport, TransportArgs } from "../src/lib/website/probe/http-client";
import type { ResolveFn } from "../src/lib/website/probe/ssrf";

/** fixture 站点的对外主机名与「解析结果」——都是真实公网地址，不在任何禁止段内 */
export const MOCK_HOST = "mock-tools.example";
export const MOCK_ORIGIN = `https://${MOCK_HOST}`;
const MOCK_IP = "93.184.216.34";

export type Fixture = {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** HEAD 与 GET 行为不同时用 */
  head?: { status?: number; headers?: Record<string, string> };
  /** 服务器无视 Range，返回超大响应 */
  ignoresRange?: boolean;
};

const HTML_OK = `<!doctype html><html><head><title>Acme Writer</title></head><body>
<nav><a href="/pricing">Pricing</a><a href="/login">Login</a><a href="/docs">Docs</a>
<a href="/blog">Blog</a><a href="/about">About</a><a href="/contact">Contact</a><a href="/faq">FAQ</a></nav>
<h1>Acme Writer</h1>
<p>Acme Writer helps teams draft, edit and publish long form content with an assistant that
understands tone and structure. It integrates with the editors your team already uses and keeps
revisions in sync across everyone working on a document.</p>
<p>Start with a template, refine with suggestions, and export anywhere. Teams use it daily to keep
their publishing pipeline moving without extra overhead or manual formatting work.</p>
</body></html>`;

const SPA_SHELL = `<!doctype html><html><head><title>App</title></head><body>
<div id="root"></div><script src="/static/app.js"></script></body></html>`;

// 正常体积（>512B）但实为软 404 —— v1 会被 HEAD 短路掩盖，v2 必须抓到
const BIG_SOFT_404 = `<!doctype html><html><head><title>404 Not Found</title></head><body>
<h1>404</h1>
${"<p>The page you are looking for is no longer available. Browse our catalogue instead.</p>".repeat(6)}
</body></html>`;

// 正常体积的正常页面，含 parked 关键词但应被 E1 排除
const BIG_PARKED_EXCLUDED = `<!doctype html><html><head><title>Acme</title></head><body>
<p>buy this domain</p>
${"<p>We also publish a lot of genuine articles about writing and editing workflows every week.</p>".repeat(25)}
</body></html>`;

export const FIXTURES: Record<string, Fixture> = {
  // 跨域跳转的落地页（品牌迁移场景用）
  "/": { body: HTML_OK },
  "/ok": { body: HTML_OK },
  "/spa": { body: SPA_SHELL },
  "/pdf": { body: "%PDF-1.4 fake", headers: { "content-type": "application/pdf" } },

  "/404": { status: 404, body: "<html><body><h1>Not Found</h1></body></html>" },
  "/410": { status: 410, body: "gone" },
  "/500": { status: 500, body: "server error" },
  "/503-plain": { status: 503, body: "unavailable" },
  "/503-retry": { status: 503, headers: { "retry-after": "120" }, body: "unavailable" },
  "/429": { status: 429, headers: { "retry-after": "3600" }, body: "slow down" },
  "/429-bare": { status: 429, body: "slow down" },
  "/451": { status: 451, body: "unavailable for legal reasons" },

  "/head-405": { body: HTML_OK, head: { status: 405 } },
  "/head-403": { body: HTML_OK, head: { status: 403 } },
  "/head-404": { body: HTML_OK, head: { status: 404 } },
  "/head-tiny": { body: HTML_OK, head: { headers: { "content-length": "120" } } },

  "/soft404-title": {
    body: `<!doctype html><html><head><title>404 Not Found</title></head><body>
<p>Sorry, we could not locate that resource.</p></body></html>`,
  },
  "/soft404-h1": {
    body: `<!doctype html><html><head><title>Acme</title></head><body>
<h1>页面不存在</h1><p>请返回首页继续浏览。</p></body></html>`,
  },
  "/soft404-body": {
    body: `<!doctype html><html><head><title>Acme</title></head><body>
<p>您访问的页面不存在，可能已被删除。</p><a href="/">首页</a></body></html>`,
  },
  "/soft404-long": {
    body: `<!doctype html><html><head><title>404 Not Found</title></head><body>
<h1>Acme Writer</h1>${"<p>Real content paragraph that makes this page substantial and clearly alive.</p>".repeat(30)}
</body></html>`,
  },
  // ★ v2 的核心用例：正常体积的软 404
  "/big-soft404": { body: BIG_SOFT_404 },
  "/big-parked-excluded": { body: BIG_PARKED_EXCLUDED },

  "/notfound-in-script": {
    body: `<!doctype html><html><head><title>Acme</title></head><body>
<script>var msg = "page not found";</script>${HTML_OK}</body></html>`,
  },
  "/notfound-in-comment": {
    body: `<!doctype html><html><head><title>Acme</title></head><body>
<!-- page not found -->${HTML_OK}</body></html>`,
  },
  "/notfound-in-alt": {
    body: `<!doctype html><html><head><title>Acme</title></head><body>
<img alt="page not found" src="/x.png">${HTML_OK}</body></html>`,
  },

  "/parked-en": {
    body: `<!doctype html><html><head><title>domain.com</title></head><body>
<p>This domain is for sale. Inquire now.</p></body></html>`,
  },
  "/parked-cn": {
    body: `<!doctype html><html><head><title>domain.com</title></head><body>
<p>该域名待售，欢迎联系。</p></body></html>`,
  },
  "/parked-manylinks": {
    body: `<!doctype html><html><head><title>Acme</title></head><body>
<p>domain for sale</p><nav>${Array.from({ length: 12 }, (_, i) => `<a href="/p${i}">Page ${i}</a>`).join("")}</nav>
</body></html>`,
  },
  "/coming-soon": {
    body: `<!doctype html><html><head><title>Acme</title></head><body>
<p>Coming soon. We are under construction.</p></body></html>`,
  },
  "/parked-brand": {
    body: `<!doctype html><html><head><title>Acme Writer</title></head><body>
<h1>Acme Writer</h1><p>this domain is for sale</p></body></html>`,
  },

  "/split-buy-domain": {
    body: `<!doctype html><html><head><title>x</title></head><body>
<div>Buy</div><div>this domain now</div></body></html>`,
  },
  "/split-not-found": {
    body: `<!doctype html><html><head><title>x</title></head><body>
<li>Not</li><li>found here on this page somewhere</li></body></html>`,
  },
  "/split-cn": {
    body: `<!doctype html><html><head><title>x</title></head><body>
<p>此域</p><p>名待售</p></body></html>`,
  },
  "/inblock-buy-domain": {
    body: `<!doctype html><html><head><title>x</title></head><body>
<div>Buy this domain today</div></body></html>`,
  },
  "/mixed-split-and-inblock": {
    body: `<!doctype html><html><head><title>x</title></head><body>
<div>Buy</div><div>this domain now</div><div>buy this domain</div></body></html>`,
  },

  "/cf-challenge": {
    status: 403,
    headers: { "cf-mitigated": "challenge", "cf-ray": "abc123" },
    body: "<html><body>Checking your browser</body></html>",
  },
  "/verify-human": {
    status: 403,
    body: "<html><body><p>Please verify you are human to continue.</p></body></html>",
  },

  "/robots-disallowed/page": { body: HTML_OK },
  "/robots-delay/page": { body: HTML_OK },
  "/huge": { body: HTML_OK, ignoresRange: true, head: { headers: { "content-length": "200" } } },
};

export type MockControl = {
  transport: Transport;
  resolve: ResolveFn;
  log: { method: string; path: string; host: string }[];
  reset: () => void;
  setRobots: (mode: "allow" | "disallow" | "500" | "delay") => void;
};

export function createMockTransport(): MockControl {
  const log: { method: string; path: string; host: string }[] = [];
  let robotsMode: "allow" | "disallow" | "500" | "delay" = "allow";

  const respond = (
    status: number,
    headers: Record<string, string>,
    body: string,
    wantBody: boolean,
    ignoresRange = false
  ) => {
    const payload = ignoresRange && wantBody ? body.repeat(4000) : body;
    const buffer = wantBody ? Buffer.from(payload, "utf8") : Buffer.alloc(0);
    // 服务器无视 Range 时，客户端会在 hardAbortBytes 处截断
    const HARD_ABORT = 262_144;
    const RANGE = 65_536;
    const truncated = wantBody && buffer.length >= RANGE;
    return {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(Buffer.byteLength(payload)),
        ...headers,
      } as http.IncomingHttpHeaders,
      buffer: buffer.subarray(0, HARD_ABORT),
      truncated,
    };
  };

  const transport: Transport = async (args: TransportArgs) => {
    const { url, method, wantBody } = args;
    const path = url.pathname;
    log.push({ method, path, host: url.host });

    if (path === "/robots.txt") {
      if (robotsMode === "500") return respond(500, {}, "boom", wantBody);
      const body =
        robotsMode === "disallow"
          ? "User-agent: *\nDisallow: /\n"
          : robotsMode === "delay"
            ? "User-agent: *\nCrawl-delay: 60\n"
            : "User-agent: *\nDisallow:\n";
      return respond(200, { "content-type": "text/plain" }, body, wantBody);
    }

    // 重定向族
    if (path.startsWith("/redir/")) {
      const n = Number(path.split("/")[2] ?? "0");
      if (n >= 8) return respond(200, {}, HTML_OK, wantBody);
      return respond(302, { location: `/redir/${n + 1}` }, "", wantBody);
    }
    if (path === "/loop-a") return respond(302, { location: "/loop-b" }, "", wantBody);
    if (path === "/loop-b") return respond(302, { location: "/loop-a" }, "", wantBody);
    if (path === "/redir-metadata") {
      return respond(302, { location: "http://169.254.169.254/" }, "", wantBody);
    }
    if (path === "/redir-private") {
      return respond(302, { location: "http://192.168.1.1/" }, "", wantBody);
    }
    if (path === "/redir-cross-brand") {
      return respond(302, { location: "https://new-brand.example/" }, "", wantBody);
    }

    const fixture = FIXTURES[path];
    if (!fixture) return respond(404, {}, "no fixture", wantBody);

    if (method === "HEAD" && fixture.head) {
      return respond(
        fixture.head.status ?? 200,
        fixture.head.headers ?? {},
        fixture.body ?? "",
        false
      );
    }
    return respond(
      fixture.status ?? 200,
      fixture.headers ?? {},
      fixture.body ?? "",
      wantBody,
      fixture.ignoresRange
    );
  };

  // 所有 fixture 主机都解析到同一个真实公网地址 —— SSRF 会照常放行，
  // 但没有任何数据包真的发出去（transport 直接返回内存 fixture）
  const resolve: ResolveFn = async () => [MOCK_IP];

  return {
    transport,
    resolve,
    log,
    reset: () => {
      log.length = 0;
    },
    setRobots: (mode) => {
      robotsMode = mode;
    },
  };
}
