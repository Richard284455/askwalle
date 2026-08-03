-- 内容策略变更：AI 自动审核 → 自动发布 → 人工复核可撤下。
--
-- 注意：prisma migrate dev 生成这份文件时，照例又塞进了一批与本次改动
-- 完全无关的语句（删 event clustering / tool lifecycle 的索引、重建
-- generated_articles 外键、五处 RenameIndex）。那是 schema 与库之间
-- 长期存在的漂移，不是本次要做的事 —— 已全部剔除。

-- AlterEnum：曾经公开过、被人工撤下的状态
ALTER TYPE "PublishStatus" ADD VALUE 'WITHDRAWN';

-- AlterTable：自动审核的运行审计
ALTER TABLE "aihot_task_runs" ADD COLUMN     "auto_approved" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "auto_blocked" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "auto_reviewed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "llm_vetoed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "publications_intended" INTEGER NOT NULL DEFAULT 0;

-- AlterTable：撤下必须留名留因
ALTER TABLE "article_publications" ADD COLUMN     "withdrawn_by" TEXT,
ADD COLUMN     "withdrawn_reason" TEXT;
