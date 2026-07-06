import Link from "next/link";
import type { Metadata } from "next";
import {
  ArrowUpRight,
  CheckCircle2,
  ClipboardList,
  GitCompare,
  Gift,
  HelpCircle,
  MousePointerClick,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/ui/common/badge";
import { Button } from "@/ui/common/button";
import { Card } from "@/ui/common/card";
import WebsiteGrid from "@/components/website/website-grid";
import type { Category, Website } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Free AI Tools - AskWalle AI Hub",
  description:
    "Find AI tools that may offer free plans, trials, or free ways to start across writing, coding, image generation, productivity, marketing, business, and more.",
};

const benefits = [
  {
    title: "Start without a heavy commitment",
    description:
      "Explore tools that may offer free plans, trials, or low-friction ways to test an idea.",
    icon: Gift,
  },
  {
    title: "Compare practical options",
    description:
      "Review visits, likes, categories, and descriptions before opening a tool.",
    icon: GitCompare,
  },
  {
    title: "Move faster through discovery",
    description:
      "Use the directory as a focused shortlist instead of searching from scratch.",
    icon: Sparkles,
  },
];

const steps = [
  {
    title: "Define your task",
    description:
      "Start with the workflow you need help with, such as writing, coding, research, design, or automation.",
    icon: ClipboardList,
  },
  {
    title: "Compare tools",
    description:
      "Scan descriptions, categories, visits, and likes to narrow down the strongest candidates.",
    icon: Search,
  },
  {
    title: "Visit and try",
    description:
      "Open the tool website and confirm the current free plan, trial, or usage limits directly.",
    icon: MousePointerClick,
  },
];

const faqs = [
  {
    question: "What is a free AI tool?",
    answer:
      "In this directory, it means an AI product that may offer a free plan, free trial, freemium tier, or another free way to evaluate the product.",
  },
  {
    question: "Are all tools completely free?",
    answer:
      "No. This project does not currently store structured pricing data, so you should verify current pricing, limits, and trial terms on each tool website.",
  },
  {
    question: "How do I choose the right AI tool?",
    answer:
      "Start with your task, compare a few tools in the same category, then test the one that best matches your workflow and budget.",
  },
  {
    question: "Can I submit a free AI tool?",
    answer:
      "Yes. Use the submit page to suggest a tool for review, including a clear description and official website link.",
  },
];

function isPotentiallyFreeTool(website: Website) {
  const text = `${website.title} ${website.description}`.toLowerCase();

  return (
    text.includes("free") ||
    text.includes("免费") ||
    text.includes("trial") ||
    text.includes("freemium")
  );
}

export default async function FreeAiToolsPage() {
  let matchedTools: Website[] = [];
  let fallbackTools: Website[] = [];
  let categories: Category[] = [];

  try {
    const [websites, categoryData] = await Promise.all([
      prisma.website.findMany({
        where: {
          status: "approved",
        },
        orderBy: [{ likes: "desc" }, { visits: "desc" }, { created_at: "desc" }],
        select: {
          id: true,
          title: true,
          url: true,
          description: true,
          category_id: true,
          thumbnail: true,
          thumbnail_base64: true,
          status: true,
          visits: true,
          likes: true,
          active: true,
          created_at: true,
        },
      }),
      prisma.category.findMany({
        orderBy: {
          name: "asc",
        },
        select: {
          id: true,
          name: true,
          slug: true,
        },
      }),
    ]);

    const normalizedWebsites = websites.map((website) => ({
      ...website,
      created_at: website.created_at.toISOString(),
    }));

    matchedTools = normalizedWebsites.filter(isPotentiallyFreeTool);
    fallbackTools = normalizedWebsites.slice(0, 12);
    categories = categoryData;
  } catch (error) {
    console.error("[FreeAiToolsPage] Failed to load public free tools data.");
  }

  const toolsToShow = matchedTools.length > 0 ? matchedTools : fallbackTools;
  const isFallback = matchedTools.length === 0 && fallbackTools.length > 0;

  return (
    <div className="min-h-screen bg-background">
      <section className="border-b border-border/70 bg-gradient-to-b from-muted/40 via-background to-background">
        <div className="container mx-auto px-4 py-10 md:py-14">
          <div className="mx-auto max-w-4xl text-center">
            <Badge variant="outline" className="mb-4 gap-2 bg-background px-3 py-1">
              <Gift className="h-3.5 w-3.5" />
              Free AI tools guide
            </Badge>
            <h1 className="text-3xl font-semibold tracking-normal md:text-5xl">
              Find Free AI Tools for Your Workflow
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-muted-foreground md:text-base">
              Discover AI tools that may offer a free plan, free trial, or
              freemium way to start. Compare options and verify current pricing
              on each tool website.
            </p>
            <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
              <Button asChild>
                <a href="#free-tools" className="gap-2">
                  Browse tools
                  <ArrowUpRight className="h-4 w-4" />
                </a>
              </Button>
              <Button asChild variant="outline">
                <Link href="/submit" className="gap-2">
                  <Plus className="h-4 w-4" />
                  Submit Tool
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <main className="container mx-auto space-y-12 px-4 py-8 md:space-y-14 md:py-10">
        <section>
          <SectionHeader
            eyebrow="Why this directory"
            title="Why use this free AI tools directory?"
            description="Use this page as a practical starting point for evaluating AI products with low-friction entry points."
          />
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {benefits.map((benefit) => {
              const Icon = benefit.icon;
              return (
                <Card key={benefit.title} className="rounded-lg p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 font-semibold">{benefit.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {benefit.description}
                  </p>
                </Card>
              );
            })}
          </div>
        </section>

        <section>
          <SectionHeader
            eyebrow="How it works"
            title="Find your free AI tool in 3 steps"
            description="A simple evaluation flow for choosing useful AI software without overthinking the first pass."
          />
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {steps.map((step, index) => {
              const Icon = step.icon;
              return (
                <Card key={step.title} className="rounded-lg p-4">
                  <div className="flex items-center gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                      {index + 1}
                    </span>
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="mt-4 font-semibold">{step.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {step.description}
                  </p>
                </Card>
              );
            })}
          </div>
        </section>

        <section id="free-tools" className="scroll-mt-28">
          <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-medium uppercase text-primary">
                Tool listing
              </p>
              <h2 className="mt-1 text-2xl font-semibold">
                Free AI Tools Preview
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                {isFallback
                  ? "No structured free/pricing field exists yet, so this fallback shows popular approved tools. Verify pricing on each product website."
                  : "These tools matched free, trial, freemium, or similar wording in existing title and description data. Verify details before relying on them."}
              </p>
            </div>
            <Badge variant="outline" className="w-fit">
              {toolsToShow.length} tools
            </Badge>
          </div>

          {toolsToShow.length > 0 ? (
            <WebsiteGrid websites={toolsToShow} categories={categories} />
          ) : (
            <div className="rounded-lg border bg-card px-5 py-12 text-center shadow-sm">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Gift className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-lg font-semibold">
                No tools available yet
              </h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                Approved tools that match free-related wording will appear here
                once available.
              </p>
              <Button asChild className="mt-5">
                <Link href="/submit">Submit a tool</Link>
              </Button>
            </div>
          )}
        </section>

        <section>
          <SectionHeader
            eyebrow="FAQ"
            title="Free AI tools questions"
            description="A few practical notes before choosing a tool from this page."
          />
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {faqs.map((faq) => (
              <Card key={faq.question} className="rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <HelpCircle className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <div>
                    <h3 className="font-semibold">{faq.question}</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {faq.answer}
                    </p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>

        <section className="rounded-lg border bg-muted/30 px-5 py-8 md:px-8">
          <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-sm font-medium text-primary">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Know a useful free AI tool?
              </div>
              <h2 className="mt-3 text-2xl font-semibold">
                Help improve the directory
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Submit tools with clear descriptions and official links so they
                can be reviewed for the public directory.
              </p>
            </div>
            <Button asChild className="w-full md:w-auto">
              <Link href="/submit">Submit Tool</Link>
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div>
      <p className="text-sm font-medium uppercase text-primary">{eyebrow}</p>
      <h2 className="mt-1 text-2xl font-semibold md:text-3xl">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground md:text-base">
        {description}
      </p>
    </div>
  );
}
