import { notFound } from "next/navigation";
import { getAdminResourceById } from "@/lib/resources/resource-admin";
import { ResourceForm } from "@/components/admin/resource-form";

export const dynamic = "force-dynamic";

export default async function EditResourcePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = parseInt((await params).id);
  if (Number.isNaN(id)) {
    notFound();
  }

  const resource = await getAdminResourceById(id);
  if (!resource) {
    notFound();
  }

  return (
    <div>
      <ResourceForm initialResource={resource} />
    </div>
  );
}
