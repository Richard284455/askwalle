-- 事件候选发现（纯加法：五个枚举 + 四张表）
--
-- 这里产出的**只是候选**，不是「这两篇讲的是同一件事」的结论。
-- 标题相似、同一天发布、同一个域名，任何一条单独都不足以确认同一事件；
-- 传递性合并（A≈B、B≈C ⇒ A≈C）被显式禁止，只有「指向同一份文档」
-- 这种确定关系才允许求连通分量。

CREATE TYPE "ClusteringRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED');
CREATE TYPE "EdgeClassification" AS ENUM ('EXACT_DOCUMENT_MATCH', 'STRONG_REVIEW_CANDIDATE', 'WEAK_REVIEW_CANDIDATE', 'NO_MATCH');
CREATE TYPE "EdgeReviewStatus" AS ENUM ('PENDING', 'APPROVED_SAME_EVENT', 'REJECTED_DIFFERENT_EVENT', 'UNCLEAR');
CREATE TYPE "ClusterCandidateType" AS ENUM ('SINGLETON', 'EXACT_DOCUMENT_GROUP');
CREATE TYPE "ClusterCandidateStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED');

CREATE TABLE "event_clustering_runs" (
    "id" SERIAL NOT NULL,
    "rule_version" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "status" "ClusteringRunStatus" NOT NULL DEFAULT 'RUNNING',
    "input_pack_count" INTEGER NOT NULL DEFAULT 0,
    "eligible_pack_count" INTEGER NOT NULL DEFAULT 0,
    "pair_count" INTEGER NOT NULL DEFAULT 0,
    "persisted_edge_count" INTEGER NOT NULL DEFAULT 0,
    "exact_group_count" INTEGER NOT NULL DEFAULT 0,
    "singleton_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "result_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_clustering_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "event_similarity_edges" (
    "id" SERIAL NOT NULL,
    "clustering_run_id" INTEGER NOT NULL,
    "left_fact_pack_id" INTEGER NOT NULL,
    "right_fact_pack_id" INTEGER NOT NULL,
    "rule_version" TEXT NOT NULL,
    "pair_hash" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "classification" "EdgeClassification" NOT NULL,
    "reason_codes_json" JSONB,
    "features_json" JSONB,
    "review_status" "EdgeReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_similarity_edges_pkey" PRIMARY KEY ("id")
);

-- 顺序规范化写进数据库：传入顺序不同不得产生两条边
ALTER TABLE "event_similarity_edges" ADD CONSTRAINT "event_similarity_edges_ordered"
    CHECK ("left_fact_pack_id" < "right_fact_pack_id");
-- NO_MATCH 不落库
ALTER TABLE "event_similarity_edges" ADD CONSTRAINT "event_similarity_edges_no_match_not_stored"
    CHECK ("classification" <> 'NO_MATCH');

CREATE TABLE "event_cluster_candidates" (
    "id" SERIAL NOT NULL,
    "clustering_run_id" INTEGER NOT NULL,
    "candidate_key" TEXT NOT NULL,
    "candidate_type" "ClusterCandidateType" NOT NULL,
    "status" "ClusterCandidateStatus" NOT NULL DEFAULT 'PROPOSED',
    "anchor_fact_pack_id" INTEGER NOT NULL,
    "display_title_snapshot" TEXT,
    "event_time_start" TIMESTAMP(3),
    "event_time_end" TIMESTAMP(3),
    "pack_count" INTEGER NOT NULL DEFAULT 1,
    "publisher_count" INTEGER NOT NULL DEFAULT 1,
    "rule_version" TEXT NOT NULL,
    "reason_codes_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_cluster_candidates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "event_cluster_candidate_members" (
    "id" SERIAL NOT NULL,
    "candidate_id" INTEGER NOT NULL,
    "fact_pack_id" INTEGER NOT NULL,
    "is_anchor" BOOLEAN NOT NULL DEFAULT false,
    "membership_basis" TEXT NOT NULL,
    "membership_score" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_cluster_candidate_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "event_clustering_runs_rule_version_input_hash_key"
    ON "event_clustering_runs"("rule_version", "input_hash");
CREATE INDEX "event_clustering_runs_status_started_at_idx"
    ON "event_clustering_runs"("status", "started_at");

CREATE UNIQUE INDEX "event_similarity_edges_rule_version_left_right_key"
    ON "event_similarity_edges"("rule_version", "left_fact_pack_id", "right_fact_pack_id");
CREATE INDEX "event_similarity_edges_classification_score_idx"
    ON "event_similarity_edges"("classification", "score");
CREATE INDEX "event_similarity_edges_review_status_created_at_idx"
    ON "event_similarity_edges"("review_status", "created_at");

CREATE UNIQUE INDEX "event_cluster_candidates_rule_version_candidate_key_key"
    ON "event_cluster_candidates"("rule_version", "candidate_key");
CREATE INDEX "event_cluster_candidates_status_created_at_idx"
    ON "event_cluster_candidates"("status", "created_at");
CREATE INDEX "event_cluster_candidates_candidate_type_created_at_idx"
    ON "event_cluster_candidates"("candidate_type", "created_at");

CREATE UNIQUE INDEX "event_cluster_candidate_members_candidate_id_fact_pack_id_key"
    ON "event_cluster_candidate_members"("candidate_id", "fact_pack_id");
CREATE INDEX "event_cluster_candidate_members_fact_pack_id_idx"
    ON "event_cluster_candidate_members"("fact_pack_id");

ALTER TABLE "event_similarity_edges" ADD CONSTRAINT "event_similarity_edges_clustering_run_id_fkey"
    FOREIGN KEY ("clustering_run_id") REFERENCES "event_clustering_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "event_similarity_edges" ADD CONSTRAINT "event_similarity_edges_left_fact_pack_id_fkey"
    FOREIGN KEY ("left_fact_pack_id") REFERENCES "source_fact_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "event_similarity_edges" ADD CONSTRAINT "event_similarity_edges_right_fact_pack_id_fkey"
    FOREIGN KEY ("right_fact_pack_id") REFERENCES "source_fact_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "event_cluster_candidates" ADD CONSTRAINT "event_cluster_candidates_clustering_run_id_fkey"
    FOREIGN KEY ("clustering_run_id") REFERENCES "event_clustering_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "event_cluster_candidates" ADD CONSTRAINT "event_cluster_candidates_anchor_fact_pack_id_fkey"
    FOREIGN KEY ("anchor_fact_pack_id") REFERENCES "source_fact_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "event_cluster_candidate_members" ADD CONSTRAINT "event_cluster_candidate_members_candidate_id_fkey"
    FOREIGN KEY ("candidate_id") REFERENCES "event_cluster_candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "event_cluster_candidate_members" ADD CONSTRAINT "event_cluster_candidate_members_fact_pack_id_fkey"
    FOREIGN KEY ("fact_pack_id") REFERENCES "source_fact_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
