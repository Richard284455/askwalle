-- 工具生命周期（P0a）：纯加法，不改动任何现有表/列
-- 不触碰 websites.status / websites.active

-- CreateTable
CREATE TABLE "tool_lifecycle_states" (
    "website_id" INTEGER NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'standard',
    "tier_locked" BOOLEAN NOT NULL DEFAULT false,
    "reach" TEXT NOT NULL DEFAULT 'unknown',
    "reach_since" TIMESTAMP(3),
    "last_ok_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "next_check_at" TIMESTAMP(3),
    "consecutive_fails" INTEGER NOT NULL DEFAULT 0,
    "distinct_fail_dates" INTEGER NOT NULL DEFAULT 0,
    "first_fail_at" TIMESTAMP(3),
    "last_fail_date" TEXT,
    "fail_family" TEXT,
    "last_error_kind" TEXT,
    "final_url" TEXT,
    "archive_url" TEXT,
    "needs_manual_check" BOOLEAN NOT NULL DEFAULT false,
    "probe_version" INTEGER,
    "freshness" TEXT,
    "last_snapshot_id" INTEGER,
    "drift_score" DOUBLE PRECISION,
    "drift_fields" JSONB,
    "refresh_batch_id" INTEGER,
    "human_decision" TEXT,
    "decided_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_lifecycle_states_pkey" PRIMARY KEY ("website_id")
);

-- CreateTable
CREATE TABLE "tool_health_events" (
    "id" SERIAL NOT NULL,
    "website_id" INTEGER NOT NULL,
    "round_id" TEXT NOT NULL,
    "probe_version" INTEGER NOT NULL,
    "job_id" INTEGER,
    "round_date" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "error_kind" TEXT,
    "error_family" TEXT,
    "evidence_strength" TEXT,
    "confidence" TEXT NOT NULL DEFAULT 'high',
    "change_flags" TEXT[],
    "reach_from" TEXT,
    "reach_to" TEXT,
    "final_status" INTEGER,
    "final_url" TEXT,
    "latency_ms" INTEGER,
    "content_verdict" TEXT,
    "evidence" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_health_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tool_lifecycle_states_reach_idx" ON "tool_lifecycle_states"("reach");
CREATE INDEX "tool_lifecycle_states_next_check_at_idx" ON "tool_lifecycle_states"("next_check_at");
CREATE INDEX "tool_lifecycle_states_tier_freshness_idx" ON "tool_lifecycle_states"("tier", "freshness");
CREATE INDEX "tool_lifecycle_states_needs_manual_check_idx" ON "tool_lifecycle_states"("needs_manual_check");

CREATE INDEX "tool_health_events_website_id_created_at_idx" ON "tool_health_events"("website_id", "created_at");
CREATE INDEX "tool_health_events_created_at_idx" ON "tool_health_events"("created_at");
CREATE INDEX "tool_health_events_outcome_idx" ON "tool_health_events"("outcome");
CREATE INDEX "tool_health_events_round_id_idx" ON "tool_health_events"("round_id");

-- AddForeignKey
ALTER TABLE "tool_lifecycle_states" ADD CONSTRAINT "tool_lifecycle_states_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tool_health_events" ADD CONSTRAINT "tool_health_events_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
