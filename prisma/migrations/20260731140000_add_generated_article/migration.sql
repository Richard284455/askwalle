-- 来源忠实的原创资讯生成（纯加法：三个枚举 + 一张表）
--
-- 产品定位转向：系统**不判断信源说的是否客观正确**，只保证生成的文章忠实于
-- 指定信源。事实核查、跨来源印证、事件聚类都不在这条链路上 —— 相关代码与数据
-- 保留但已从发布主链路移除。
--
-- 每个合格 SourceItem 都是独立发布单元：允许不同来源各发一篇，允许同一来源
-- 多次发布，允许与历史文章重复。**不因重复而拒绝**。
-- 唯一要防的是技术性重复：unique(source_item_id, generation_version, article_variant)
-- 保证 worker 重试不会把同一份生成写两遍。

CREATE TYPE "ArticleGenerationMode" AS ENUM ('FULL_SOURCE', 'FEED_ONLY_BRIEF');

CREATE TYPE "ArticleStatus" AS ENUM (
    'SOURCE_READY', 'GENERATION_PENDING', 'DRAFTED', 'FAITHFULNESS_REVIEW',
    'READY_TO_PUBLISH', 'PUBLISHED',
    'SOURCE_INSUFFICIENT', 'GENERATION_FAILED', 'FAITHFULNESS_FAILED', 'PUBLICATION_FAILED'
);

-- 只判「是否忠实于来源」，不判「来源说的对不对」
CREATE TYPE "FaithfulnessVerdict" AS ENUM ('PASSED', 'NEEDS_REWRITE', 'BLOCKED_SOURCE_INSUFFICIENT');

CREATE TABLE "generated_articles" (
    "id" SERIAL NOT NULL,
    "source_item_id" INTEGER NOT NULL,
    "fact_pack_id" INTEGER,
    "generation_version" TEXT NOT NULL,
    "article_variant" TEXT NOT NULL DEFAULT 'default',
    "mode" "ArticleGenerationMode" NOT NULL,
    "status" "ArticleStatus" NOT NULL DEFAULT 'GENERATION_PENDING',
    "source_url_snapshot" TEXT NOT NULL,
    "source_publisher_snapshot" TEXT NOT NULL,
    "source_title_snapshot" TEXT NOT NULL,
    "source_published_at" TIMESTAMP(3),
    "source_captured_at" TIMESTAMP(3),
    "source_input_hash" TEXT NOT NULL,
    "headline" TEXT,
    "short_summary" TEXT,
    "body" TEXT,
    "fact_mapping_json" JSONB,
    "qa_verdict" "FaithfulnessVerdict",
    "qa_issues_json" JSONB,
    "qa_checked_at" TIMESTAMP(3),
    "provider" TEXT,
    "model" TEXT,
    "generated_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generated_articles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "generated_articles_item_version_variant_key"
    ON "generated_articles"("source_item_id", "generation_version", "article_variant");
CREATE INDEX "generated_articles_status_created_at_idx" ON "generated_articles"("status", "created_at");
CREATE INDEX "generated_articles_mode_created_at_idx" ON "generated_articles"("mode", "created_at");
CREATE INDEX "generated_articles_source_input_hash_idx" ON "generated_articles"("source_input_hash");

ALTER TABLE "generated_articles" ADD CONSTRAINT "generated_articles_source_item_id_fkey"
    FOREIGN KEY ("source_item_id") REFERENCES "source_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "generated_articles" ADD CONSTRAINT "generated_articles_fact_pack_id_fkey"
    FOREIGN KEY ("fact_pack_id") REFERENCES "source_fact_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
