import Link from "next/link";
import type { Metadata } from "next";
import { Clock3, Plus } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/ui/common/badge";
import { Button } from "@/ui/common/button";
import WebsiteGrid from "@/components/website/website-grid";
import type { Category, Website } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "New AI Tools - AskWalle AI Hub",
  description:
    "Discover recently added AI tools for writing, coding, image generation, productivity, marketing, business, and more.",
};

export default async function NewToolsPage() {
  let websites: Website[] = [];
  let categories: Category[] = [];

  try {
    const [websiteData, categoryData] = await Promise.all([
      prisma.website.findMany({
        where: {
          status: "approved",
        },
        orderBy: {
          created_at: "desc",
        },
        select: {
          id: true,
          title: true,
          slug: true,
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

    websites = websiteData.map((website) => ({
      ...website,
      created_at: website.created_at.toISOString(),
    }));
    categories = categoryData;
  } catch (error) {
    console.error("[NewToolsPage] Failed to load public new tools data.");
  }

  return (
    <div className="min-h-screen bg-background">
      <section className="border-b border-border/70 bg-gradient-to-b from-muted/40 via-background to-background">
        <div className="container mx-auto px-4 py-10 md:py-14">
          <div className="mx-auto max-w-4xl text-center">
            <Badge variant="outline" className="mb-4 gap-2 bg-background px-3 py-1">
              <Clock3 className="h-3.5 w-3.5" />
              Recently added
            </Badge>
            <h1 className="text-3xl font-semibold tracking-normal md:text-5xl">
              New AI Tools
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-muted-foreground md:text-base">
              Browse the latest approved AI tools added to AskWalle AI Hub.
              Explore fresh products for content, coding, design, automation,
              research, and everyday work.
            </p>
          </div>
        </div>
      </section>

      <main className="container mx-auto px-4 py-8 md:py-10">
        <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-medium uppercase text-primary">
              New directory entries
            </p>
            <h2 className="mt-1 text-2xl font-semibold">
              {websites.length} recently added tools
            </h2>
          </div>
          <Button asChild variant="outline" size="sm" className="w-full md:w-auto">
            <Link href="/submit" className="gap-2">
              <Plus className="h-4 w-4" />
              Submit Tool
            </Link>
          </Button>
        </div>

        {websites.length > 0 ? (
          <WebsiteGrid websites={websites} categories={categories} />
        ) : (
          <div className="rounded-lg border bg-card px-5 py-12 text-center shadow-sm">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Clock3 className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-lg font-semibold">No new tools yet</h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              Newly approved tools will appear here once they are available in
              the directory.
            </p>
            <Button asChild className="mt-5">
              <Link href="/submit">Submit a tool</Link>
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
