/**
 * 契约测试用的本地 mock 站点。零依赖，不访问任何真实工具。
 *
 * 路由按契约测试矩阵 T01–T50 的场景设计；每个路径对应一个可复现的 fixture。
 */
import http from "http";
import { AddressInfo } from "net";

export type MockServer = {
  port: number;
  origin: string;
  close: () => Promise<void>;
  /** 记录收到的请求，供「零主请求」类断言使用 */
  log: { method: string; path: string }[];
  reset: () => void;
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

const bodies: Record<string, { status?: number; headers?: Record<string, string>; body?: string }> = {
  // ── 正常 ──
  "/ok": { body: HTML_OK },
  "/ok-small": { body: HTML_OK, headers: { "content-length-lie": "1" } },
  "/spa": { body: SPA_SHELL },
  "/pdf": { body: "%PDF-1.4 fake", headers: { "content-type": "application/pdf" } },

  // ── 状态码 ──
  "/404": { status: 404, body: "<html><body><h1>Not Found</h1></body></html>" },
  "/410": { status: 410, body: "gone" },
  "/500": { status: 500, body: "server error" },
  "/503-plain": { status: 503, body: "unavailable" },
  "/503-retry": { status: 503, headers: { "retry-after": "120" }, body: "unavailable" },
  "/429": { status: 429, headers: { "retry-after": "3600" }, body: "slow down" },
  "/429-bare": { status: 429, body: "slow down" },
  "/451": { status: 451, body: "unavailable for legal reasons" },

  // ── soft 404 ──
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

  // ── parked ──
  "/parked-en": {
    body: `<!doctype html><html><head><title>domain.com</title></head><body>
<p>This domain is for sale. Inquire now.</p></body></html>`,
  },
  "/parked-cn": {
    body: `<!doctype html><html><head><title>domain.com</title></head><body>
<p>该域名待售，欢迎联系。</p></body></html>`,
  },
  "/parked-long": {
    body: `<!doctype html><html><head><title>Acme</title></head><body>
<p>buy this domain</p>${"<p>We also publish a lot of genuine articles about writing and editing workflows.</p>".repeat(25)}
</body></html>`,
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

  // ── 反拼接（T35–T39）──
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

  // ── blocked ──
  "/cf-challenge": {
    status: 403,
    headers: { "cf-mitigated": "challenge", "cf-ray": "abc123" },
    body: "<html><body>Checking your browser</body></html>",
  },
  "/verify-human": {
    status: 403,
    body: "<html><body><p>Please verify you are human to continue.</p></body></html>",
  },

  // ── robots ──
  "/robots-disallowed/page": { body: HTML_OK },
  "/robots-delay/page": { body: HTML_OK },
};

export async function startMockServer(): Promise<MockServer> {
  const log: { method: string; path: string }[] = [];
  let robotsMode: "allow" | "disallow" | "500" | "delay" = "allow";

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    log.push({ method: req.method ?? "GET", path });

    // ── robots.txt ──
    if (path === "/robots.txt") {
      if (robotsMode === "500") {
        res.writeHead(500).end("boom");
        return;
      }
      if (robotsMode === "disallow") {
        res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /\n");
        return;
      }
      if (robotsMode === "delay") {
        res
          .writeHead(200, { "content-type": "text/plain" })
          .end("User-agent: *\nCrawl-delay: 60\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow:\n");
      return;
    }
    if (path === "/__robots") {
      robotsMode = (url.searchParams.get("mode") as typeof robotsMode) ?? "allow";
      res.writeHead(200).end(robotsMode);
      return;
    }
    if (path === "/__log") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(log));
      return;
    }

    // ── 方法特异行为 ──
    if (path === "/head-405") {
      if (req.method === "HEAD") return void res.writeHead(405).end();
      return void respond(res, { body: HTML_OK });
    }
    if (path === "/head-403") {
      if (req.method === "HEAD") return void res.writeHead(403).end();
      return void respond(res, { body: HTML_OK });
    }
    if (path === "/head-404") {
      if (req.method === "HEAD") return void res.writeHead(404).end();
      return void respond(res, { body: HTML_OK });
    }
    // 大页面 + HEAD 不可用：唯一能让「正文很长」的页面走到 GET 内容分类的路径。
    // 契约 §1.1 下，Content-Length > 512 的页面 HEAD 就短路了，E1 排除项永远不触发。
    if (path === "/parked-long-nohead") {
      if (req.method === "HEAD") return void res.writeHead(405).end();
      return void respond(res, {
        body: `<!doctype html><html><head><title>Acme</title></head><body>
<p>buy this domain</p>${"<p>We also publish a lot of genuine articles about writing and editing workflows.</p>".repeat(25)}
</body></html>`,
      });
    }
    if (path === "/head-tiny") {
      if (req.method === "HEAD") {
        return void res.writeHead(200, { "content-type": "text/html", "content-length": "120" }).end();
      }
      return void respond(res, { body: HTML_OK });
    }

    // ── 重定向 ──
    if (path.startsWith("/redir/")) {
      const n = Number(path.split("/")[2] ?? "0");
      if (n >= 8) return void respond(res, { body: HTML_OK });
      return void res.writeHead(302, { location: `/redir/${n + 1}` }).end();
    }
    if (path === "/loop-a") return void res.writeHead(302, { location: "/loop-b" }).end();
    if (path === "/loop-b") return void res.writeHead(302, { location: "/loop-a" }).end();
    if (path === "/redir-private") {
      // 元数据端点在任何模式下都硬拒，用来验证逐跳重校验确实生效
      return void res.writeHead(302, { location: "http://169.254.169.254/" }).end();
    }
    if (path === "/redir-ok") return void res.writeHead(301, { location: "/ok" }).end();

    // ── 忽略 Range，流式返回大响应 ──
    if (path === "/huge") {
      if (req.method === "HEAD") {
        return void res
          .writeHead(200, { "content-type": "text/html", "content-length": "200" })
          .end();
      }
      res.writeHead(200, { "content-type": "text/html" });
      const chunk = "<p>filler content for oversize response</p>".repeat(200);
      for (let i = 0; i < 40; i++) res.write(chunk);
      return void res.end();
    }

    const fixture = bodies[path];
    if (!fixture) return void res.writeHead(404).end("no fixture");
    respond(res, fixture);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    log,
    reset: () => {
      log.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function respond(
  res: http.ServerResponse,
  fixture: { status?: number; headers?: Record<string, string>; body?: string }
) {
  const body = fixture.body ?? "";
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    // 真实服务器对静态页会发 Content-Length，HEAD 也一样。
    // 契约 §1.1 条件 4 靠它把「小页面」路由到 GET 复核 —— 不发这个头，
    // 停放页/软 404 就永远不会被取正文，整个内容分类层等于不存在。
    "content-length": String(Buffer.byteLength(body)),
    ...(fixture.headers ?? {}),
  };
  res.writeHead(fixture.status ?? 200, headers);
  res.end(body);
}
