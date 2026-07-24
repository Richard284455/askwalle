-- 通用后台批量任务表（纯加法：仅 CREATE TABLE / CREATE INDEX / ADD CONSTRAINT）
CREATE TABLE "bulk_jobs" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "params" JSONB,
    "result" JSONB,
    "error" JSONB,
    "related_import_batch_id" INTEGER,
    "related_rewrite_batch_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bulk_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bulk_job_items" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "website_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bulk_job_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bulk_jobs_type_status_idx" ON "bulk_jobs"("type", "status");
CREATE INDEX "bulk_job_items_job_id_status_idx" ON "bulk_job_items"("job_id", "status");
CREATE INDEX "bulk_job_items_website_id_idx" ON "bulk_job_items"("website_id");

ALTER TABLE "bulk_job_items" ADD CONSTRAINT "bulk_job_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "bulk_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
