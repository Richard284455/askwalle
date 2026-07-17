import {
  getDefaultProvider,
  listRewriteBatches,
  listRewriteProviders,
} from "@/lib/website/tool-rewrite-batch";
import { getAdminCategoryOptions } from "@/lib/website/tool-admin";
import { RewriteBatchList } from "@/components/admin/rewrite-batch-list";

export const dynamic = "force-dynamic";

export default async function RewriteBatchesPage() {
  const [batches, categories] = await Promise.all([
    listRewriteBatches().catch(() => []),
    getAdminCategoryOptions(),
  ]);

  return (
    <div>
      <RewriteBatchList
        initialBatches={batches}
        categories={categories}
        providers={listRewriteProviders()}
        defaultProvider={getDefaultProvider()}
      />
    </div>
  );
}
