-- 人工审核与发布关联（纯加法：一个枚举值 + 四个可空列）
--
-- REJECTED_BY_REVIEWER 与 FAITHFULNESS_FAILED 刻意分开：
-- 前者是「忠实但编辑不想发」，后者是「偏离了来源」。混在一起会让
-- 「有多少稿子是因为质量问题被拦下的」这个问题永远答不清楚。

ALTER TYPE "ArticleStatus" ADD VALUE IF NOT EXISTS 'REJECTED_BY_REVIEWER';

ALTER TABLE "generated_articles" ADD COLUMN IF NOT EXISTS "reviewed_by" TEXT;
ALTER TABLE "generated_articles" ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMP(3);
ALTER TABLE "generated_articles" ADD COLUMN IF NOT EXISTS "review_notes" TEXT;
ALTER TABLE "generated_articles" ADD COLUMN IF NOT EXISTS "resource_content_id" INTEGER;
