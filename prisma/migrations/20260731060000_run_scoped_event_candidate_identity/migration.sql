-- 把候选身份改成 run-scoped（约束修复，不删任何业务数据）
--
-- 根因：候选与边的唯一键里带的是 rule_version 而不是 run。
-- 于是「pack 27 是 singleton」这件事在同一规则版本下只能成立一次 ——
-- 换一批输入重跑时，所有沿用下来的 singleton 都会撞上上一次的记录，
-- 扩大输入集根本跑不起来。同理，一对 pack 一辈子只能被评分一次。
--
-- 聚类结果本质上是**一次 discovery run 的不可变快照**：同一个 pack 在不同
-- 输入集下本来就可能落进不同的候选结构，这不是冲突，是不同的观察。
--
-- 全程幂等：IF EXISTS / IF NOT EXISTS + 条件化回填，支持重复 replay。

-- ① member 补上 run 维度：先加可空列
ALTER TABLE "event_cluster_candidate_members"
    ADD COLUMN IF NOT EXISTS "clustering_run_id" INTEGER;

-- ② 从候选确定性回填（member 必属某个候选，候选必属某个 run）
UPDATE "event_cluster_candidate_members" m
SET "clustering_run_id" = c."clustering_run_id"
FROM "event_cluster_candidates" c
WHERE m."candidate_id" = c."id" AND m."clustering_run_id" IS NULL;

-- ③ 回填后不允许还有 NULL —— 有就说明存在孤儿 member，宁可整条 migration 失败
DO $$
DECLARE missing INTEGER;
BEGIN
    SELECT count(*) INTO missing FROM "event_cluster_candidate_members" WHERE "clustering_run_id" IS NULL;
    IF missing > 0 THEN
        RAISE EXCEPTION '回填后仍有 % 条 member 缺 clustering_run_id，中止', missing;
    END IF;
END $$;

ALTER TABLE "event_cluster_candidate_members"
    ALTER COLUMN "clustering_run_id" SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'event_cluster_candidate_members_clustering_run_id_fkey'
    ) THEN
        ALTER TABLE "event_cluster_candidate_members"
            ADD CONSTRAINT "event_cluster_candidate_members_clustering_run_id_fkey"
            FOREIGN KEY ("clustering_run_id") REFERENCES "event_clustering_runs"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- ④ 同一 run 内一个 pack 最多属于一个候选；**不**阻止跨 run 归属
CREATE UNIQUE INDEX IF NOT EXISTS "event_cluster_candidate_members_run_pack_key"
    ON "event_cluster_candidate_members"("clustering_run_id", "fact_pack_id");
CREATE INDEX IF NOT EXISTS "event_cluster_candidate_members_clustering_run_id_idx"
    ON "event_cluster_candidate_members"("clustering_run_id");

-- ⑤ 候选唯一键改为 run-scoped。先建新索引再删旧的，任何时刻都有约束在位。
CREATE UNIQUE INDEX IF NOT EXISTS "event_cluster_candidates_run_key_key"
    ON "event_cluster_candidates"("clustering_run_id", "candidate_key");
DROP INDEX IF EXISTS "event_cluster_candidates_rule_version_candidate_key_key";

-- ⑥ 边唯一键改为 run-scoped，同样先建后删
CREATE UNIQUE INDEX IF NOT EXISTS "event_similarity_edges_run_left_right_key"
    ON "event_similarity_edges"("clustering_run_id", "left_fact_pack_id", "right_fact_pack_id");
DROP INDEX IF EXISTS "event_similarity_edges_rule_version_left_right_key";
