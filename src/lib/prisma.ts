import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * 显式限定连接池大小。
 *
 * 不限定时 Prisma 按 `CPU 核数 × 2 + 1` 开池 —— 本机是 17 条。
 * 而 Supabase 的 session 模式 pooler 每条客户端连接都占一条真实 Postgres 连接，
 * 额度远小于此；再叠上进程内的定时任务和另开的 CLI 脚本，
 * 池会被打满，新连接直接失败并抛 **P1001「Can't reach database server」**——
 * 那条报错长得像数据库宕机，实际上是我们自己把额度用光了。
 * 审核台首次报错就是这么来的。
 *
 * 池小一点比池大一点安全：排队等连接只是慢，拿不到连接是整页报错。
 * 需要时用 DATABASE_CONNECTION_LIMIT 覆盖。
 *
 * 服务端与 CLI 分开取值：Web 服务要并发处理请求，需要一个池；
 * CLI 脚本顺序执行，两三条就够。两边都按 8 条开的话，
 * 本地一边跑着服务、一边跑脚本就顶穿额度 —— 实测就是这样：
 * 服务一起来，脚本连不上库。NEXT_RUNTIME 只有 Next 服务进程会设，用它区分最准。
 */
const IS_NEXT_SERVER = Boolean(process.env.NEXT_RUNTIME);
const CONNECTION_LIMIT = Number(
  process.env.DATABASE_CONNECTION_LIMIT ?? (IS_NEXT_SERVER ? 5 : 3)
);
/** 等不到连接时的排队上限（秒）。宁可多等几秒，也别直接把请求判死 */
const POOL_TIMEOUT = Number(process.env.DATABASE_POOL_TIMEOUT ?? 20);

function datasourceUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    // 已经显式写了就尊重原值 —— 不覆盖运维在连接串里做的决定
    if (!u.searchParams.has("connection_limit")) {
      u.searchParams.set("connection_limit", String(CONNECTION_LIMIT));
    }
    if (!u.searchParams.has("pool_timeout")) {
      u.searchParams.set("pool_timeout", String(POOL_TIMEOUT));
    }
    return u.toString();
  } catch {
    // 连接串解析不了就原样交给 Prisma，让它报自己的错，不在这里二次加工
    return raw;
  }
}

const url = datasourceUrl();

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient(url ? { datasources: { db: { url } } } : undefined);

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
