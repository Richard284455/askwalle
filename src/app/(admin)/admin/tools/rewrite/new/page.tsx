import {
  getDefaultProvider,
  listRewriteProviders,
} from "@/lib/website/tool-rewrite-batch";
import { getAdminCategoryOptions } from "@/lib/website/tool-admin";
import { prisma } from "@/lib/prisma";
import { RewriteWizard } from "@/components/admin/rewrite-wizard";

export const dynamic = "force-dynamic";

export default async function NewRewriteBatchPage({
  searchParams,
}: {
  searchParams: Promise<{ importBatchId?: string }>;
}) {
  const { importBatchId } = await searchParams;
  const [categories, providers, importBatches] = await Promise.all([
    getAdminCategoryOptions(),
    listRewriteProviders().catch(() => []),
    prisma.toolImportBatch
      .findMany({ orderBy: { id: "desc" }, take: 50 })
      .catch(() => []),
  ]);

  return (
    <div>
      <RewriteWizard
        categories={categories}
        providers={providers}
        defaultProvider={getDefaultProvider()}
        importBatches={importBatches.map((b) => ({
          id: b.id,
          label: `#${b.id} ${b.name ?? ""} (${b.imported_count} 条)`,
        }))}
        presetImportBatchId={
          importBatchId && !Number.isNaN(parseInt(importBatchId))
            ? parseInt(importBatchId)
            : null
        }
      />
    </div>
  );
}
