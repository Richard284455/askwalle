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
| `CRON_SECRET` | 只给 `/api/cron/aihot` 手工触发用；定时调度不走 Vercel（见第三节），所以不配也不影响更新 |
| `DEEPSEEK_API_KEY` 等 | 改写 / 翻译 / 摘要要用；缺了自动审核会记 `UNAVAILABLE` 但不阻断 |
| `NEXT_PUBLIC_SITE_ORIGIN` | 站点正式域名。缺了 canonical / hreflang / sitemap 会指向默认值 |
| `OSS_*` | 备份同步，可选 |

**用来调运行行为的开关**

| 变量 | 默认 | 说明 |
|---|---|---|
| `AIHOT_SCHEDULER` | 开 | 设 `off` 完全停掉抓取与生成 |
| `AIHOT_AUTO_PUBLISH` | 开 | 设 `off` 只生成入队、不对外发布 |
| `AIHOT_MAX_UNITS_SELECTED` 等 | 见代码 | 单轮产能上限 |
| `AIHOT_CRON_BUDGET_SECONDS` | 280 | 只影响 `/api/cron/aihot`。Hobby 计划设 45 |
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

## 三、定时任务跑在 GitHub Actions，不在 Vercel

**为什么不用 Vercel Cron：** 项目是 Hobby 计划，函数 60 秒硬性封顶，
而实测生成一个内容单元要 **65–245 秒**（中位数约 76 秒）—— 一个都放不下。
Hobby 还限制全账号只有 2 条 cron、每天只触发一次。那条路不是慢，是产能为零。

所以 `vercel.json` 里没有 `crons`，调度全在
`.github/workflows/aihot-schedule.yml`：单个 job 最长 6 小时，跑一整批绰绰有余。

节奏（workflow 里写 UTC，下面是北京时间）：

```
热点      每 6 小时   00/06/12/18 点过 5 分
未筛选流  每 6 小时   00/06/12/18 点过 17 分
精选      每 12 小时  00/12 点过 25 分
日报      每天一次    07:45
```

有测试比对 workflow 的 UTC 时间与代码里 `TASK_SCHEDULE` 的北京时间是否等价，
改一处忘了另一处会红。

### 要在 GitHub 仓库里配的（Settings → Secrets and variables → Actions）

**Secrets**：`DATABASE_URL`、`DIRECT_URL`、`DEEPSEEK_API_KEY`、
`NEXT_PUBLIC_SITE_ORIGIN`（其余按用到的服务商补）。

**Variables**（可选，应急用）：`AIHOT_AUTO_PUBLISH=off` 只生成不发布、
`AIHOT_SCHEDULER=off` 完全停摆。改完立即生效，不用改代码。

出问题不想等下一个整点：Actions 页面 → 该 workflow → **Run workflow**，
可以指定只跑某一类、以及本轮最多做几个单元。

`/api/cron/aihot` 这个路由保留着（要带 `CRON_SECRET`），用于手工触发，
或者将来升级计划后改回平台调度。

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
