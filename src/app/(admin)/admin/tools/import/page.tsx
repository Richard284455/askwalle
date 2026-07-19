import { prisma } from "@/lib/prisma";
import { ToolImportClient } from "@/components/admin/tool-import-client";

export const dynamic = "force-dynamic";

export default async function ToolImportPage() {
  const batches = await prisma.toolImportBatch
    .findMany({ orderBy: { id: "desc" }, take: 50 })
    .catch(() => []);

  return (
    <div>
      <ToolImportClient
        initialBatches={batches.map((b) => ({
          id: b.id,
          name: b.name,
          fileCount: b.file_count,
          importedCount: b.imported_count,
          skippedCount: b.skipped_count,
          errorCount: b.error_count,
          startedAt: b.started_at.toISOString(),
        }))}
      />
    </div>
  );
}
