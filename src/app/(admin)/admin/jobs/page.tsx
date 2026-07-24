import { listBulkJobs } from "@/lib/website/bulk-job";
import { BulkJobList } from "@/components/admin/bulk-job-list";

export const dynamic = "force-dynamic";

export default async function BulkJobsPage() {
  const jobs = await listBulkJobs().catch(() => []);
  return (
    <div>
      <BulkJobList initialJobs={jobs} />
    </div>
  );
}
