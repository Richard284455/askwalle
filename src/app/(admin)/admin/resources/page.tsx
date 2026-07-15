import { getAdminResources } from "@/lib/resources/resource-admin";
import { ResourceList } from "@/components/admin/resource-list";

export const dynamic = "force-dynamic";

export default async function AdminResourcesPage() {
  const resources = await getAdminResources();

  return (
    <div>
      <ResourceList initialResources={resources} />
    </div>
  );
}
