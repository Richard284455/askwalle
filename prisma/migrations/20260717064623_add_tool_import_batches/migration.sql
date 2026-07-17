-- CreateTable
CREATE TABLE "tool_import_batches" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "source_dir" TEXT,
    "file_count" INTEGER NOT NULL DEFAULT 0,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "imported_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "tool_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_import_files" (
    "id" SERIAL NOT NULL,
    "batch_id" INTEGER NOT NULL,
    "file_path" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "imported_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "error_log" TEXT,
    "level1_category" TEXT,
    "level2_category" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_import_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tool_import_files_batch_id_idx" ON "tool_import_files"("batch_id");

-- AddForeignKey
ALTER TABLE "tool_import_files" ADD CONSTRAINT "tool_import_files_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "tool_import_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
