"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight, Newspaper, Search } from "lucide-react";
import type { NewsItem } from "@/data/resources/types";
import { Badge } from "@/ui/common/badge";
import { Button } from "@/ui/common/button";
import { Card } from "@/ui/common/card";
import { Input } from "@/ui/common/input";
import { cn } from "@/lib/utils/utils";

const categories = [
  "All",
  "Product Updates",
  "Research",
  "Open Source",
  "Business",
  "Regulation",
];

interface NewsListClientProps {
  items: NewsItem[];
}

export default function NewsListClient({ items }: NewsListClientProps) {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return items.filter((item) => {
      const matchesCategory =
        activeCategory === "All" || item.category === activeCategory;
      const searchableText = `${item.title} ${item.summary} ${item.sourceName} ${item.tags.join(
        " "
      )}`.toLowerCase();
      const matchesQuery =
        normalizedQuery.length === 0 || searchableText.includes(normalizedQuery);

      return matchesCategory && matchesQuery;
    });
  }, [activeCategory, items, query]);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-3 shadow-sm">
        <div className="flex items-center gap-3 rounded-md border bg-background px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search AI news by topic, source, or tag"
            className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          />
        </div>

        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {categories.map((category) => (
            <Button
              key={category}
              type="button"
              variant={activeCategory === category ? "default" : "outline"}
              size="sm"
              className="shrink-0"
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
            <Card
              key={item.slug}
              className="group flex min-h-[238px] flex-col rounded-lg border-border/70 p-4 transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-3">
                <Badge
                  variant="secondary"
                  className="max-w-full truncate px-2 py-0 text-[11px]"
                >
                  {item.category}
                </Badge>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {new Date(item.publishedAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
              </div>

              <h2 className="mt-3 line-clamp-2 text-base font-semibold leading-6 group-hover:text-primary">
                {item.title}
              </h2>
              <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted-foreground">
                {item.summary}
              </p>

              <div className="mt-4 flex flex-wrap gap-1.5">
                {item.tags.slice(0, 3).map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>

              <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/60 pt-3">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{item.sourceName}</p>
                  <p className="text-xs text-muted-foreground">{item.readTime}</p>
                </div>
                <Button asChild size="sm" variant="outline" className="shrink-0">
                  <a
                    href={item.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="gap-2"
                  >
                    Source
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </a>
                </Button>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="rounded-lg px-5 py-12 text-center shadow-sm">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Newspaper className="h-6 w-6" />
          </div>
          <h2 className="mt-4 text-lg font-semibold">No news matches found</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            Try a broader search term or switch back to all categories.
          </p>
          <Button
            type="button"
            variant="outline"
            className={cn("mt-5", activeCategory === "All" && !query && "hidden")}
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
