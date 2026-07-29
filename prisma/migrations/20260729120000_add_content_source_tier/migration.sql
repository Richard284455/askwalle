-- 来源分级与稳定身份键（纯加法：一个新枚举 + 三个可空列）
--
-- source_tier 是承重字段：它决定这个源能支撑什么强度的事实主张，
-- 也是已冻结的正文抓取策略（OFFICIAL_PRIMARY→ON_DEMAND、
-- STRUCTURED_TECHNICAL→FEED_ONLY …）的键。
-- external_key：feed_url 可能迁移，配置文件与库之间靠这个对齐。
-- declared_format：定义文件声明 RSS/ATOM，解析器会自行探测；两者不符值得报警。
CREATE TYPE "ContentSourceTier" AS ENUM ('OFFICIAL_PRIMARY', 'STRUCTURED_TECHNICAL', 'AUTHORITATIVE_MEDIA', 'COMMUNITY_SIGNAL');

ALTER TABLE "content_sources" ADD COLUMN "external_key" TEXT;
ALTER TABLE "content_sources" ADD COLUMN "declared_format" TEXT;
ALTER TABLE "content_sources" ADD COLUMN "source_tier" "ContentSourceTier";

CREATE UNIQUE INDEX "content_sources_external_key_key" ON "content_sources"("external_key");
