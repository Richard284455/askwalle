-- AI HOT 内容闭环：精选 / 热点 / 日报 + 多语言草稿
--
-- **纯加法**：只建新类型、新表、新表上的索引与外键。
-- 不改、不删、不重命名任何既有对象。
--
-- 注：Prisma 自动生成的版本里还包含若干与本次改动无关的既有对象变更
-- （删除 tool_lifecycle_states / event_cluster_candidate_members 上的索引、
-- 重命名 5 个既有约束索引、重建 generated_articles 的外键）。
-- 那些是更早的手写 migration 采用自定义索引名留下的历史漂移，
-- 与本次改动无关，已全部剔除 —— 删除既有索引是实打实的回退。

-- CreateEnum
CREATE TYPE "AihotContentKind" AS ENUM ('SELECTED', 'HOT_TOPIC', 'DAILY');

-- CreateEnum
CREATE TYPE "MultilingualContentForm" AS ENUM ('MULTILINGUAL_NEWS_BRIEF', 'HOT_TOPIC_BRIEF', 'DAILY_BRIEF');

-- CreateEnum
CREATE TYPE "DraftLanguage" AS ENUM ('EN_US', 'ES_ES', 'PT_BR', 'JA_JP');

-- CreateEnum
CREATE TYPE "MultilingualDraftStatus" AS ENUM ('DRAFTED', 'QA_FAILED', 'GENERATION_FAILED', 'SOURCE_INSUFFICIENT', 'READY_TO_PUBLISH', 'REJECTED_BY_REVIEWER', 'PUBLISHED');

-- CreateTable
CREATE TABLE "aihot_selected_items" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'AIHOT',
    "provider_item_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "original_title" TEXT,
    "summary" TEXT,
    "category" TEXT,
    "mapped_category" TEXT,
    "score" INTEGER,
    "source_name" TEXT,
    "aihot_url" TEXT NOT NULL,
    "original_url" TEXT,
    "published_at" TIMESTAMP(3),
    "discovered_at" TIMESTAMP(3),
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "source_snapshot_hash" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aihot_selected_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aihot_hot_topic_snapshots" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'AIHOT',
    "topic_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "rank" INTEGER,
    "source_count" INTEGER,
    "signal_count" INTEGER,
    "source_names_json" JSONB,
    "related_item_ids_json" JSONB,
    "source_name" TEXT,
    "aihot_url" TEXT NOT NULL,
    "original_url" TEXT,
    "latest_at" TIMESTAMP(3),
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_snapshot_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aihot_hot_topic_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aihot_daily_reports" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'AIHOT',
    "report_date" TEXT NOT NULL,
    "title" TEXT,
    "summary" TEXT,
    "generated_at" TIMESTAMP(3),
    "window_start" TIMESTAMP(3),
    "window_end" TIMESTAMP(3),
    "sections_json" JSONB NOT NULL,
    "included_item_ids_json" JSONB,
    "aihot_url" TEXT NOT NULL,
    "attribution_name" TEXT NOT NULL,
    "attribution_url" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_snapshot_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aihot_daily_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "multilingual_drafts" (
    "id" SERIAL NOT NULL,
    "content_form" "MultilingualContentForm" NOT NULL,
    "content_kind" "AihotContentKind" NOT NULL,
    "unit_key" TEXT NOT NULL,
    "selected_item_id" INTEGER,
    "hot_topic_snapshot_id" INTEGER,
    "daily_report_id" INTEGER,
    "language" "DraftLanguage" NOT NULL,
    "is_master" BOOLEAN NOT NULL DEFAULT false,
    "master_draft_id" INTEGER,
    "generation_version" TEXT NOT NULL,
    "status" "MultilingualDraftStatus" NOT NULL DEFAULT 'GENERATION_FAILED',
    "source_snapshot_hash" TEXT NOT NULL,
    "source_input_hash" TEXT NOT NULL,
    "provider_attribution_name" TEXT NOT NULL,
    "provider_attribution_url" TEXT NOT NULL,
    "original_source_name" TEXT,
    "original_source_url" TEXT,
    "category_slug" TEXT,
    "headline" TEXT,
    "summary" TEXT,
    "body" TEXT,
    "sections_json" JSONB,
    "qa_verdict" "FaithfulnessVerdict",
    "qa_issues_json" JSONB,
    "qa_checked_at" TIMESTAMP(3),
    "provider" TEXT,
    "model" TEXT,
    "generated_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_notes" TEXT,
    "resource_content_id" INTEGER,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "multilingual_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "aihot_selected_items_published_at_idx" ON "aihot_selected_items"("published_at");

-- CreateIndex
CREATE INDEX "aihot_selected_items_category_idx" ON "aihot_selected_items"("category");

-- CreateIndex
CREATE UNIQUE INDEX "aihot_selected_items_provider_provider_item_id_key" ON "aihot_selected_items"("provider", "provider_item_id");

-- CreateIndex
CREATE INDEX "aihot_hot_topic_snapshots_captured_at_idx" ON "aihot_hot_topic_snapshots"("captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "aihot_hot_topic_snapshots_provider_topic_id_source_snapshot_key" ON "aihot_hot_topic_snapshots"("provider", "topic_id", "source_snapshot_hash");

-- CreateIndex
CREATE INDEX "aihot_daily_reports_report_date_idx" ON "aihot_daily_reports"("report_date");

-- CreateIndex
CREATE UNIQUE INDEX "aihot_daily_reports_provider_report_date_key" ON "aihot_daily_reports"("provider", "report_date");

-- CreateIndex
CREATE INDEX "multilingual_drafts_content_form_status_idx" ON "multilingual_drafts"("content_form", "status");

-- CreateIndex
CREATE INDEX "multilingual_drafts_status_created_at_idx" ON "multilingual_drafts"("status", "created_at");

-- CreateIndex
CREATE INDEX "multilingual_drafts_source_input_hash_idx" ON "multilingual_drafts"("source_input_hash");

-- CreateIndex
CREATE UNIQUE INDEX "multilingual_drafts_unit_key_language_generation_version_key" ON "multilingual_drafts"("unit_key", "language", "generation_version");

-- AddForeignKey
ALTER TABLE "multilingual_drafts" ADD CONSTRAINT "multilingual_drafts_selected_item_id_fkey" FOREIGN KEY ("selected_item_id") REFERENCES "aihot_selected_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "multilingual_drafts" ADD CONSTRAINT "multilingual_drafts_hot_topic_snapshot_id_fkey" FOREIGN KEY ("hot_topic_snapshot_id") REFERENCES "aihot_hot_topic_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "multilingual_drafts" ADD CONSTRAINT "multilingual_drafts_daily_report_id_fkey" FOREIGN KEY ("daily_report_id") REFERENCES "aihot_daily_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;
