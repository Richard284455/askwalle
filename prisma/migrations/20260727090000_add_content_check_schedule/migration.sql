-- 深度内容检查排期（纯加法，两列均可空）
-- HEAD 2xx 短路会跳过正文分类；这两列驱动按 tier 的周期性强制 GET。
ALTER TABLE "tool_lifecycle_states" ADD COLUMN "last_content_checked_at" TIMESTAMP(3);
ALTER TABLE "tool_lifecycle_states" ADD COLUMN "next_content_check_at" TIMESTAMP(3);

CREATE INDEX "tool_lifecycle_states_next_content_check_at_idx" ON "tool_lifecycle_states"("next_content_check_at");
