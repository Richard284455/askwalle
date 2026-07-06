import type { Metadata } from "next";
import { ScrollText } from "lucide-react";
import { ResourceListClient } from "@/components/resources/resource-list-client";
import { ResourceHero } from "@/components/resources/resource-hero";
import {
  getResourcesByType,
  resourceContentToResourceItem,
} from "@/lib/resources/resource-content";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "AI Tool Reviews - AskWalle AI Hub",
  description:
    "Browse original AI tool review frameworks for writing, coding, research, creative, and automation workflows.",
};

export default async function ReviewsPage() {
  const resources = await getResourcesByType("REVIEW");
  const items = resources.map(resourceContentToResourceItem);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-background">
      <ResourceHero
        icon={<ScrollText className="h-3.5 w-3.5" />}
        title="AI Tool Reviews"
        description="Compare AI tools with concise review frameworks, practical evaluation criteria, strengths, limits, and best-fit workflow notes."
      />
      <main className="container mx-auto px-4 py-8 lg:py-10">
        <ResourceListClient
          items={items}
          searchPlaceholder="Search reviews by tool type, workflow, or tag"
          emptyTitle="No reviews match your filters"
          emptyDescription="No published review records are available yet, or the current filters are too narrow."
        />
      </main>
    </div>
  );
}
