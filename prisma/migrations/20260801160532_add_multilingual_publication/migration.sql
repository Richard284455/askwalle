-- 多语言人工审核与受控发布：family / translation / revision / review / publication
--
-- **纯加法**：只建新类型、新表、新表上的索引与外键。
-- Prisma 自动生成的版本里夹带的既有对象删索引/改名，是更早的手写 migration
-- 留下的历史命名漂移，与本次改动无关，已剔除。

-- CreateEnum
CREATE TYPE "PublishStatus" AS ENUM ('DRAFTED', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'REJECTED', 'SUPERSEDED', 'PUBLICATION_FAILED');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVED', 'REJECTED', 'NEEDS_REVISION');

-- CreateEnum
CREATE TYPE "ReviewIssueCategory" AS ENUM ('TRUE_FACT_DRIFT', 'TRANSLATION_QUALITY_ISSUE', 'UNSUPPORTED_DETAIL', 'ATTRIBUTION_ERROR', 'SOURCE_INSUFFICIENT', 'QA_FALSE_NEGATIVE', 'STYLE_ONLY', 'NO_ISSUE');

-- CreateTable
CREATE TABLE "article_families" (
    "id" SERIAL NOT NULL,
    "unit_key" TEXT NOT NULL,
    "content_kind" "AihotContentKind" NOT NULL,
    "content_form" "MultilingualContentForm" NOT NULL,
    "selected_item_id" INTEGER,
    "hot_topic_snapshot_id" INTEGER,
    "daily_report_id" INTEGER,
    "slug" TEXT NOT NULL,
    "report_date" TEXT,
    "status" "PublishStatus" NOT NULL DEFAULT 'DRAFTED',
    "source_snapshot_hash" TEXT NOT NULL,
    "attribution_name" TEXT NOT NULL,
    "attribution_url" TEXT NOT NULL,
    "original_source_name" TEXT,
    "original_source_url" TEXT,
    "category_slug" TEXT,
    "source_published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "article_families_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_translations" (
    "id" SERIAL NOT NULL,
    "family_id" INTEGER NOT NULL,
    "locale" "DraftLanguage" NOT NULL,
    "status" "PublishStatus" NOT NULL DEFAULT 'DRAFTED',
    "current_revision_id" INTEGER,
    "approved_revision_id" INTEGER,
    "published_revision_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "article_translations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_revisions" (
    "id" SERIAL NOT NULL,
    "translation_id" INTEGER NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "headline" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sections_json" JSONB,
    "origin_draft_id" INTEGER,
    "source_input_hash" TEXT NOT NULL,
    "qa_verdict" "FaithfulnessVerdict",
    "qa_issues_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_reviews" (
    "id" SERIAL NOT NULL,
    "translation_id" INTEGER NOT NULL,
    "revision_id" INTEGER NOT NULL,
    "reviewer" TEXT NOT NULL,
    "reviewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decision" "ReviewDecision" NOT NULL,
    "notes" TEXT,
    "checklist_json" JSONB NOT NULL,
    "issue_categories_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "translation_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_publications" (
    "id" SERIAL NOT NULL,
    "translation_id" INTEGER NOT NULL,
    "revision_id" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "locale" "DraftLanguage" NOT NULL,
    "path" TEXT NOT NULL,
    "status" "PublishStatus" NOT NULL DEFAULT 'PUBLISHED',
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unpublished_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "article_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "article_families_unit_key_key" ON "article_families"("unit_key");

-- CreateIndex
CREATE INDEX "article_families_status_idx" ON "article_families"("status");

-- CreateIndex
CREATE INDEX "article_families_content_form_idx" ON "article_families"("content_form");

-- CreateIndex
CREATE INDEX "article_translations_status_idx" ON "article_translations"("status");

-- CreateIndex
CREATE UNIQUE INDEX "article_translations_family_id_locale_key" ON "article_translations"("family_id", "locale");

-- CreateIndex
CREATE INDEX "article_revisions_translation_id_idx" ON "article_revisions"("translation_id");

-- CreateIndex
CREATE UNIQUE INDEX "article_revisions_translation_id_revision_number_key" ON "article_revisions"("translation_id", "revision_number");

-- CreateIndex
CREATE INDEX "translation_reviews_translation_id_revision_id_idx" ON "translation_reviews"("translation_id", "revision_id");

-- CreateIndex
CREATE INDEX "translation_reviews_decision_idx" ON "translation_reviews"("decision");

-- CreateIndex
CREATE UNIQUE INDEX "article_publications_idempotency_key_key" ON "article_publications"("idempotency_key");

-- CreateIndex
CREATE INDEX "article_publications_status_published_at_idx" ON "article_publications"("status", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "article_publications_translation_id_revision_id_key" ON "article_publications"("translation_id", "revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "article_publications_locale_path_key" ON "article_publications"("locale", "path");

-- AddForeignKey
ALTER TABLE "article_translations" ADD CONSTRAINT "article_translations_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "article_families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_revisions" ADD CONSTRAINT "article_revisions_translation_id_fkey" FOREIGN KEY ("translation_id") REFERENCES "article_translations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_reviews" ADD CONSTRAINT "translation_reviews_translation_id_fkey" FOREIGN KEY ("translation_id") REFERENCES "article_translations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_publications" ADD CONSTRAINT "article_publications_translation_id_fkey" FOREIGN KEY ("translation_id") REFERENCES "article_translations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
