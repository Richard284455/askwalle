import { notFound } from "next/navigation";
import { getBulkJob } from "@/lib/website/bulk-job";
import { BulkJobDetail } from "@/components/admin/bulk-job-detail";

export const dynamic = "force-dynamic";

export default async function BulkJobDetailPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const jobId = parseInt((await params).jobId);
  if (Number.isNaN(jobId)) notFound();
  const job = await getBulkJob(jobId).catch(() => null);
  if (!job) notFound();
  return (
    <div>
      <BulkJobDetail initialJob={job} />
    </div>
  );
}
