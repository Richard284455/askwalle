import type { Metadata } from "next";
import { ArrowUpRight, Newspaper, ShieldCheck } from "lucide-react";
import { ResourceListClient } from "@/components/resources/resource-list-client";
import { ResourceHero } from "@/components/resources/resource-hero";
import { Card } from "@/ui/common/card";
import {
  getResourcesByType,
  resourceContentToResourceItem,
} from "@/lib/resources/resource-content";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "AI News - AskWalle AI Hub",
  description:
    "Browse concise AI news summaries, product updates, research notes, business trends, and official source links.",
};

const recommendedSources = [
  {
    name: "OpenAI News",
    url: "https://openai.com/news/",
    description: "Official product, research, and company updates.",
  },
  {
    name: "Google AI Blog",
    url: "https://blog.google/technology/ai/",
    description: "Official AI research and product announcements from Google.",
  },
  {
    name: "Hugging Face Blog",
    url: "https://huggingface.co/blog",
    description: "Open source model, dataset, and tooling updates.",
  },
  {
    name: "NIST AI",
    url: "https://www.nist.gov/artificial-intelligence",
    description: "AI risk management, standards, and measurement resources.",
  },
];

export default async function NewsPage() {
  const resources = await getResourcesByType("NEWS");
  const items = resources.map(resourceContentToResourceItem);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-background">
      <ResourceHero
        icon={<Newspaper className="h-3.5 w-3.5" />}
        title="AI News"
        description="Follow concise AI news summaries across product updates, research, open source, business, and regulation. Each card links to a source page for deeper reading."
      />

      <main className="container mx-auto grid gap-8 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:py-10">
        <section>
          <ResourceListClient
            items={items}
            searchPlaceholder="Search AI news by topic, source, or tag"
            emptyTitle="No news matches found"
            emptyDescription="No published news records are available yet, or the current filters are too narrow."
          />
        </section>

        <aside className="space-y-4">
          <Card className="rounded-xl border-border/80 bg-white p-4 shadow-sm shadow-slate-900/[0.03] dark:bg-card">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <ShieldCheck className="h-5 w-5" />
              </span>
              <div>
                <h2 className="font-semibold text-slate-950 dark:text-foreground">
                  Recommended official sources
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-muted-foreground">
                  Use these sources to verify announcements, policies, and
                  technical details before making decisions.
                </p>
              </div>
            </div>
          </Card>

          <div className="grid gap-3">
            {recommendedSources.map((source) => (
              <a
                key={source.url}
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Card className="group rounded-lg border-border/80 bg-white p-4 shadow-sm shadow-slate-900/[0.03] transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md hover:shadow-slate-900/[0.07] dark:bg-card">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-semibold text-slate-950 group-hover:text-primary dark:text-foreground">
                      {source.name}
                    </h3>
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" />
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-muted-foreground">
                    {source.description}
                  </p>
                </Card>
              </a>
            ))}
          </div>
        </aside>
      </main>
    </div>
  );
}
