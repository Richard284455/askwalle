import {
  getErrorKindBreakdown,
  getLifecycleList,
  getLifecycleStats,
} from "@/lib/website/tool-lifecycle";
import { ToolLifecycleClient } from "@/components/admin/tool-lifecycle-client";

export const dynamic = "force-dynamic";

export default async function ToolLifecyclePage() {
  const [stats, breakdown, page] = await Promise.all([
    getLifecycleStats().catch(() => null),
    getErrorKindBreakdown().catch(() => []),
    getLifecycleList({}, { page: 1, pageSize: 50 }).catch(() => ({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
    })),
  ]);

  const initial = stats ? { stats, breakdown, ...page } : null;
  return <ToolLifecycleClient initial={initial} />;
}
