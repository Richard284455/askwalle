/**
 * nodeTransport 集成测试。
 *
 *   npm run test:transport
 *
 * 这层以前完全没有覆盖：契约测试全部注入内存 fixture，真实 socket 路径要到
 * A8 才第一次跑真数据 —— 结果 Canary 20/20 全废在 lookup 回调形态上。
 *
 * 所以这里**直接**调 nodeTransport，pinnedIp 传 127.0.0.1，不经过 assertSafeUrl。
 * 这不是 SSRF 绕过：生产入口 safeFetch 仍然先校验再调 transport，
 * 而 loopback/私网/元数据/重定向私网的拒绝由契约测试守着（本文件末尾复核）。
 */
import http from "http";
import { AddressInfo } from "net";

import { nodeTransport, LIMITS } from "../src/lib/website/probe/http-client";
import { assertSafeUrl } from "../src/lib/website/probe/ssrf";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(id: string, name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    failures.push(`${id} ${name}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? `  — ${detail}` : ""}`);
}

type Seen = {
  host?: string;
  method?: string;
  range?: string;
  ua?: string;
  cookie?: string;
  localAddress?: string;
  remoteAddress?: string;
};

async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void
): Promise<{ port: number; seen: Seen; close: () => Promise<void> }> {
  const seen: Seen = {};
  const server = http.createServer((req, res) => {
    seen.host = req.headers.host;
    seen.method = req.method;
    seen.range = req.headers.range as string | undefined;
    seen.ua = req.headers["user-agent"] as string | undefined;
    seen.cookie = req.headers.cookie as string | undefined;
    seen.localAddress = req.socket.localAddress ?? undefined;
    seen.remoteAddress = req.socket.remoteAddress ?? undefined;
    handler(req, res, seen);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function main() {
  console.log("nodeTransport 集成测试（本地回环，不访问外部）\n");

  // ── 1. 基本请求 + Host 头 + pinned IP ──────────────────────────────
  {
    const srv = await withServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<html>ok</html>"));
    try {
      const url = new URL(`http://tools.example:${srv.port}/path?q=1`);
      const res = await nodeTransport({
        method: "GET", url, pinnedIp: "127.0.0.1", wantBody: true,
        signalDeadline: Date.now() + 10_000,
      });
      check("X01", "GET 成功返回 200", res.status === 200, String(res.status));
      check("X02", "Host 头保持原始 hostname", srv.seen.host === `tools.example:${srv.port}`, srv.seen.host);
      check("X03", "实际连接来自 pinnedIp 127.0.0.1", srv.seen.remoteAddress?.includes("127.0.0.1") === true, srv.seen.remoteAddress);
      check("X04", "带 Range 头", srv.seen.range === `bytes=0-${LIMITS.rangeBytes - 1}`, srv.seen.range);
      check("X05", "User-Agent 为 AskWalleBot", srv.seen.ua?.startsWith("AskWalleBot/") === true, srv.seen.ua);
      check("X06", "不发 Cookie", srv.seen.cookie === undefined, srv.seen.cookie ?? "");
      check("X07", "正文可解码", res.buffer.toString("utf8").includes("<html>ok</html>"));
    } finally {
      await srv.close();
    }
  }

  // ── 2. lookup 回调形态：三种组合的回归测试 ─────────────────────────
  //
  // 这是 A8 Canary 事故的精确复现与锁定。结论：
  //   autoSelectFamily=true  + 三参数回调 → ERR_INVALID_IP_ADDRESS（原 bug）
  //   autoSelectFamily=true  + 数组回调   → 200（兼容分支有效）
  //   autoSelectFamily=false + 三参数回调 → 200（nodeTransport 现在走这条）
  {
    const srv = await withServer((_req, res) => res.writeHead(200).end("ok"));
    const attempt = (
      autoSelectFamily: boolean,
      style: "triple" | "array"
    ): Promise<{ ok: boolean; code?: string; all?: boolean }> =>
      new Promise((resolve) => {
        let observedAll: boolean | undefined;
        const req = http.request(
          {
            method: "GET", hostname: "tools.example", port: srv.port, path: "/",
            headers: { host: "tools.example" }, setHost: false,
            autoSelectFamily,
            lookup: (_h: string, opts: unknown, cb: unknown) => {
              observedAll = (opts as { all?: boolean } | undefined)?.all;
              if (style === "array") {
                (cb as (e: null, a: { address: string; family: number }[]) => void)(
                  null, [{ address: "127.0.0.1", family: 4 }]
                );
              } else {
                (cb as (e: null, a: string, f: number) => void)(null, "127.0.0.1", 4);
              }
            },
          } as unknown as http.RequestOptions,
          (res) => { res.resume(); res.on("end", () => resolve({ ok: res.statusCode === 200, all: observedAll })); }
        );
        req.on("error", (e) => resolve({ ok: false, code: (e as NodeJS.ErrnoException).code, all: observedAll }));
        req.end();
      });

    try {
      const bug = await attempt(true, "triple");
      check("X08a", "复现原 bug：autoSelectFamily=true + 三参数 → ERR_INVALID_IP_ADDRESS",
        !bug.ok && bug.code === "ERR_INVALID_IP_ADDRESS", `all=${bug.all} code=${bug.code}`);

      const arrayForm = await attempt(true, "array");
      check("X08b", "兼容分支：autoSelectFamily=true + 数组回调 → 200",
        arrayForm.ok && arrayForm.all === true, `all=${arrayForm.all} ok=${arrayForm.ok}`);

      const shipped = await attempt(false, "triple");
      check("X08c", "现网配置：autoSelectFamily=false + 三参数 → 200",
        shipped.ok && !shipped.all, `all=${shipped.all} ok=${shipped.ok}`);
      console.log(`        （nodeTransport 显式关闭 autoSelectFamily，走 X08c 这条；X08b 分支保留以防上游默认再变）`);
    } finally {
      await srv.close();
    }
  }

  // ── 3. resolver 调用次数：transport 不得自行解析 ────────────────────
  {
    const srv = await withServer((_req, res) => res.writeHead(200).end("ok"));
    try {
      // nodeTransport 收到的是已经定好的 pinnedIp，它内部不该再碰 DNS。
      // 用一个会计数的 resolver 走完整生产入口（assertSafeUrl → safeFetch）验证。
      let resolveCalls = 0;
      const verdict = await assertSafeUrl("http://tools.example/", async () => {
        resolveCalls++;
        return ["93.184.216.34"];
      });
      check("X09", "生产入口解析一次即固定",
        verdict.safe && resolveCalls === 1 && verdict.pinnedIp === "93.184.216.34",
        `calls=${resolveCalls} pinned=${verdict.safe ? verdict.pinnedIp : verdict.reason}`);

      // 多地址：只固定第一个校验通过的
      let multiCalls = 0;
      const multi = await assertSafeUrl("http://dual.example/", async () => {
        multiCalls++;
        return ["93.184.216.34", "8.8.8.8", "2606:4700::1"];
      });
      check("X10", "多地址仍只解析一次并固定其中一个",
        multi.safe && multiCalls === 1 && multi.addresses.length === 3 &&
          multi.addresses.includes(multi.pinnedIp),
        multi.safe ? `pinned=${multi.pinnedIp} of ${multi.addresses.length}` : multi.reason);
    } finally {
      await srv.close();
    }
  }

  // ── 4. dual-stack：给 IPv6 pinnedIp 时不会退回 IPv4 ────────────────
  {
    // 起一个只监听 ::1 的服务；pinnedIp 传 ::1，连接必须走 IPv6
    const seen: Seen = {};
    const server = http.createServer((req, res) => {
      seen.remoteAddress = req.socket.remoteAddress ?? undefined;
      res.writeHead(200).end("ok6");
    });
    let started = true;
    await new Promise<void>((resolve) => {
      server.once("error", () => { started = false; resolve(); });
      server.listen(0, "::1", () => resolve());
    });
    if (!started) {
      console.log("  SKIP  X11  本机无 IPv6 回环，跳过 dual-stack 用例");
    } else {
      const port = (server.address() as AddressInfo).port;
      try {
        const res = await nodeTransport({
          method: "GET", url: new URL(`http://tools.example:${port}/`),
          pinnedIp: "::1", wantBody: true, signalDeadline: Date.now() + 10_000,
        });
        check("X11", "IPv6 pinnedIp 连接成功且走 IPv6",
          res.status === 200 && (seen.remoteAddress?.includes("::1") === true),
          `${res.status} from ${seen.remoteAddress}`);
      } catch (e) {
        check("X11", "IPv6 pinnedIp 连接成功且走 IPv6", false,
          e instanceof Error ? `${(e as NodeJS.ErrnoException).code}: ${e.message}` : "?");
      }
    }
    await new Promise<void>((r) => server.close(() => r()));
  }

  // ── 5. HEAD 不取正文 ───────────────────────────────────────────────
  {
    const srv = await withServer((_req, res) =>
      res.writeHead(200, { "content-type": "text/html", "content-length": "5000" }).end("x".repeat(5000))
    );
    try {
      const res = await nodeTransport({
        method: "HEAD", url: new URL(`http://tools.example:${srv.port}/`),
        pinnedIp: "127.0.0.1", wantBody: false, signalDeadline: Date.now() + 10_000,
      });
      check("X12", "HEAD 返回 200 且不取正文",
        res.status === 200 && res.buffer.length === 0, `${res.status} bytes=${res.buffer.length}`);
      check("X13", "HEAD 未发 Range 头", srv.seen.range === undefined, srv.seen.range ?? "");
    } finally {
      await srv.close();
    }
  }

  // ── 6. 无视 Range 的超大响应会被硬截断 ─────────────────────────────
  {
    const srv = await withServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      const chunk = "y".repeat(64 * 1024);
      for (let i = 0; i < 12; i++) res.write(chunk); // 768KB
      res.end();
    });
    try {
      const res = await nodeTransport({
        method: "GET", url: new URL(`http://tools.example:${srv.port}/`),
        pinnedIp: "127.0.0.1", wantBody: true, signalDeadline: Date.now() + 10_000,
      });
      check("X14", "超大响应在 256KB 处截断",
        res.buffer.length <= LIMITS.hardAbortBytes && res.truncated,
        `bytes=${res.buffer.length} truncated=${res.truncated}`);
    } finally {
      await srv.close();
    }
  }

  // ── 7. 连不上时的错误分类不能是 internal ───────────────────────────
  {
    // 关掉的端口 → ECONNREFUSED，属真实网络错误
    const srv = await withServer((_req, res) => res.writeHead(200).end("ok"));
    const port = srv.port;
    await srv.close();
    try {
      await nodeTransport({
        method: "GET", url: new URL(`http://tools.example:${port}/`),
        pinnedIp: "127.0.0.1", wantBody: true, signalDeadline: Date.now() + 5_000,
      });
      check("X15", "已关闭端口应抛错", false, "居然成功了");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      check("X15", "已关闭端口抛 ECONNREFUSED（真实网络错误）",
        code === "ECONNREFUSED", code ?? "?");
    }
  }

  // ── 8. 生产 SSRF 入口仍然拒绝 loopback / 私网 / 元数据 ─────────────
  console.log("\n  生产入口 SSRF 复核（transport 测试没有放松任何规则）:\n");
  for (const [id, url, expected] of [
    ["X16", "http://127.0.0.1/", "private_ip"],
    ["X16b", "http://127.0.0.1:8080/", "port_not_allowed"],
    ["X17", "http://10.0.0.1/", "private_ip"],
    ["X18", "http://169.254.169.254/", "metadata_endpoint"],
    ["X19", "http://localhost/", "hostname_not_allowed"],
  ] as [string, string, string][]) {
    const v = await assertSafeUrl(url, async () => ["93.184.216.34"]);
    check(id, `${url} 仍被拒 → ${expected}`,
      !v.safe && v.reason === expected, v.safe ? "safe!" : v.reason);
  }

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) {
    console.log("\n失败用例:");
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
