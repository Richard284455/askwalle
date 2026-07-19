import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ToolImportBatchDetail } from "@/components/admin/tool-import-batch-detail";

export const dynamic = "force-dynamic";

export default async function ToolImportBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const batchId = parseInt((await params).batchId);
  if (Number.isNaN(batchId)) notFound();

  const batch = await prisma.toolImportBatch.findUnique({
    where: { id: batchId },
    include: { files: { orderBy: { id: "asc" } } },
  });
  if (!batch) notFound();

  const toolCount = await prisma.website.count({
    where: { import_batch_id: batchId },
  });

  return (
    <div>
      <ToolImportBatchDetail
        batch={{
          id: batch.id,
          name: batch.name,
          fileCount: batch.file_count,
          rowCount: batch.row_count,
          importedCount: batch.imported_count,
          skippedCount: batch.skipped_count,
          errorCount: batch.error_count,
          startedAt: batch.started_at.toISOString(),
          finishedAt: batch.finished_at?.toISOString() ?? null,
          toolCount,
          files: batch.files.map((f) => ({
            id: f.id,
            fileName: f.file_name,
            rowCount: f.row_count,
            importedCount: f.imported_count,
            skippedCount: f.skipped_count,
            errorCount: f.error_count,
            errorLog: f.error_log,
            level1: f.level1_category,
            level2: f.level2_category,
          })),
        }}
      />
    </div>
  );
}
