import Link from "next/link";
import type { Metadata } from "next";
import { Asterisk, Compass, Hash, Plus } from "lucide-react";
import { prisma } from "@/lib/prisma";
import WebsiteGrid from "@/components/website/website-grid";
import { groupToolsByLetter, TOOL_INDEX_LETTERS } from "@/lib/website/tool-index";
import { Badge } from "@/ui/common/badge";
import { Button } from "@/ui/common/button";
import { Card } from "@/ui/common/card";
import type { Category, Website } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "A-Z AI Tools Index - AskWalle AI Hub",
  description:
    "Browse approved AI tools from A to Z across writing, coding, image generation, productivity, marketing, business, and more.",
};

export default async function ToolsIndexPage() {
  let websites: Website[] = [];
  let categories: Category[] = [];

  try {
    const [websiteData, categoryData] = await Promise.all([
      prisma.website.findMany({
        where: {
          status: "approved",
        },
        orderBy: {
          title: "asc",
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
    console.error("[ToolsIndexPage] Failed to load public tools index data.");
  }

  const groupedTools = groupToolsByLetter(websites);
  const activeLetters = TOOL_INDEX_LETTERS.filter(
    (letter) => (groupedTools.get(letter)?.length ?? 0) > 0
  );
  const otherTools = groupedTools.get("#") ?? [];

  return (
    <div className="min-h-screen bg-background">
      <section className="border-b border-border/70 bg-gradient-to-b from-muted/40 via-background to-background">
        <div className="container mx-auto px-4 py-10 md:py-14">
          <div className="mx-auto max-w-4xl text-center">
            <Badge variant="outline" className="mb-4 gap-2 bg-background px-3 py-1">
              <Asterisk className="h-3.5 w-3.5" />
              A-Z directory
            </Badge>
            <h1 className="text-3xl font-semibold tracking-normal md:text-5xl">
              A-Z AI Tools Index
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-muted-foreground md:text-base">
              Browse approved AI tools alphabetically, jump into a letter, or
              scan every listed tool in one place.
            </p>
          </div>
        </div>
      </section>

      <main className="container mx-auto space-y-10 px-4 py-8 md:py-10">
        <section>
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-medium uppercase text-primary">
                Browse by letter
              </p>
              <h2 className="mt-1 text-2xl font-semibold">
                {websites.length} approved tools
              </h2>
            </div>
            <Button asChild variant="outline" size="sm" className="w-full md:w-auto">
              <Link href="/submit" className="gap-2">
                <Plus className="h-4 w-4" />
                Submit Tool
              </Link>
            </Button>
          </div>

          <Card className="rounded-lg p-4">
            <div className="grid grid-cols-6 gap-2 sm:grid-cols-9 md:grid-cols-14">
              {TOOL_INDEX_LETTERS.map((letter) => {
                const count = groupedTools.get(letter)?.length ?? 0;
                const hasTools = count > 0;

                return hasTools ? (
                  <Link
                    key={letter}
                    href={`/tools/${letter.toLowerCase()}`}
                    className="flex h-10 items-center justify-center rounded-md border bg-background text-sm font-semibold transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
                    aria-label={`View ${count} tools starting with ${letter}`}
                  >
                    {letter}
                  </Link>
                ) : (
                  <span
                    key={letter}
                    className="flex h-10 items-center justify-center rounded-md border bg-muted/40 text-sm font-semibold text-muted-foreground/50"
                    aria-label={`No tools starting with ${letter}`}
                  >
                    {letter}
                  </span>
                );
              })}
            </div>
          </Card>
        </section>

        {websites.length > 0 ? (
          <section className="space-y-10">
            {activeLetters.map((letter) => {
              const tools = groupedTools.get(letter) ?? [];

              return (
                <div key={letter} id={`letter-${letter.toLowerCase()}`}>
                  <div className="mb-4 flex items-center justify-between gap-3 border-b pb-3">
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-lg font-semibold text-primary">
                        {letter}
                      </span>
                      <div>
                        <h2 className="text-xl font-semibold">
                          Tools starting with {letter}
                        </h2>
                        <p className="text-sm text-muted-foreground">
                          {tools.length} tools
                        </p>
                      </div>
                    </div>
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/tools/${letter.toLowerCase()}`}>View letter</Link>
                    </Button>
                  </div>
                  <WebsiteGrid websites={tools} categories={categories} />
                </div>
              );
            })}

            {otherTools.length > 0 && (
              <div id="letter-other">
                <div className="mb-4 flex items-center gap-3 border-b pb-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-md bg-muted text-lg font-semibold text-muted-foreground">
                    <Hash className="h-5 w-5" />
                  </span>
                  <div>
                    <h2 className="text-xl font-semibold">Other tools</h2>
                    <p className="text-sm text-muted-foreground">
                      {otherTools.length} tools with non A-Z titles
                    </p>
                  </div>
                </div>
                <WebsiteGrid websites={otherTools} categories={categories} />
              </div>
            )}
          </section>
        ) : (
          <Card className="rounded-lg px-5 py-12 text-center shadow-sm">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Compass className="h-6 w-6" />
            </div>
            <h2 className="mt-4 text-lg font-semibold">No approved tools yet</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              Approved tools will appear in this A-Z index after they are added
              through the directory workflow.
            </p>
            <Button asChild className="mt-5">
              <Link href="/submit">Submit a tool</Link>
            </Button>
          </Card>
        )}
      </main>
    </div>
  );
}
