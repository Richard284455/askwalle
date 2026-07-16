import {
  getAdminCategoryOptions,
  getAdminTools,
} from "@/lib/website/tool-admin";
import { ToolAdminList } from "@/components/admin/tool-admin-list";

export const dynamic = "force-dynamic";

export default async function AdminToolsPage() {
  const [tools, categories] = await Promise.all([
    getAdminTools(),
    getAdminCategoryOptions(),
  ]);

  return (
    <div>
      <ToolAdminList initialTools={tools} categories={categories} />
    </div>
  );
}
