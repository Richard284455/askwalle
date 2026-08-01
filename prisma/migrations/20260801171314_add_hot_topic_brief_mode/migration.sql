-- 热点简报模式：SIGNAL / ENRICHED
--
-- **纯加法**：一个新枚举 + 两列可空字段。
-- Prisma 夹带的既有对象删索引/改名（历史命名漂移）已剔除。

-- CreateEnum
CREATE TYPE "HotTopicBriefMode" AS ENUM ('SIGNAL', 'ENRICHED');

-- AlterTable
ALTER TABLE "article_families" ADD COLUMN     "hot_topic_mode" "HotTopicBriefMode";
