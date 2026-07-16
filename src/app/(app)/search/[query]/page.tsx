import Link from "next/link";
import { ArrowLeft, Search } from "lucide-react";
import { prisma } from "@/lib/db/db";
import { Badge } from "@/ui/common/badge";
import { Button } from "@/ui/common/button";
import SearchResultsClient from "@/components/search/search-results-client";
import type { Category, Website } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface SearchPageProps {
  params: Promise<{
    query: string;
  }>;
  searchParams: Promise<{
    category?: string;
  }>;
}

export async function generateMetadata({ params }: SearchPageProps) {
  const { query } = await params;
  const keyword = decodeURIComponent(query).trim();

  return {
    title: keyword ? `Search ${keyword} AI Tools` : "Search AI Tools",
    description: keyword
      ? `Search AI tools related to ${keyword}.`
      : "Search AI tools by title and description.",
  };
}

export default async function SearchPage({ params, searchParams }: SearchPageProps) {
  const { query } = await params;
  const { category } = await searchParams;
  const keyword = decodeURIComponent(query).trim();
  const categoryId = category ? Number(category) : null;

  let categories: Category[] = [];
  let websites: Website[] = [];

  if (keyword) {
    [categories, websites] = await Promise.all([
      prisma.category.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          slug: true,
        },
      }),
      prisma.website.findMany({
        where: {
          status: "approved",
          ...(categoryId
            ? {
                category_id: categoryId,
              }
            : {}),
          OR: [
            {
              title: {
                contains: keyword,
                mode: "insensitive",
              },
            },
            {
              description: {
                contains: keyword,
                mode: "insensitive",
              },
            },
          ],
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
          thumbnail_base64: true,
          status: true,
          visits: true,
          likes: true,
          active: true,
        },
      }),
    ]);
  }

  return (
    <div className="min-h-screen bg-background">
      <section className="border-b border-border/70 bg-gradient-to-b from-muted/40 via-background to-background">
        <div className="container mx-auto px-4 py-8 md:py-12">
          <Button asChild variant="ghost" size="sm" className="-ml-3 mb-5 gap-2">
            <Link href="/#directory-search">
              <ArrowLeft className="h-4 w-4" />
              Back to directory
            </Link>
          </Button>

          <div className="mx-auto max-w-4xl text-center">
            <Badge variant="outline" className="mb-4 gap-2 bg-background px-3 py-1">
              <Search className="h-3.5 w-3.5" />
              Search results
            </Badge>
            <h1 className="text-3xl font-semibold tracking-normal md:text-5xl">
              Search for <span className="text-primary">{keyword}</span> using AI
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-muted-foreground md:text-base">
              Results are matched from approved AI tool titles and descriptions.
            </p>
          </div>
        </div>
      </section>

      <SearchResultsClient
        initialQuery={keyword}
        websites={websites}
        categories={categories}
        selectedCategory={categoryId}
      />
    </div>
  );
}
