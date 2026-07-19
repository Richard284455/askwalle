-- AlterTable
ALTER TABLE "websites" ADD COLUMN     "import_batch_id" INTEGER;

-- CreateIndex
CREATE INDEX "websites_import_batch_id_idx" ON "websites"("import_batch_id");
