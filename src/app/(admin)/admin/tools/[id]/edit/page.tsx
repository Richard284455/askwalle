import { notFound } from "next/navigation";
import {
  getAdminCategoryOptions,
  getAdminToolById,
} from "@/lib/website/tool-admin";
import { ToolEditForm } from "@/components/admin/tool-edit-form";

export const dynamic = "force-dynamic";

export default async function EditToolPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = parseInt((await params).id);
  if (Number.isNaN(id)) {
    notFound();
  }

  const [tool, categories] = await Promise.all([
    getAdminToolById(id),
    getAdminCategoryOptions(),
  ]);

  if (!tool) {
    notFound();
  }

  return (
    <div>
      <ToolEditForm initialTool={tool} categories={categories} />
    </div>
  );
}
