import type { Metadata } from "next";
import { GraduationCap } from "lucide-react";
import { ResourceListClient } from "@/components/resources/resource-list-client";
import { ResourceHero } from "@/components/resources/resource-hero";
import {
  getResourcesByType,
  resourceContentToResourceItem,
} from "@/lib/resources/resource-content";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Skills Library - AskWalle AI Hub",
  description:
    "Learn repeatable AI workflow skills for research, content, prompting, support, coding, and operations.",
};

export default async function SkillsPage() {
  const resources = await getResourcesByType("SKILL");
  const items = resources.map(resourceContentToResourceItem);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-background">
      <ResourceHero
        icon={<GraduationCap className="h-3.5 w-3.5" />}
        title="Skills Library"
        description="Build repeatable AI workflows with practical skills, step-by-step patterns, related tool ideas, and quality checks."
      />
      <main className="container mx-auto px-4 py-8 lg:py-10">
        <ResourceListClient
          items={items}
          searchPlaceholder="Search skills by workflow, category, or tag"
          emptyTitle="No skills match your filters"
          emptyDescription="No published skill records are available yet, or the current filters are too narrow."
        />
      </main>
    </div>
  );
}
