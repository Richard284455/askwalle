import { getReviewList } from "@/lib/website/tool-review";
import { getAdminCategoryOptions } from "@/lib/website/tool-admin";
import { listRewriteBatches } from "@/lib/website/tool-rewrite-batch";
import { ToolReviewClient } from "@/components/admin/tool-review-client";

export const dynamic = "force-dynamic";

export default async function ToolReviewPage() {
  const [items, categories, batches] = await Promise.all([
    getReviewList({ rewriteStatus: "draft_generated" }).catch(() => []),
    getAdminCategoryOptions(),
    listRewriteBatches().catch(() => []),
  ]);

  return (
    <div>
      <ToolReviewClient
        initialItems={items}
        categories={categories}
        batches={batches.map((b) => ({
          id: b.id,
          label: `#${b.id} ${b.name ?? ""} (${b.provider}/${b.model})`,
        }))}
      />
    </div>
  );
}
