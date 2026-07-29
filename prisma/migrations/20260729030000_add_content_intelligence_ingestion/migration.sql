-- AI Content Intelligence 采集层（纯加法：两张新表 + 两个新枚举 + 一个可空外键列）
--
-- 只新增，不改动任何既有表的既有列。ResourceContent 一字未动 —— 它仍是唯一的发布层，
-- 本阶段只在它上游补出可追溯的原料，不写它、不替代它。

CREATE TYPE "ContentSourceKind" AS ENUM ('rss', 'manual');

CREATE TYPE "SourceItemStatus" AS ENUM ('fetched', 'link_only', 'parse_failed', 'duplicate');

CREATE TABLE "content_sources" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ContentSourceKind" NOT NULL,
    "feed_url" TEXT,
    "homepage" TEXT,
    "publisher" TEXT NOT NULL,
    "lang" TEXT NOT NULL DEFAULT 'en',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "fetch_interval_minutes" INTEGER NOT NULL DEFAULT 60,
    "last_fetched_at" TIMESTAMP(3),
    "next_fetch_at" TIMESTAMP(3),
    "last_status" TEXT,
    "last_error" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_sources_pkey" PRIMARY KEY ("id")
);

-- 同一订阅地址只配置一次；manual 源 feed_url 为 NULL，Postgres 视 NULL 互不相等，不受此约束
CREATE UNIQUE INDEX "content_sources_feed_url_key" ON "content_sources"("feed_url");
CREATE INDEX "content_sources_enabled_next_fetch_at_idx" ON "content_sources"("enabled", "next_fetch_at");
CREATE INDEX "content_sources_kind_idx" ON "content_sources"("kind");

CREATE TABLE "source_items" (
    "id" SERIAL NOT NULL,
    "source_id" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "canonical_url" TEXT,
    "url_hash" TEXT NOT NULL,
    "content_hash" TEXT,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "published_at" TIMESTAMP(3),
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_excerpt" TEXT,
    "raw_content" TEXT,
    "lang" TEXT,
    "http_status" INTEGER,
    "final_url" TEXT,
    "evidence" JSONB,
    "status" "SourceItemStatus" NOT NULL DEFAULT 'fetched',
    "duplicate_of_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_items_pkey" PRIMARY KEY ("id")
);

-- 同源同文章只记一次；跨源不去重（两个源报道同一件事是真实溯源信息，
-- 合并成事件是下一阶段聚类的判断，不在原始层预判）
CREATE UNIQUE INDEX "source_items_source_id_url_hash_key" ON "source_items"("source_id", "url_hash");
CREATE INDEX "source_items_source_id_published_at_idx" ON "source_items"("source_id", "published_at");
CREATE INDEX "source_items_status_fetched_at_idx" ON "source_items"("status", "fetched_at");
CREATE INDEX "source_items_content_hash_idx" ON "source_items"("content_hash");

ALTER TABLE "source_items" ADD CONSTRAINT "source_items_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "content_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 采集任务的条目指向信息源（与 website_id 互斥，同为可空，不影响既有任务类型）
ALTER TABLE "bulk_job_items" ADD COLUMN "source_id" INTEGER;
CREATE INDEX "bulk_job_items_source_id_idx" ON "bulk_job_items"("source_id");
ALTER TABLE "bulk_job_items" ADD CONSTRAINT "bulk_job_items_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "content_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
