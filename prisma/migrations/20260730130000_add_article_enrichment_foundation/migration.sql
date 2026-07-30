-- 按需文章增强地基（纯加法：两个新枚举 + 一张新表 + 两个可空列）
--
-- 动机：三个 OFFICIAL_PRIMARY 源里有两个（OpenAI News、Google DeepMind）的订阅
-- 只给标题，共 100 条 link_only。没有正文就没有可核验的事实，聚类和事实抽取
-- 都无从谈起 —— 所以正文抓取不是可选项，而是这两个源可用的前提。
--
-- 但抓第三方页面是**权限问题**而不只是技术问题：默认仍是 FEED_ONLY，
-- 放宽必须逐源显式决定，且每次尝试都留下取回证据与归因。

-- 逐源的正文抓取强度。默认最保守。
CREATE TYPE "ArticleFetchPolicy" AS ENUM ('FEED_ONLY', 'ON_DEMAND', 'NEVER_FETCH', 'ALWAYS_FETCH');

-- 与 SourceRunOutcome 分开：采集看「订阅这一轮跑没跑成」，
-- 这里看「这一篇正文能不能用」，失败语义不同。
CREATE TYPE "EnrichmentOutcome" AS ENUM ('OK', 'NOT_MODIFIED', 'BLOCKED', 'CONTENT_INSUFFICIENT', 'UNSUPPORTED', 'SOURCE_ERROR', 'INFRA_ERROR');

ALTER TABLE "content_sources"
    ADD COLUMN "article_fetch_policy" "ArticleFetchPolicy" NOT NULL DEFAULT 'FEED_ONLY';

-- 文章增强任务的条目指向单条来源条目。三个外键按 job type 互斥。
ALTER TABLE "bulk_job_items" ADD COLUMN "source_item_id" INTEGER;

CREATE TABLE "source_item_enrichment_runs" (
    "id" SERIAL NOT NULL,
    "source_item_id" INTEGER NOT NULL,
    "job_id" INTEGER,
    "job_item_id" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "outcome" "EnrichmentOutcome" NOT NULL,
    "error_domain" "SourceRunErrorDomain" NOT NULL DEFAULT 'NONE',
    "requested_url" TEXT NOT NULL,
    "final_url" TEXT,
    "canonical_url" TEXT,
    "http_status" INTEGER,
    "content_type" TEXT,
    "bytes_read" INTEGER,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "latency_dns_ms" INTEGER,
    "latency_fetch_ms" INTEGER,
    "latency_total_ms" INTEGER,
    "pinned_ip" TEXT,
    "redirect_count" INTEGER,
    "robots_decision" TEXT,
    "etag_sent" TEXT,
    "etag_received" TEXT,
    "last_modified_sent" TEXT,
    "last_modified_received" TEXT,
    "page_title" TEXT,
    "author" TEXT,
    "page_published_at" TIMESTAMP(3),
    "language" TEXT,
    "visible_text_length" INTEGER,
    "content_hash" TEXT,
    "excerpt" TEXT,
    "headings_json" JSONB,
    "metadata_json" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "evidence_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_item_enrichment_runs_pkey" PRIMARY KEY ("id")
);

-- 同一个 job 里同一条条目只留一条有效 run：worker 回收或重复驱动不写第二条
CREATE UNIQUE INDEX "source_item_enrichment_runs_job_id_source_item_id_key"
    ON "source_item_enrichment_runs"("job_id", "source_item_id");
CREATE INDEX "source_item_enrichment_runs_source_item_id_started_at_idx"
    ON "source_item_enrichment_runs"("source_item_id", "started_at");
CREATE INDEX "source_item_enrichment_runs_outcome_started_at_idx"
    ON "source_item_enrichment_runs"("outcome", "started_at");
CREATE INDEX "source_item_enrichment_runs_error_domain_started_at_idx"
    ON "source_item_enrichment_runs"("error_domain", "started_at");
CREATE INDEX "source_item_enrichment_runs_content_hash_idx"
    ON "source_item_enrichment_runs"("content_hash");
CREATE INDEX "bulk_job_items_source_item_id_idx"
    ON "bulk_job_items"("source_item_id");

ALTER TABLE "source_item_enrichment_runs"
    ADD CONSTRAINT "source_item_enrichment_runs_source_item_id_fkey"
    FOREIGN KEY ("source_item_id") REFERENCES "source_items"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bulk_job_items"
    ADD CONSTRAINT "bulk_job_items_source_item_id_fkey"
    FOREIGN KEY ("source_item_id") REFERENCES "source_items"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
