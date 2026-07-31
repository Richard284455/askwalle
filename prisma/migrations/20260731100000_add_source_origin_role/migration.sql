-- 发布者身份关系（纯加法：一个枚举 + 两个可空列）
--
-- 与 ContentSourceTier 正交：tier 说的是「这个源能支撑多强的事实主张」，
-- origin role 说的是「这份材料的作者与事件主体是什么关系」。
--
-- 刻意**不**表达 primary/secondary。DOE 对自己的 Genesis Mission 计划是
-- originating，对 Google 的捐赠公告却是 independent —— 同一个源在不同文档上
-- 关系不同，所以那个结论留到 candidate review 层，不在来源上固化。
--
-- 历史 pack 一律留 NULL：不可变快照不回填。

CREATE TYPE "SourceOriginRole" AS ENUM (
    'ORIGINATING_AUTHORITY',
    'INDEPENDENT_AUTHORITY',
    'INDEPENDENT_REPORTING',
    'SAME_ORIGIN_DIFFERENT_CHANNEL',
    'UNCLASSIFIED'
);

ALTER TABLE "content_sources" ADD COLUMN IF NOT EXISTS "origin_role" "SourceOriginRole";
ALTER TABLE "source_fact_packs" ADD COLUMN IF NOT EXISTS "source_origin_role_snapshot" "SourceOriginRole";
