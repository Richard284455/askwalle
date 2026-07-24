-- 媒体本地化字段（纯加法，不 drop / rename / 修改已有列）
ALTER TABLE "tool_media" ADD COLUMN "original_url" TEXT;
ALTER TABLE "tool_media" ADD COLUMN "local_url" TEXT;
ALTER TABLE "tool_media" ADD COLUMN "cache_status" TEXT;
ALTER TABLE "tool_media" ADD COLUMN "cache_error" TEXT;
ALTER TABLE "tool_media" ADD COLUMN "cached_at" TIMESTAMP(3);
