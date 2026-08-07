# 部署到 Vercel

GitHub 已与 Vercel 项目连接，**推送即部署**：推 `main` 出生产，推其它分支出预览。
下面这些是代码之外、必须在 Vercel 控制台里做的事。

## 一、环境变量（Settings → Environment Variables）

密钥类的值只能由你自己填。分三档：

**不配就跑不起来**

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 见下面「连接池」一节，Vercel 上**不要**直接用本地那条 |
| `DIRECT_URL` | 迁移用的直连串（不走 pooler） |
| `JWT_SECRET` | 后台登录签发 token |
| `ADMIN_PASSWORD` | 后台登录密码 |

**不配就少功能**

| 变量 | 说明 |
|---|---|
| `CRON_SECRET` | **定时任务必需**。不配的话 `/api/cron/aihot` 一律 401，Newsroom 完全不更新 |
| `DEEPSEEK_API_KEY` 等 | 改写 / 翻译 / 摘要要用；缺了自动审核会记 `UNAVAILABLE` 但不阻断 |
| `NEXT_PUBLIC_SITE_ORIGIN` | 站点正式域名。缺了 canonical / hreflang / sitemap 会指向默认值 |
| `OSS_*` | 备份同步，可选 |

**用来调运行行为的开关**

| 变量 | 默认 | 说明 |
|---|---|---|
| `AIHOT_SCHEDULER` | 开 | 设 `off` 完全停掉抓取与生成 |
| `AIHOT_AUTO_PUBLISH` | 开 | 设 `off` 只生成入队、不对外发布 |
| `AIHOT_MAX_UNITS_SELECTED` 等 | 见代码 | 单轮产能上限 |
| `AIHOT_CRON_BUDGET_SECONDS` | 280 | **Hobby 计划请设成 45** |
| `DATABASE_CONNECTION_LIMIT` | 5 | 见下 |

## 二、连接池：Vercel 上必须换连接串

本地是**一个**长驻进程开一个池。Vercel 上是**很多个**函数实例，每个都会
自己开一个池 —— 用同一条 session 模式的串，Supabase 的连接额度很快就满，
表现是随机 `P2024 / P1001`，看起来像数据库时好时坏。

所以 Vercel 上的 `DATABASE_URL` 要用 Supabase 的 **transaction pooler**
（端口 `6543`），并且带上：

```
?pgbouncer=true&connection_limit=1
```

`DIRECT_URL` 仍然用直连（端口 `5432`）—— 迁移不能走 pooler。

## 三、定时任务

`vercel.json` 里已经配好四条 cron，节奏与代码里的 `TASK_SCHEDULE` 一致
（有测试比对二者，改一处忘了另一处会红）。

```
HOT_TOPICS  5 */6 * * *     每 6 小时
SELECTED    25 */12 * * *   每 12 小时
DAILY       45 7 * * *      每天一次
ITEMS_ALL   17 */6 * * *    每 6 小时（窗口所限，不能再稀）
```

**计划限制要注意：**

- **Hobby**：全账号只能有 2 条 cron，而且每天只触发一次。上面四条跑不起来 ——
  要么升 Pro，要么把 Newsroom 的调度留在能跑长任务的机器上。
- **Hobby 的函数上限是 60 秒**，`maxDuration = 300` 声明了也没用。
  这种情况务必设 `AIHOT_CRON_BUDGET_SECONDS=45`，否则函数会在做到一半时被杀，
  留下停在 RUNNING 的审计行（租约 TTL 事后会回收，但那是善后）。

单次调用只推进 3 个单元，做不完的下一轮接着做 —— 候选是按「还没做完」算的，
不会丢。但这也意味着：**积压的消化速度由 cron 频率决定**。源端每天新增约
300 条精选，12 小时一轮 × 3 条 = 每天 6 条。要跟上就得加密频率或调大
`AIHOT_MAX_UNITS_SELECTED` 并相应加大时间预算。

## 四、数据库迁移

构建命令是 `prisma generate && next build`，**不含 `migrate deploy`**。
所以新增迁移不会自动应用。改了 schema 之后，在本地对着生产库跑一次：

```bash
npx prisma migrate deploy
```

（这个仓库的 `migrate dev` 有个已知毛病：会往迁移文件里塞入与本次改动无关的
删索引 / 改名语句，必须手工剔除后再 deploy。）

## 五、跑不了的东西

- **缩略图抓取用 Playwright**，无服务器环境里跑不起来。需要缩略图就在能跑
  浏览器的机器上执行相应脚本。
- **批量导入 / 批量改写**这类长任务同理：进程内 worker 在 Vercel 上活不过
  一次函数回收。`instrumentation.ts` 已经在 `VERCEL` 环境下跳过注册，
  以免留下一个看起来在跑、实际不跑的假象。
