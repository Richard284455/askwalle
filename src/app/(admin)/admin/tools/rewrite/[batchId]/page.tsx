import { notFound } from "next/navigation";
import {
  getRewriteBatch,
  listRewriteProviders,
} from "@/lib/website/tool-rewrite-batch";
import { RewriteBatchDetailView } from "@/components/admin/rewrite-batch-detail";

export const dynamic = "force-dynamic";

export default async function RewriteBatchDetailPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const batchId = parseInt((await params).batchId);
  if (Number.isNaN(batchId)) {
    notFound();
  }

  const batch = await getRewriteBatch(batchId);
  if (!batch) {
    notFound();
  }

  const providers = await listRewriteProviders();
  const providerInfo = providers.find((p) => p.id === batch.provider) ?? null;

  return (
    <div>
      <RewriteBatchDetailView
        initialBatch={batch}
        providerHasKey={providerInfo?.hasKey ?? false}
        providerKeyEnv={providerInfo?.keyEnv ?? "OPENAI_API_KEY"}
      />
    </div>
  );
}
