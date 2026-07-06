import Link from "next/link";
import type { Metadata } from "next";
import {
  ArrowRight,
  BookOpen,
  GraduationCap,
  Newspaper,
  Search,
  ScrollText,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/ui/common/badge";
import { Button } from "@/ui/common/button";
import { Card } from "@/ui/common/card";
import { ResourceSection } from "@/components/resources/resource-section";
import {
  getLatestResources,
  resourceContentToResourceItem,
} from "@/lib/resources/resource-content";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "AI Resource Hub - AskWalle AI Hub",
  description:
    "Explore AI news, tool reviews, prompt ideas, skills, and tutorials for practical AI workflows.",
};

const resourceCards = [
  {
    title: "AI News",
    description: "Follow product updates, model releases, and practical AI trends.",
    href: "/news",
    icon: Newspaper,
    meta: "Industry updates",
  },
  {
    title: "AI Tool Reviews",
    description: "Compare tools with concise review frameworks and use-case notes.",
    href: "/reviews",
    icon: ScrollText,
    meta: "Tool evaluation",
  },
  {
    title: "Prompt Library",
    description: "Find reusable prompts for writing, coding, research, and operations.",
    href: "/prompts",
    icon: Sparkles,
    meta: "Reusable prompts",
  },
  {
    title: "Skills Library",
    description: "Learn repeatable AI workflows and practical task patterns.",
    href: "/skills",
    icon: GraduationCap,
    meta: "Workflow skills",
  },
  {
    title: "AI Tutorials",
    description: "Follow beginner-friendly guides for choosing and using AI tools.",
    href: "/tutorials",
    icon: BookOpen,
    meta: "Practical guides",
  },
];

const resourceSectionConfigs = [
  {
    type: "NEWS" as const,
    title: "Latest News",
    description: "Track practical AI product and industry updates.",
    href: "/news",
  },
  {
    type: "REVIEW" as const,
    title: "Latest Reviews",
    description: "Compare tools with concise evaluation frameworks.",
    href: "/reviews",
  },
  {
    type: "PROMPT" as const,
    title: "Featured Prompts",
    description: "Start from reusable prompts for common workflows.",
    href: "/prompts",
  },
  {
    type: "SKILL" as const,
    title: "Popular Skills",
    description: "Learn repeatable AI workflows for real tasks.",
    href: "/skills",
  },
  {
    type: "TUTORIAL" as const,
    title: "Beginner Tutorials",
    description: "Build confidence with practical AI guides.",
    href: "/tutorials",
  },
];

export default async function ResourcesPage() {
  const resourceSections = await Promise.all(
    resourceSectionConfigs.map(async (section) => {
      const resources = await getLatestResources(section.type, 3);

      return {
        ...section,
        items: resources.map(resourceContentToResourceItem),
      };
    })
  );

  return (
    <div className="min-h-screen bg-background">
      <section className="border-b border-border/70 bg-gradient-to-b from-muted/40 via-background to-background">
        <div className="container mx-auto px-4 py-10 md:py-14">
          <div className="mx-auto max-w-4xl text-center">
            <Badge variant="outline" className="mb-4 gap-2 bg-background px-3 py-1">
              <BookOpen className="h-3.5 w-3.5" />
              AI resource hub
            </Badge>
            <h1 className="text-3xl font-semibold tracking-normal md:text-5xl">
              Learn, compare, and build better AI workflows
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-muted-foreground md:text-base">
              Explore concise AI news, tool reviews, prompts, skills, and
              tutorials alongside the AskWalle AI tools directory.
            </p>
            <div className="mx-auto mt-7 flex max-w-2xl items-center gap-3 rounded-lg border bg-background p-2 shadow-sm">
              <Search className="ml-3 h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-left text-sm text-muted-foreground">
                Search across resources is planned for the next content pass
              </span>
              <Button asChild size="sm" className="hidden sm:inline-flex">
                <Link href="/tools">Browse Tools</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <main className="container mx-auto space-y-12 px-4 py-8 md:space-y-14 md:py-10">
        <section>
          <div className="mb-5 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-medium uppercase text-primary">
                Resource library
              </p>
              <h2 className="mt-1 text-2xl font-semibold">
                Five ways to explore AI
              </h2>
            </div>
            <Button asChild variant="outline" size="sm" className="w-full md:w-auto">
              <Link href="/submit" className="gap-2">
                Submit Tool
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {resourceCards.map((card) => {
              const Icon = card.icon;

              return (
                <Link key={card.href} href={card.href}>
                  <Card className="group flex h-full min-h-[176px] flex-col rounded-lg border-border/70 p-4 transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <Icon className="h-5 w-5" />
                      </span>
                      <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
                    </div>
                    <h3 className="mt-4 text-base font-semibold group-hover:text-primary">
                      {card.title}
                    </h3>
                    <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted-foreground">
                      {card.description}
                    </p>
                    <p className="mt-auto pt-3 text-xs font-medium text-primary">
                      {card.meta}
                    </p>
                  </Card>
                </Link>
              );
            })}
          </div>
        </section>

        {resourceSections.map((section) => (
          <ResourceSection
            key={section.title}
            title={section.title}
            description={section.description}
            href={section.href}
            items={section.items}
            emptyDescription="No published resources are available in this section yet."
          />
        ))}
      </main>
    </div>
  );
}
