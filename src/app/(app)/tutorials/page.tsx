import type { Metadata } from "next";
import { BookOpen } from "lucide-react";
import { ResourceListClient } from "@/components/resources/resource-list-client";
import { ResourceHero } from "@/components/resources/resource-hero";
import {
  getResourcesByType,
  resourceContentToResourceItem,
} from "@/lib/resources/resource-content";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "AI Tutorials - AskWalle AI Hub",
  description:
    "Follow practical AI tutorials for comparing tools, testing prompts, research workflows, product planning, and automation design.",
};

export default async function TutorialsPage() {
  const resources = await getResourcesByType("TUTORIAL");
  const items = resources.map(resourceContentToResourceItem);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-background">
      <ResourceHero
        icon={<BookOpen className="h-3.5 w-3.5" />}
        title="AI Tutorials"
        description="Learn practical AI workflows through concise tutorials with clear steps, estimated time, outcomes, and beginner-friendly guidance."
      />
      <main className="container mx-auto px-4 py-8 lg:py-10">
        <ResourceListClient
          items={items}
          searchPlaceholder="Search tutorials by workflow, level, or tag"
          emptyTitle="No tutorials match your filters"
          emptyDescription="No published tutorial records are available yet, or the current filters are too narrow."
        />
      </main>
    </div>
  );
}
