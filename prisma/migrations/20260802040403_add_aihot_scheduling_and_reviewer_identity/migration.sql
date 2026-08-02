-- AI HOT 定时抓取/草稿运行时 + 审核身份。
--
-- 纯加法：只建枚举、建表、加列、加索引。
-- （prisma migrate dev 生成时照例混入了与本次无关的 DropIndex / RenameIndex /
--   重建外键 —— 那些是更早的手写迁移留下的漂移，已逐条剔除。）

-- CreateEnum
CREATE TYPE "ReviewerType" AS ENUM ('HUMAN', 'AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AihotTaskType" AS ENUM ('SELECTED', 'HOT_TOPICS', 'DAILY');

-- CreateEnum
CREATE TYPE "AihotTaskStatus" AS ENUM ('RUNNING', 'OK', 'NOT_MODIFIED', 'SKIPPED_LOCKED', 'FAILED');

-- AlterTable：审核身份。
--
-- 先加可空列 → 按既有事实回填 → 再置 NOT NULL。
-- 回填**不能**一律写 HUMAN：现存 36 条全部由 agent 审核（reviewer='claude-code-agent'），
-- 标成 HUMAN 就是在记录里伪造人工闸门。按 reviewer 文本判定，认不出的记 SYSTEM。
ALTER TABLE "translation_reviews" ADD COLUMN "approved_revision_id" INTEGER;
ALTER TABLE "translation_reviews" ADD COLUMN "reviewer_id" TEXT;
ALTER TABLE "translation_reviews" ADD COLUMN "reviewer_name" TEXT;
ALTER TABLE "translation_reviews" ADD COLUMN "reviewer_type" "ReviewerType";

UPDATE "translation_reviews"
   SET "reviewer_id" = "reviewer",
       "reviewer_name" = "reviewer",
       "reviewer_type" = CASE
         WHEN "reviewer" ILIKE '%agent%' OR "reviewer" ILIKE '%claude%' OR "reviewer" ILIKE '%bot%'
           THEN 'AGENT'::"ReviewerType"
         ELSE 'SYSTEM'::"ReviewerType"
       END
 WHERE "reviewer_type" IS NULL;

-- 已批准的记录补上当时批准的那一版
UPDATE "translation_reviews"
   SET "approved_revision_id" = "revision_id"
 WHERE "decision" = 'APPROVED' AND "approved_revision_id" IS NULL;

ALTER TABLE "translation_reviews" ALTER COLUMN "reviewer_id" SET NOT NULL;
ALTER TABLE "translation_reviews" ALTER COLUMN "reviewer_type" SET NOT NULL;

-- CreateTable
CREATE TABLE "aihot_task_leases" (
    "id" SERIAL NOT NULL,
    "task_type" "AihotTaskType" NOT NULL,
    "locked_by" TEXT,
    "locked_until" TIMESTAMP(3),
    "heartbeat_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "last_run_status" "AihotTaskStatus",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aihot_task_leases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aihot_task_runs" (
    "id" SERIAL NOT NULL,
    "task_type" "AihotTaskType" NOT NULL,
    "status" "AihotTaskStatus" NOT NULL DEFAULT 'RUNNING',
    "worker_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "endpoint" TEXT,
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "reused" INTEGER NOT NULL DEFAULT 0,
    "not_modified" INTEGER NOT NULL DEFAULT 0,
    "rate_limited" INTEGER NOT NULL DEFAULT 0,
    "server_error" INTEGER NOT NULL DEFAULT 0,
    "provider_calls" INTEGER NOT NULL DEFAULT 0,
    "units_considered" INTEGER NOT NULL DEFAULT 0,
    "units_generated" INTEGER NOT NULL DEFAULT 0,
    "units_reused" INTEGER NOT NULL DEFAULT 0,
    "translations_drafted" INTEGER NOT NULL DEFAULT 0,
    "qa_passed" INTEGER NOT NULL DEFAULT 0,
    "qa_failed" INTEGER NOT NULL DEFAULT 0,
    "families_touched" INTEGER NOT NULL DEFAULT 0,
    "revisions_created" INTEGER NOT NULL DEFAULT 0,
    "queued_for_review" INTEGER NOT NULL DEFAULT 0,
    "publications_created" INTEGER NOT NULL DEFAULT 0,
    "lease_conflict" BOOLEAN NOT NULL DEFAULT false,
    "error_code" TEXT,
    "message" TEXT,
    "detail_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aihot_task_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "aihot_task_leases_task_type_key" ON "aihot_task_leases"("task_type");

-- CreateIndex
CREATE INDEX "aihot_task_runs_task_type_started_at_idx" ON "aihot_task_runs"("task_type", "started_at");

-- CreateIndex
CREATE INDEX "aihot_task_runs_status_started_at_idx" ON "aihot_task_runs"("status", "started_at");

-- CreateIndex
CREATE INDEX "translation_reviews_reviewer_type_idx" ON "translation_reviews"("reviewer_type");
