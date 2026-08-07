import Link from "next/link";
import type { Metadata } from "next";
import { BarChart3, Heart, Plus, TrendingUp } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/ui/common/badge";
import { Button } from "@/ui/common/button";
import WebsiteGrid from "@/components/website/website-grid";
import type { Category, Website } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Popular AI Tools - AskWalle AI Hub",
  description:
    "Explore popular AI tools ranked by visits and likes across writing, coding, image generation, productivity, marketing, business, and more.",
};

export default async function PopularToolsPage() {
  let mostUsedTools: Website[] = [];
  let mostLikedTools: Website[] = [];
  let categories: Category[] = [];

  try {
    const [usedData, likedData, categoryData] = await Promise.all([
      prisma.website.findMany({
        where: {
          status: "approved",
        },
        orderBy: [{ visits: "desc" }, { likes: "desc" }, { created_at: "desc" }],
        select: {
          id: true,
          title: true,
          slug: true,
          url: true,
          description: true,
          category_id: true,
          thumbnail: true,
          status: true,
          visits: true,
          likes: true,
          active: true,
          created_at: true,
        },
      }),
      prisma.website.findMany({
        where: {
          status: "approved",
        },
        orderBy: [{ likes: "desc" }, { visits: "desc" }, { created_at: "desc" }],
        select: {
          id: true,
          title: true,
          slug: true,
          url: true,
          description: true,
          category_id: true,
          thumbnail: true,
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

    mostUsedTools = usedData.map((website) => ({
      ...website,
      created_at: website.created_at.toISOString(),
    }));
    mostLikedTools = likedData.map((website) => ({
      ...website,
      created_at: website.created_at.toISOString(),
    }));
    categories = categoryData;
  } catch (error) {
    console.error("[PopularToolsPage] Failed to load public popular tools data.");
  }

  return (
    <div className="min-h-screen bg-background">
      <section className="border-b border-border/70 bg-gradient-to-b from-muted/40 via-background to-background">
        <div className="container mx-auto px-4 py-10 md:py-14">
          <div className="mx-auto max-w-4xl text-center">
            <Badge variant="outline" className="mb-4 gap-2 bg-background px-3 py-1">
              <TrendingUp className="h-3.5 w-3.5" />
              Popular directory picks
            </Badge>
            <h1 className="text-3xl font-semibold tracking-normal md:text-5xl">
              Popular AI Tools
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-muted-foreground md:text-base">
              Browse approved AI tools ranked by visits and likes. These lists
              use existing directory signals only.
            </p>
          </div>
        </div>
      </section>

      <main className="container mx-auto space-y-12 px-4 py-8 md:space-y-14 md:py-10">
        <PopularSection
          eyebrow="Most Used"
          title="Most Used AI Tools"
          description="Approved tools sorted by recorded visits."
          icon={<BarChart3 className="h-4 w-4" />}
          tools={mostUsedTools}
          categories={categories}
        />

        <PopularSection
          eyebrow="Most Liked"
          title="Most Liked AI Tools"
          description="Approved tools sorted by public likes."
          icon={<Heart className="h-4 w-4" />}
          tools={mostLikedTools}
          categories={categories}
        />
      </main>
    </div>
  );
}

function PopularSection({
  eyebrow,
  title,
  description,
  icon,
  tools,
  categories,
}: {
  eyebrow: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  tools: Website[];
  categories: Category[];
}) {
  return (
    <section>
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="inline-flex items-center gap-2 text-sm font-medium uppercase text-primary">
            {icon}
            {eyebrow}
          </p>
          <h2 className="mt-1 text-2xl font-semibold">{title}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="w-full md:w-auto">
          <Link href="/submit" className="gap-2">
            <Plus className="h-4 w-4" />
            Submit Tool
          </Link>
        </Button>
      </div>

      {tools.length > 0 ? (
        <WebsiteGrid websites={tools} categories={categories} />
      ) : (
        <div className="rounded-lg border bg-card px-5 py-12 text-center shadow-sm">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
            {icon}
          </div>
          <h3 className="mt-4 text-lg font-semibold">No popular tools yet</h3>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            Popular tools will appear here once approved tools have visits or
            likes.
          </p>
          <Button asChild className="mt-5">
            <Link href="/submit">Submit a tool</Link>
          </Button>
        </div>
      )}
    </section>
  );
}
