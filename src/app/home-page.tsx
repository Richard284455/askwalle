"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useMemo } from "react";
import { useAtom } from "jotai";
import { motion } from "framer-motion";
import {
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Folder,
  Heart,
  Plus,
  SearchX,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/ui/common/badge";
import { Button } from "@/ui/common/button";
import { Card } from "@/ui/common/card";
import { SearchBox } from "@/components/search-box";
import WebsiteGrid from "@/components/website/website-grid";
import { WebsiteThumbnail } from "@/components/website/website-thumbnail";
import {
  categoriesAtom,
  searchQueryAtom,
  selectedCategoryAtom,
  websitesAtom,
} from "@/lib/atoms";
import { cn } from "@/lib/utils/utils";
import type { Website, Category } from "@/lib/types";

interface HomePageProps {
  initialWebsites: Website[];
  initialCategories: Category[];
}

const sectionMotion = {
  initial: { opacity: 0, y: 18 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-80px" },
  transition: { duration: 0.35, ease: "easeOut" },
};

export default function HomePage({
  initialWebsites,
  initialCategories,
}: HomePageProps) {
  const [websites, setWebsites] = useAtom(websitesAtom);
  const [categories, setCategories] = useAtom(categoriesAtom);
  const [searchQuery, setSearchQuery] = useAtom(searchQueryAtom);
  const [selectedCategory, setSelectedCategory] = useAtom(selectedCategoryAtom);

  useEffect(() => {
    setWebsites(initialWebsites);
    setCategories(initialCategories);
    setSelectedCategory(null);
  }, [
    initialWebsites,
    initialCategories,
    setWebsites,
    setCategories,
    setSelectedCategory,
  ]);

  const categoryById = useMemo(() => {
    return new Map(categories.map((category) => [category.id, category]));
  }, [categories]);

  const toolCountsByCategory = useMemo(() => {
    return websites.reduce((counts, website) => {
      counts.set(website.category_id, (counts.get(website.category_id) || 0) + 1);
      return counts;
    }, new Map<number, number>());
  }, [websites]);

  const filteredWebsites = useMemo(() => {
    return websites.filter((website) => {
      const matchesCategory =
        !selectedCategory || website.category_id === Number(selectedCategory);

      return matchesCategory;
    });
  }, [websites, selectedCategory]);

  const topVisitedTools = useMemo(() => {
    return [...websites].sort((a, b) => b.visits - a.visits).slice(0, 6);
  }, [websites]);

  const newTools = useMemo(() => websites.slice(0, 6), [websites]);

  const featuredCategories = useMemo(() => {
    return [...categories]
      .sort(
        (a, b) =>
          (toolCountsByCategory.get(b.id) || 0) -
          (toolCountsByCategory.get(a.id) || 0)
      )
      .slice(0, 8);
  }, [categories, toolCountsByCategory]);

  const popularCategories = featuredCategories.slice(0, 6);
  const hasActiveFilters = !!selectedCategory;
  const currentCategoryName = selectedCategory
    ? categoryById.get(Number(selectedCategory))?.name || "Selected"
    : "All AI tools";

  const handleVisit = (website: Website) => {
    window.open(website.url, "_blank", "noopener,noreferrer");

    fetch(`/api/websites/${website.id}/visit`, { method: "POST" })
      .then((response) => response.json())
      .then((data) => {
        if (data.code === 200 && data.data?.visits !== undefined) {
          setWebsites((currentWebsites) =>
            currentWebsites.map((item) =>
              item.id === website.id
                ? { ...item, visits: data.data.visits }
                : item
            )
          );
        }
      })
      .catch(console.error);
  };

  const handleCategorySelect = (categoryId: number | null) => {
    setSelectedCategory(categoryId);
    document
      .getElementById("all-tools")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const scrollToResults = () => {
    document
      .getElementById("all-tools")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <section className="border-b border-border/60 bg-gradient-to-b from-muted/40 via-background to-background">
        <div className="container mx-auto px-4 py-8 md:py-14 lg:py-16">
          <div className="mx-auto flex max-w-5xl flex-col items-center text-center">
            <Badge
              variant="outline"
              className="mb-5 gap-2 border-primary/20 bg-background/80 px-3 py-1 text-primary"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Curated AI tools directory
            </Badge>

            <h1 className="max-w-4xl text-3xl font-bold leading-tight sm:text-4xl md:text-5xl lg:text-6xl">
              Discover practical AI tools for every workflow
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base md:mt-5 md:text-lg md:leading-7">
              Search, compare, and browse a growing directory of AI products
              for writing, coding, design, research, automation, and daily work.
            </p>

            <div
              id="directory-search"
              className="mt-6 w-full max-w-3xl scroll-mt-24 md:mt-8 md:scroll-mt-28"
            >
              <SearchBox
                value={searchQuery}
                onChange={setSearchQuery}
                categories={categories}
                websites={websites}
                selectedCategory={selectedCategory}
                onCategoryChange={handleCategorySelect}
                onSearchSubmit={scrollToResults}
                className="mx-auto"
              />
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <CategoryChip
                active={!selectedCategory}
                label="All tools"
                count={websites.length}
                onClick={() => handleCategorySelect(null)}
              />
              {popularCategories.map((category) => (
                <CategoryChip
                  key={category.id}
                  active={selectedCategory === category.id}
                  label={category.name}
                  count={toolCountsByCategory.get(category.id) || 0}
                  onClick={() => handleCategorySelect(category.id)}
                />
              ))}
            </div>

            <div className="mt-8 grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
              <StatCard label="AI tools" value={websites.length.toString()} />
              <StatCard
                label="Categories"
                value={categories.length.toString()}
              />
              <StatCard
                label="Recently added"
                value={newTools.length.toString()}
              />
            </div>
          </div>
        </div>
      </section>

      <div className="container mx-auto space-y-10 px-4 py-8 md:space-y-16 md:py-14">
        <motion.section {...sectionMotion} id="categories">
          <SectionHeader
            eyebrow="Browse by category"
            title="Featured categories"
            description="Start with the areas that match your work, then narrow the directory instantly."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleCategorySelect(null)}
              >
                View all tools
              </Button>
            }
          />

          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {featuredCategories.map((category) => (
              <button
                key={category.id}
                onClick={() => handleCategorySelect(category.id)}
                className={cn(
                  "group flex min-h-[112px] flex-col justify-between rounded-lg border bg-card p-4 text-left shadow-sm transition-all",
                  "hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md",
                  selectedCategory === category.id &&
                    "border-primary/40 bg-primary/5"
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Folder className="h-4 w-4" />
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold leading-tight">
                    {category.name}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {toolCountsByCategory.get(category.id) || 0} tools
                  </p>
                </div>
              </button>
            ))}
          </div>
        </motion.section>

        <motion.section {...sectionMotion}>
          <SectionHeader
            eyebrow="Fresh picks"
            title="New AI tools"
            description="Recently loaded tools from the current directory data."
          />
          <ToolCardGrid
            websites={newTools}
            categoryById={categoryById}
            onVisit={handleVisit}
          />
        </motion.section>

        <motion.section {...sectionMotion}>
          <SectionHeader
            eyebrow="Popular now"
            title="Top AI tools"
            description="The most visited tools in the current directory."
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/rankings">Open rankings</Link>
              </Button>
            }
          />
          <ToolCardGrid
            websites={topVisitedTools}
            categoryById={categoryById}
            onVisit={handleVisit}
          />
        </motion.section>

        <motion.section
          {...sectionMotion}
          id="all-tools"
          className="scroll-mt-28"
        >
          <SectionHeader
            eyebrow="Directory"
            title={currentCategoryName}
            description={
              hasActiveFilters
                ? `${filteredWebsites.length} tools match the selected category.`
                : `${filteredWebsites.length} approved AI tools are available in the directory.`
            }
            action={
              hasActiveFilters ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSearchQuery("");
                    handleCategorySelect(null);
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
          <div className="mt-5">
            {filteredWebsites.length === 0 && hasActiveFilters ? (
              <SearchEmptyState
                query=""
                categoryName={
                  selectedCategory
                    ? categoryById.get(Number(selectedCategory))?.name
                    : undefined
                }
                onClear={() => {
                  setSearchQuery("");
                  handleCategorySelect(null);
                }}
              />
            ) : (
              <WebsiteGrid websites={filteredWebsites} categories={categories} />
            )}
          </div>
        </motion.section>

        <motion.section
          {...sectionMotion}
          className="rounded-lg border bg-muted/30 px-5 py-8 md:px-8 md:py-10"
        >
          <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div className="max-w-2xl">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-sm font-medium text-primary">
                <Plus className="h-3.5 w-3.5" />
                Submit a tool
              </div>
              <h2 className="text-2xl font-semibold md:text-3xl">
                Know an AI product worth sharing?
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground md:text-base">
                Add it to the directory for review and help others find useful
                AI tools faster.
              </p>
            </div>
            <Button asChild size="lg" className="w-full gap-2 md:w-auto">
              <Link href="/submit">
                Submit tool
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </motion.section>
      </div>
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        <p className="text-sm font-medium uppercase text-primary">{eyebrow}</p>
        <h2 className="mt-1 text-2xl font-semibold md:text-3xl">{title}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground md:text-base">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background/80 px-4 py-3 text-left shadow-sm">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

function CategoryChip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground"
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "rounded-full px-1.5 py-0.5 text-[11px]",
          active
            ? "bg-primary-foreground/15 text-primary-foreground"
            : "bg-muted text-muted-foreground"
        )}
      >
        {count}
      </span>
    </button>
  );
}

function ToolCardGrid({
  websites,
  categoryById,
  onVisit,
}: {
  websites: Website[];
  categoryById: Map<number, Category>;
  onVisit: (website: Website) => void;
}) {
  if (websites.length === 0) {
    return (
      <div className="mt-5 rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
        No tools available yet.
      </div>
    );
  }

  return (
    <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {websites.map((website) => (
        <DirectoryToolCard
          key={website.id}
          website={website}
          category={categoryById.get(website.category_id)}
          onVisit={onVisit}
        />
      ))}
    </div>
  );
}

function SearchEmptyState({
  query,
  categoryName,
  onClear,
}: {
  query: string;
  categoryName?: string;
  onClear: () => void;
}) {
  return (
    <div className="rounded-lg border bg-card px-5 py-12 text-center shadow-sm">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <SearchX className="h-6 w-6" />
      </div>
      <h3 className="mt-4 text-lg font-semibold">No matching AI tools</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        {query.trim()
          ? `No tools match "${query.trim()}"`
          : "No tools match the current filters"}
        {categoryName ? ` in ${categoryName}` : ""}. Try a broader keyword or
        clear the category filter.
      </p>
      <Button variant="outline" size="sm" className="mt-5" onClick={onClear}>
        Clear search filters
      </Button>
    </div>
  );
}

function DirectoryToolCard({
  website,
  category,
  onVisit,
}: {
  website: Website;
  category?: Category;
  onVisit: (website: Website) => void;
}) {
  return (
    <Card className="group flex h-full flex-col gap-4 p-4 transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
      <div className="flex items-start gap-3">
        <WebsiteThumbnail
          url={website.url}
          thumbnail={website.thumbnail}
          thumbnail_base64={website.thumbnail_base64}
          title={website.title}
          className="h-11 w-11 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <h3 className="truncate font-semibold group-hover:text-primary">
              {website.title}
            </h3>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => onVisit(website)}
              aria-label={`Visit ${website.title}`}
            >
              <ArrowUpRight className="h-4 w-4" />
            </Button>
          </div>
          <Badge variant="secondary" className="mt-1 font-normal">
            {category?.name || "Uncategorized"}
          </Badge>
        </div>
      </div>

      <p className="line-clamp-2 min-h-[40px] text-sm leading-5 text-muted-foreground">
        {website.description}
      </p>

      <div className="mt-auto flex items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <BarChart3 className="h-3.5 w-3.5" />
          {website.visits}
        </span>
        <span className="inline-flex items-center gap-1">
          <Heart className="h-3.5 w-3.5" />
          {website.likes}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-primary">
          <TrendingUp className="h-3.5 w-3.5" />
          View
        </span>
      </div>
    </Card>
  );
}
