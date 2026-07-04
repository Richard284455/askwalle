"use client";

import { useState } from "react";
import { SearchX } from "lucide-react";
import { Button } from "@/ui/common/button";
import { SearchBox } from "@/components/search-box";
import WebsiteGrid from "@/components/website/website-grid";
import type { Category, Website } from "@/lib/types";

interface SearchResultsClientProps {
  initialQuery: string;
  websites: Website[];
  categories: Category[];
  selectedCategory: number | null;
}

export default function SearchResultsClient({
  initialQuery,
  websites,
  categories,
  selectedCategory,
}: SearchResultsClientProps) {
  const [query, setQuery] = useState(initialQuery);
  const [categoryId, setCategoryId] = useState<number | null>(selectedCategory);

  return (
    <main className="container mx-auto px-4 py-8 md:py-10">
      <div className="mx-auto max-w-4xl">
        <SearchBox
          value={query}
          onChange={setQuery}
          categories={categories}
          websites={websites}
          selectedCategory={categoryId}
          onCategoryChange={setCategoryId}
        />
      </div>

      <div className="mt-8">
        <div className="mb-5 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-medium uppercase text-primary">
              Tools({websites.length})
            </p>
            <h2 className="mt-1 text-2xl font-semibold">Matching AI tools</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            {websites.length} matches
          </p>
        </div>

        {websites.length > 0 ? (
          <WebsiteGrid websites={websites} categories={categories} />
        ) : (
          <div className="rounded-lg border bg-card px-5 py-12 text-center shadow-sm">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <SearchX className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-lg font-semibold">No matching AI tools</h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              Try a broader keyword, remove the category filter, or browse the
              full directory.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-5">
              <a href="/#directory-search">Browse directory</a>
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
