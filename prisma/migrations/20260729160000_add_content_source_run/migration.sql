-- 采集运行遥测与错误归因（纯加法：两个新枚举 + 一张新表 + 一个可空列）
--
-- 动机：C3 Canary 首轮 AWS 那次「失败」其实是 Supabase 中断 —— 源根本没被请求，
-- 却被记成来源失败并触发退避。汇总状态说不清这种事，必须逐次留证，
-- 并且把「源坏了」和「我们这边坏了」在数据模型上分开。

CREATE TYPE "SourceRunOutcome" AS ENUM ('OK', 'NOT_MODIFIED', 'PARTIAL_SUCCESS', 'SOURCE_ERROR', 'INFRA_ERROR');

CREATE TYPE "SourceRunErrorDomain" AS ENUM ('NONE', 'DNS', 'NETWORK', 'TLS', 'HTTP', 'ROBOTS', 'PARSE', 'TRUNCATED', 'DATABASE', 'LEASE', 'INTERNAL');

CREATE TABLE "content_source_runs" (
    "id" SERIAL NOT NULL,
    "source_id" INTEGER NOT NULL,
    "job_id" INTEGER,
    "job_item_id" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "outcome" "SourceRunOutcome" NOT NULL,
    "error_domain" "SourceRunErrorDomain" NOT NULL DEFAULT 'NONE',
    "requested_feed_url" TEXT NOT NULL,
    "resolved_feed_url" TEXT,
    "http_status" INTEGER,
    "bytes_read" INTEGER,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "latency_dns_ms" INTEGER,
    "latency_fetch_ms" INTEGER,
    "latency_total_ms" INTEGER,
    "pinned_ip" TEXT,
    "redirect_count" INTEGER,
    "etag_sent" TEXT,
    "etag_received" TEXT,
    "last_modified_sent" TEXT,
    "last_modified_received" TEXT,
    "feed_format" TEXT,
    "items_parsed" INTEGER NOT NULL DEFAULT 0,
    "items_inserted" INTEGER NOT NULL DEFAULT 0,
    "items_duplicate" INTEGER NOT NULL DEFAULT 0,
    "items_title_changed" INTEGER NOT NULL DEFAULT 0,
    "items_errored" INTEGER NOT NULL DEFAULT 0,
    "source_updated_at_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "error_message" TEXT,
    "evidence_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_source_runs_pkey" PRIMARY KEY ("id")
);

-- 同一个 job 里同一个源只允许一条有效 run：worker 回收或重复驱动不会写第二条。
-- job_id 为 NULL 的手动 run 不受此约束（Postgres 视 NULL 互不相等）。
CREATE UNIQUE INDEX "content_source_runs_job_id_source_id_key" ON "content_source_runs"("job_id", "source_id");
CREATE INDEX "content_source_runs_source_id_started_at_idx" ON "content_source_runs"("source_id", "started_at");
CREATE INDEX "content_source_runs_outcome_started_at_idx" ON "content_source_runs"("outcome", "started_at");
CREATE INDEX "content_source_runs_error_domain_started_at_idx" ON "content_source_runs"("error_domain", "started_at");

ALTER TABLE "content_source_runs" ADD CONSTRAINT "content_source_runs_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "content_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 最近一次成功（OK / NOT_MODIFIED）的时刻；基础设施故障不得覆盖它
ALTER TABLE "content_sources" ADD COLUMN "last_success_at" TIMESTAMP(3);
