-- 任务级租约：多实例部署时保证同一个 job 同时只被一个 worker 推进。
-- 条目级 atomic claim 已经保证不会重复执行，但每多一个 worker 就多一路
-- provider 并发；租约把并发收敛回 1，避免打爆限流 / 账单失控。
-- 纯加法：仅 ADD COLUMN，两列均可空，对既有行与旧代码完全无影响。
ALTER TABLE "bulk_jobs" ADD COLUMN "locked_by" TEXT;
ALTER TABLE "bulk_jobs" ADD COLUMN "locked_until" TIMESTAMP(3);
