-- story 素材 + 未筛选全量流。
--
-- 纯加法：加枚举值、加列。
-- （prisma migrate dev 生成时照例混入了与本次无关的 DropIndex / RenameIndex /
--   重建外键 —— 那些是更早的手写迁移留下的漂移，已逐条剔除。）

-- AlterEnum：未筛选条目流作为独立任务类型，独立租约与审计
ALTER TYPE "AihotTaskType" ADD VALUE 'ITEMS_ALL';

-- AlterTable：热点的 story 素材
-- publicId 只能从 links.story 末段提取，不得自行拼接
ALTER TABLE "aihot_hot_topic_snapshots"
  ADD COLUMN "story_public_id" TEXT,
  ADD COLUMN "story_digest" TEXT,
  ADD COLUMN "story_digest_updated_at" TIMESTAMP(3),
  ADD COLUMN "story_reports_json" JSONB,
  ADD COLUMN "story_report_count" INTEGER;

-- AlterTable：区分「从未入选」与「被取消精选」
-- 未筛选流带进来的条目 selected=false 且 deselected_at IS NULL
ALTER TABLE "aihot_selected_items" ADD COLUMN "deselected_at" TIMESTAMP(3);
