-- Source Fact Pack 地基（纯加法：六个枚举 + 三张表）
--
-- 一个 pack = 一篇来源文档的一次确定提取结果，**不是一个事件**。
-- 「一篇文章 = 一个事件」是这类系统最容易犯也最贵的错：同一件事会被多个来源
-- 各报一次，标题里的说法远不等于已确认的事实。合并成事件是下一阶段聚类的
-- judgment，这里只把能确定的东西固定下来，并让每一条都能追回证据。
--
-- 本阶段只有确定性的文档事实与来源身份事实，不从正文推断任何语义。

CREATE TYPE "FactPackStatus" AS ENUM ('READY', 'APPROVED', 'REJECTED', 'SUPERSEDED');
CREATE TYPE "FactClaimScope" AS ENUM ('DOCUMENT', 'SOURCE', 'ENTITY', 'EVENT', 'PRODUCT');
CREATE TYPE "FactObjectType" AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN', 'DATETIME', 'URL', 'JSON');
CREATE TYPE "FactCertainty" AS ENUM ('OBSERVED', 'SOURCE_ASSERTED', 'INFERRED', 'DISPUTED', 'UNKNOWN');
CREATE TYPE "FactUsage" AS ENUM ('CITABLE', 'CONTEXT_ONLY', 'REQUIRES_REVIEW', 'DO_NOT_USE');
CREATE TYPE "FactEvidenceOrigin" AS ENUM (
    'SOURCE_CONFIG', 'FEED', 'JSON_LD', 'OPEN_GRAPH', 'META',
    'HTML_TITLE', 'CANONICAL_LINK', 'PAGE', 'HEADING', 'ARTICLE_TEXT'
);

CREATE TABLE "source_fact_packs" (
    "id" SERIAL NOT NULL,
    "source_item_id" INTEGER NOT NULL,
    "enrichment_run_id" INTEGER NOT NULL,
    "extractor_version" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "status" "FactPackStatus" NOT NULL DEFAULT 'READY',
    "eligibility_basis" TEXT NOT NULL,
    -- 来源身份快照：ContentSource 配置后续会变，历史 pack 的身份必须停在生成那一刻
    "publisher_snapshot" TEXT NOT NULL,
    "source_tier_snapshot" "ContentSourceTier",
    "source_external_key_snapshot" TEXT,
    "requested_url_snapshot" TEXT NOT NULL,
    "final_url_snapshot" TEXT,
    "canonical_url_snapshot" TEXT,
    "document_title_snapshot" TEXT,
    "document_author_snapshot" TEXT,
    "document_published_at_snapshot" TIMESTAMP(3),
    "language_snapshot" TEXT,
    "content_quality_snapshot" TEXT NOT NULL,
    "content_hash_snapshot" TEXT,
    "visible_text_length_snapshot" INTEGER,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "claim_count" INTEGER NOT NULL DEFAULT 0,
    "evidence_count" INTEGER NOT NULL DEFAULT 0,
    "superseded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_fact_packs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "source_fact_claims" (
    "id" SERIAL NOT NULL,
    "fact_pack_id" INTEGER NOT NULL,
    "claim_key" TEXT NOT NULL,
    "claim_scope" "FactClaimScope" NOT NULL,
    "claim_type" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "predicate" TEXT NOT NULL,
    "object_type" "FactObjectType" NOT NULL,
    "object_text" TEXT,
    "object_number" DOUBLE PRECISION,
    "object_boolean" BOOLEAN,
    "object_datetime" TIMESTAMP(3),
    "object_url" TEXT,
    "object_json" JSONB,
    "certainty" "FactCertainty" NOT NULL,
    "usage" "FactUsage" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "is_vendor_claim" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_fact_claims_pkey" PRIMARY KEY ("id")
);

-- object 字段恰好一个有值。代码里也校验，这里是最后一道闸 ——
-- 同时写 object_text 和 object_datetime 的断言读起来会自相矛盾。
ALTER TABLE "source_fact_claims" ADD CONSTRAINT "source_fact_claims_object_one_of" CHECK (
    (CASE WHEN "object_text"     IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "object_number"   IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "object_boolean"  IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "object_datetime" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "object_url"      IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "object_json"     IS NULL THEN 0 ELSE 1 END)
  = 1
);

CREATE TABLE "source_fact_evidence" (
    "id" SERIAL NOT NULL,
    "claim_id" INTEGER NOT NULL,
    "source_item_id" INTEGER NOT NULL,
    "enrichment_run_id" INTEGER NOT NULL,
    "origin" "FactEvidenceOrigin" NOT NULL,
    "field_path" TEXT NOT NULL,
    "excerpt" TEXT,
    "excerpt_hash" TEXT,
    "source_url" TEXT,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_fact_evidence_pkey" PRIMARY KEY ("id")
);

-- excerpt 上限 500：证据是指针，不是第三方内容的副本
ALTER TABLE "source_fact_evidence" ADD CONSTRAINT "source_fact_evidence_excerpt_max_500"
    CHECK ("excerpt" IS NULL OR char_length("excerpt") <= 500);

CREATE UNIQUE INDEX "source_fact_packs_enrichment_run_id_extractor_version_key"
    ON "source_fact_packs"("enrichment_run_id", "extractor_version");
CREATE INDEX "source_fact_packs_source_item_id_created_at_idx"
    ON "source_fact_packs"("source_item_id", "created_at");
CREATE INDEX "source_fact_packs_status_created_at_idx"
    ON "source_fact_packs"("status", "created_at");
CREATE INDEX "source_fact_packs_content_hash_snapshot_idx"
    ON "source_fact_packs"("content_hash_snapshot");

CREATE UNIQUE INDEX "source_fact_claims_fact_pack_id_claim_key_key"
    ON "source_fact_claims"("fact_pack_id", "claim_key");
CREATE INDEX "source_fact_claims_fact_pack_id_claim_scope_idx"
    ON "source_fact_claims"("fact_pack_id", "claim_scope");
CREATE INDEX "source_fact_claims_claim_type_idx" ON "source_fact_claims"("claim_type");

CREATE UNIQUE INDEX "source_fact_evidence_claim_id_origin_field_path_excerpt_hash_key"
    ON "source_fact_evidence"("claim_id", "origin", "field_path", "excerpt_hash");
CREATE INDEX "source_fact_evidence_claim_id_idx" ON "source_fact_evidence"("claim_id");
CREATE INDEX "source_fact_evidence_source_item_id_captured_at_idx"
    ON "source_fact_evidence"("source_item_id", "captured_at");
CREATE INDEX "source_fact_evidence_enrichment_run_id_idx"
    ON "source_fact_evidence"("enrichment_run_id");

ALTER TABLE "source_fact_packs" ADD CONSTRAINT "source_fact_packs_source_item_id_fkey"
    FOREIGN KEY ("source_item_id") REFERENCES "source_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_fact_packs" ADD CONSTRAINT "source_fact_packs_enrichment_run_id_fkey"
    FOREIGN KEY ("enrichment_run_id") REFERENCES "source_item_enrichment_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_fact_claims" ADD CONSTRAINT "source_fact_claims_fact_pack_id_fkey"
    FOREIGN KEY ("fact_pack_id") REFERENCES "source_fact_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_fact_evidence" ADD CONSTRAINT "source_fact_evidence_claim_id_fkey"
    FOREIGN KEY ("claim_id") REFERENCES "source_fact_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_fact_evidence" ADD CONSTRAINT "source_fact_evidence_source_item_id_fkey"
    FOREIGN KEY ("source_item_id") REFERENCES "source_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_fact_evidence" ADD CONSTRAINT "source_fact_evidence_enrichment_run_id_fkey"
    FOREIGN KEY ("enrichment_run_id") REFERENCES "source_item_enrichment_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
