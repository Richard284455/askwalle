import type { Metadata } from "next";
import { Sparkles } from "lucide-react";
import { ResourceListClient } from "@/components/resources/resource-list-client";
import { ResourceHero } from "@/components/resources/resource-hero";
import {
  getResourcesByType,
  resourceContentToResourceItem,
} from "@/lib/resources/resource-content";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Prompt Library - AskWalle AI Hub",
  description:
    "Find original prompt templates for productivity, marketing, coding, research, and business workflows.",
};

export default async function PromptsPage() {
  const resources = await getResourcesByType("PROMPT");
  const items = resources.map(resourceContentToResourceItem);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-background">
      <ResourceHero
        icon={<Sparkles className="h-3.5 w-3.5" />}
        title="Prompt Library"
        description="Browse reusable, original prompt templates for everyday AI workflows. Filter by use case, category, or difficulty."
      />
      <main className="container mx-auto px-4 py-8 lg:py-10">
        <ResourceListClient
          items={items}
          searchPlaceholder="Search prompts by task, use case, or tag"
          emptyTitle="No prompts match your filters"
          emptyDescription="No published prompt records are available yet, or the current filters are too narrow."
        />
      </main>
    </div>
  );
}
