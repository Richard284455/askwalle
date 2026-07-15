# AskWalle — AI 工具目录与 AI 资源中心

<div align="center">

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)
![Next.js](https://img.shields.io/badge/next.js-15.1.x-black)
![PostgreSQL](https://img.shields.io/badge/database-PostgreSQL%20only-336791)

</div>

## 📖 项目定位

**AskWalle** 是一个公开的 **AI 工具目录 + AI 资源中心**。它帮助用户：

- 发现并浏览 AI 工具（按分类、排行、新品、热门、免费、A-Z 索引）
- 通过内部工具详情页了解工具，再跳转官网访问
- 阅读 AI 资源内容：资讯（News）、评测（Reviews）、提示词（Prompts）、技能（Skills）、教程（Tutorials）
- 通过后台管理审核工具提交与站点设置

本项目由早期的「AI 导航」演进而来，当前方向是 AskWalle AI Hub。部分历史术语可能仍残留在代码注释中。

## 🛠️ 技术栈

- **框架**：Next.js 15（App Router）+ React 18 + TypeScript
- **样式/UI**：Tailwind CSS + Radix UI primitives + 本地 `src/ui` 组件 + Framer Motion
- **数据库**：PostgreSQL（**仅支持 PostgreSQL**）+ Prisma ORM
- **客户端状态/数据**：Jotai、React Query（@tanstack/react-query）、SWR
- **表单/校验**：React Hook Form + Zod
- **脚本**：ts-node（数据初始化、资源导入、缩略图缓存）
- **包管理器**：**npm**（唯一支持；仅保留 `package-lock.json`）

## 📂 目录结构（简）

```
src/
  app/
    (app)/     公开页：categories, tools/[slug], new, popular, free-ai-tools,
               rankings, resources, news|reviews|prompts|skills|tutorials(+[slug]),
               submit, search, about
    (admin)/   管理后台
    api/       路由处理：websites, categories, settings, login, footer-links, admin
  components/  按功能分组的共享组件（website, resources, header, footer 等）
  lib/         db 客户端、资源内容 helper、services、sync、tasks、类型
  data/resources/  静态资源种子数据（导入源，保留至人工批准移除）
scripts/       import-resources.ts, cache-thumbnails.ts
prisma/        schema.prisma 与迁移历史
docs/          HANDOFF / ARCHITECTURE / DECISIONS
```

## 🚀 本地安装与启动

> 前置：Node.js ≥ 18，npm ≥ 8，一个可用的 PostgreSQL 数据库。

```bash
# 1. 安装依赖（使用 npm）
npm install

# 2. 配置环境变量
cp .env.example .env
# 手动编辑 .env，填入 PostgreSQL 连接串与密钥。切勿提交或打印真实值。

# 3. 启动开发服务器
npm run dev
```

本地预览：`http://localhost:3000`

若本地 `DATABASE_URL`（transaction pooler）无法连接，可临时用 `DIRECT_URL` 覆盖运行：

```bash
set -a
source .env
set +a
DATABASE_URL="$DIRECT_URL" npm run dev
```

## 🔐 环境变量

在 `.env` 中配置以下变量（**名称如下，值请勿写入文档或提交**；参考 `.env.example`）：

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `DATABASE_URL` | ✅ | PostgreSQL 连接串（应用运行时使用） |
| `DIRECT_URL` | ✅ | PostgreSQL 直连地址（Prisma 迁移及本地覆盖使用） |
| `ADMIN_PASSWORD` | ✅ | 管理员登录密码 |
| `JWT_SECRET` | ✅ | JWT 签名密钥，建议随机字符串 |
| `OSS_REGION` / `OSS_BUCKET` / `OSS_ACCESS_KEY` / `OSS_ACCESS_SECRET` / `OSS_ENDPOINT` | ❌ | 可选的 OSS 备份/同步配置 |

`.env` 已被 `.gitignore` 忽略。`.env.example` 仅作文档用途，**不得包含真实密钥**。

## 🗄️ Prisma 安全使用规则

`prisma/schema.prisma` 的 provider 锁定为 **PostgreSQL**，不能替换为 MySQL。

**允许的只读/安全命令：**

```bash
npx prisma validate          # 校验 schema
npx prisma migrate status    # 查看迁移状态（只读）
```

如 `DATABASE_URL` 无法连接，可用直连地址查看状态：

```bash
DATABASE_URL="$DIRECT_URL" npx prisma migrate status
```

**🚫 禁止执行的破坏性/未经批准命令：**

```bash
npx prisma db push          # 禁止
npx prisma migrate reset    # 禁止（会清库）
npx prisma migrate deploy   # 需人工批准后才可执行
npx prisma migrate dev      # 需人工批准后才可执行
```

- 不得编辑任何已有 migration 文件。
- 除非用户明确要求，不得创建新的 migration。
- 不得在客户端组件中直接访问数据库；数据库读取只放在服务端组件、路由处理器或服务端 helper。

> 迁移历史：`20241221124437_init`、`20260704121500_add_website_thumbnail_base64`、`20260705180439_add_resource_content`。

## 📦 ResourceContent 数据导入流程

资源中心内容（news/review/prompt/skill/tutorial）统一存储在 `resource_contents` 表，公开页仅读取 `published` 记录。

数据流：`src/data/resources`（静态种子）→ `scripts/import-resources.ts` → `resource_contents` 表 → `src/lib/resources/resource-content.ts`（适配为 UI 结构）。

导入命令（默认**跳过已存在记录**，避免覆盖人工编辑）：

```bash
set -a
source .env
set +a
DATABASE_URL="$DIRECT_URL" npm run import:resources
```

仅在确有必要时使用覆盖模式：

```bash
DATABASE_URL="$DIRECT_URL" npm run import:resources -- --overwrite
```

> `ResourceContent.content` 为 JSON，类型专属字段无列级约束，由 helper 防御性解析。

## ✅ 校验与常用命令

```bash
npm run lint                 # ESLint
npm run build                # 生产构建
npx prisma validate          # 校验 Prisma schema
npx prisma migrate status    # 查看迁移状态（只读）
```

> ⚠️ **重要**：本项目 `next.config.ts` 中设置了 `eslint.ignoreDuringBuilds: true` 与
> `typescript.ignoreBuildErrors: true`。因此 **`npm run build` 会跳过 ESLint 和 TypeScript 类型检查**。
> 构建通过 **不等于** 类型检查通过。类型正确性需另行保证（当前**没有** `type-check` 脚本）。

## 🧪 测试

当前项目**没有自动化测试**，`package.json` 中也**没有 `test` 脚本**。若后续新增测试，请先确认命令是否存在，不要凭空发明。

## ☁️ 部署与 Supabase 常见问题

推荐使用 Vercel + 托管 PostgreSQL（Supabase / Neon / Railway 等）。在平台环境变量中配置上表所列变量。

**常见 Supabase 连接问题：**

- **transaction pooler 不可达**：本地或迁移命令连接 `DATABASE_URL`（pooler，如 6543 端口）失败时，改用 `DIRECT_URL`（直连，如 5432 端口）覆盖：`DATABASE_URL="$DIRECT_URL" <command>`。
- **迁移必须用直连**：Prisma migrate 相关操作应走 `DIRECT_URL`，pooler 连接可能不支持 advisory lock。
- **provider 必须是 PostgreSQL**：填入 MySQL 连接串会在初始化阶段报错。
- **分类/数据为空**：迁移应用后仍需运行数据初始化（`npm run init-data`）与资源导入（`npm run import:resources`）才有内容。

## 📄 开源协议

本项目采用 [MIT](LICENSE) 协议开源。

<div align="center">

**AskWalle** © 2026

</div>
