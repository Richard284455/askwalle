"use client";

import { useMemo, useState } from "react";
import { Search, Sparkles } from "lucide-react";
import type { ResourceItem } from "@/data/resources/types";
import { Button } from "@/ui/common/button";
import { Card } from "@/ui/common/card";
import { Input } from "@/ui/common/input";
import { ResourceCard } from "./resource-card";

interface ResourceListClientProps {
  items: ResourceItem[];
  searchPlaceholder: string;
  emptyTitle: string;
  emptyDescription: string;
}

export function ResourceListClient({
  items,
  searchPlaceholder,
  emptyTitle,
  emptyDescription,
}: ResourceListClientProps) {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");

  const categories = useMemo(
    () => ["All", ...Array.from(new Set(items.map((item) => item.category)))],
    [items]
  );

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return items.filter((item) => {
      const matchesCategory =
        activeCategory === "All" || item.category === activeCategory;
      const searchableText = `${item.title} ${item.summary} ${item.category} ${item.tags.join(
        " "
      )} ${item.meta} ${item.sourceName ?? ""}`.toLowerCase();
      const matchesQuery =
        normalizedQuery.length === 0 || searchableText.includes(normalizedQuery);

      return matchesCategory && matchesQuery;
    });
  }, [activeCategory, items, query]);

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border/80 bg-white p-3 shadow-sm shadow-slate-900/[0.04] dark:bg-card">
        <div className="flex items-center gap-3 rounded-lg border border-border/80 bg-slate-50 px-3 py-2 dark:bg-background">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            className="h-10 border-0 bg-transparent px-0 text-slate-950 shadow-none placeholder:text-slate-400 focus-visible:ring-0 dark:text-foreground dark:placeholder:text-muted-foreground"
          />
        </div>

        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {categories.map((category) => (
            <Button
              key={category}
              type="button"
              variant={activeCategory === category ? "default" : "outline"}
              size="sm"
              className="shrink-0 rounded-full shadow-sm"
              onClick={() => setActiveCategory(category)}
            >
              {category}
            </Button>
          ))}
        </div>
      </div>

      {filteredItems.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filteredItems.map((item) => (
            <ResourceCard key={item.slug} item={item} />
          ))}
        </div>
      ) : (
        <Card className="rounded-xl border-border/80 bg-white px-5 py-12 text-center shadow-sm shadow-slate-900/[0.03] dark:bg-card">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Sparkles className="h-6 w-6" />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-slate-950 dark:text-foreground">
            {emptyTitle}
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600 dark:text-muted-foreground">
            {emptyDescription}
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-5"
            onClick={() => {
              setQuery("");
              setActiveCategory("All");
            }}
          >
            Clear filters
          </Button>
        </Card>
      )}
    </div>
  );
}
