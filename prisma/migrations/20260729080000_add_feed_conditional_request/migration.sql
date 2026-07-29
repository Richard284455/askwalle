-- C3 Canary 前置：条件请求、源迁移记录、条目修订时间（纯加法，四个可空列）
--
-- etag / last_modified：带上条件请求头，源没更新时拿 304，省流量也更礼貌。
-- resolved_feed_url：跟随重定向后的实际地址。与 feed_url 不同即说明源迁移了 ——
--   **不自动改配置**，只记录，等人工确认（沿用工具域名迁移不自动改 URL 的同一条纪律）。
-- source_updated_at：条目自称的最后修改时间，用于识别「同一 URL 内容被改过」。
ALTER TABLE "content_sources" ADD COLUMN "etag" TEXT;
ALTER TABLE "content_sources" ADD COLUMN "last_modified" TEXT;
ALTER TABLE "content_sources" ADD COLUMN "resolved_feed_url" TEXT;

ALTER TABLE "source_items" ADD COLUMN "source_updated_at" TIMESTAMP(3);
