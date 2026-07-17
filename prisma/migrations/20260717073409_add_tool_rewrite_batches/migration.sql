-- CreateTable
CREATE TABLE "tool_rewrite_batches" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'openai',
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "filter_snapshot" JSONB,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "submitted_count" INTEGER NOT NULL DEFAULT 0,
    "completed_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "qc_passed_count" INTEGER NOT NULL DEFAULT 0,
    "qc_failed_count" INTEGER NOT NULL DEFAULT 0,
    "openai_batch_id" TEXT,
    "input_file_id" TEXT,
    "output_file_id" TEXT,
    "error_file_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_rewrite_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_rewrite_items" (
    "id" SERIAL NOT NULL,
    "batch_id" INTEGER NOT NULL,
    "website_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "custom_id" TEXT NOT NULL,
    "prompt" TEXT,
    "raw_output" JSONB,
    "parsed_draft" JSONB,
    "qc_status" TEXT,
    "qc_errors" JSONB,
    "error_message" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_rewrite_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tool_rewrite_items_custom_id_key" ON "tool_rewrite_items"("custom_id");

-- CreateIndex
CREATE INDEX "tool_rewrite_items_batch_id_idx" ON "tool_rewrite_items"("batch_id");

-- CreateIndex
CREATE INDEX "tool_rewrite_items_website_id_idx" ON "tool_rewrite_items"("website_id");

-- AddForeignKey
ALTER TABLE "tool_rewrite_items" ADD CONSTRAINT "tool_rewrite_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "tool_rewrite_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_rewrite_items" ADD CONSTRAINT "tool_rewrite_items_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
