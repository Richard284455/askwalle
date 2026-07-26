-- QC 未通过与「AI 调用失败」是两回事：前者是模型答了但内容不合格（重试无用，
-- 要改 prompt），后者是请求本身失败（重试有用）。此前都记成 failed，任务页上
-- 看不出区别，熔断器也会被 QC 失败误触发。
-- 纯加法：新增一列，默认 0，对既有行与旧代码无影响。
ALTER TABLE "bulk_jobs" ADD COLUMN "qc_failed_count" INTEGER NOT NULL DEFAULT 0;
