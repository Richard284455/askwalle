-- round_id 唯一约束（纯加法：只加一个唯一索引，删掉它被取代的普通索引）
--
-- round_id = {job_id}:{website_id}:{Asia/Shanghai 日期}，本就是确定性幂等键。
-- 但此前只有普通索引，worker 回收僵死条目后重跑同一轮时，数据库照单全收：
-- Full Sweep #141 里 website #383 因此写了两条事件。本轮 outcome 是
-- unsafe_target 才没造成损失；换成失败类，consecutive_fails 会同日重复累加。
--
-- 前置：重复行已由 d4-fix-duplicate 处理（保留最早一条为 canonical，
-- 副本改写 round_id 为 {原值}:invalidated:{id} 并在 evidence 标注），
-- 没有删除任何历史事件。
DROP INDEX IF EXISTS "tool_health_events_round_id_idx";

CREATE UNIQUE INDEX "tool_health_events_round_id_key" ON "tool_health_events"("round_id");
