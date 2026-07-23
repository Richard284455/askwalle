import { getReviewList, getReviewStats } from "@/lib/website/tool-review";
import { getAdminCategoryOptions } from "@/lib/website/tool-admin";
import { listRewriteBatches } from "@/lib/website/tool-rewrite-batch";
import { ToolReviewClient } from "@/components/admin/tool-review-client";

export const dynamic = "force-dynamic";

export default async function ToolReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ rewriteBatchId?: string; tab?: string }>;
}) {
  const { rewriteBatchId, tab } = await searchParams;
  const presetBatchId =
    rewriteBatchId && !Number.isNaN(parseInt(rewriteBatchId))
      ? parseInt(rewriteBatchId)
      : null;
  // 默认 Tab「待审核」= draft_generated + qc passed
  const presetTab = tab ?? "review";

  const [items, categories, batches, stats] = await Promise.all([
    getReviewList({
      rewriteStatus: "draft_generated",
      qcStatus: "passed",
      ...(presetBatchId ? { rewriteBatchId: presetBatchId } : {}),
    }).catch(() => []),
    getAdminCategoryOptions(),
    listRewriteBatches().catch(() => []),
    getReviewStats().catch(() => null),
  ]);

  return (
    <div>
      <ToolReviewClient
        initialItems={items}
        initialStats={stats}
        categories={categories}
        presetBatchId={presetBatchId}
        presetTab={presetTab}
        batches={batches.map((b) => ({
          id: b.id,
          label: `#${b.id} ${b.name ?? ""} (${b.provider}/${b.model})`,
        }))}
      />
    </div>
  );
}
