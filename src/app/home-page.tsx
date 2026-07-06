"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useAtom } from "jotai";
import { motion } from "framer-motion";
import {
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Clock3,
  Folder,
  Gift,
  Heart,
  Plus,
  SearchX,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/ui/common/badge";
import { Button } from "@/ui/common/button";
import { Card } from "@/ui/common/card";
import { SearchBox } from "@/components/search-box";
import WebsiteGrid from "@/components/website/website-grid";
import { WebsiteThumbnail } from "@/components/website/website-thumbnail";
import { ResourceSection } from "@/components/resources/resource-section";
import {
  categoriesAtom,
  searchQueryAtom,
  selectedCategoryAtom,
  websitesAtom,
} from "@/lib/atoms";
import { cn } from "@/lib/utils/utils";
import { createToolSlug } from "@/lib/website/tool-index";
import type { Website, Category } from "@/lib/types";
import type { PublicResourceListItem } from "@/lib/resources/resource-content";

interface HomePageProps {
  initialWebsites: Website[];
  initialCategories: Category[];
  resourcePreviews: {
    latestNews: PublicResourceListItem[];
    latestReviews: PublicResourceListItem[];
    featuredPrompts: PublicResourceListItem[];
    popularSkills: PublicResourceListItem[];
    beginnerTutorials: PublicResourceListItem[];
  };
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
  resourcePreviews,
}: HomePageProps) {
  const [websites, setWebsites] = useAtom(websitesAtom);
  const [categories, setCategories] = useAtom(categoriesAtom);
  const [searchQuery, setSearchQuery] = useAtom(searchQueryAtom);
  const [selectedCategory, setSelectedCategory] = useAtom(selectedCategoryAtom);
  const [activeExploreTab, setActiveExploreTab] = useState<
    "new" | "liked" | "used"
  >("new");

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

  const mostLikedTools = useMemo(() => {
    return [...websites].sort((a, b) => b.likes - a.likes).slice(0, 6);
  }, [websites]);

  const newTools = useMemo(() => {
    return [...websites]
      .sort(
        (a, b) =>
          new Date(b.created_at || 0).getTime() -
          new Date(a.created_at || 0).getTime()
      )
      .slice(0, 6);
  }, [websites]);

  const freeToolsPreview = useMemo(() => {
    const keywordMatches = websites.filter((website) => {
      const text = `${website.title} ${website.description}`.toLowerCase();
      return (
        text.includes("free") ||
        text.includes("免费") ||
        text.includes("trial") ||
        text.includes("freemium")
      );
    });

    return (keywordMatches.length > 0 ? keywordMatches : websites)
      .slice()
      .sort((a, b) => b.likes - a.likes || b.visits - a.visits)
      .slice(0, 6);
  }, [websites]);

  const exploreTabs = [
    {
      id: "new" as const,
      label: "New Tools",
      icon: Clock3,
      tools: newTools,
      description: "Freshly added approved tools from the directory.",
    },
    {
      id: "liked" as const,
      label: "Most Liked",
      icon: Heart,
      tools: mostLikedTools,
      description: "Tools with the strongest like signals.",
    },
    {
      id: "used" as const,
      label: "Most Used",
      icon: BarChart3,
      tools: topVisitedTools,
      description: "Tools ranked by recorded visits.",
    },
  ];
  const activeExplore = exploreTabs.find((tab) => tab.id === activeExploreTab) || exploreTabs[0];

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
    <div className="min-h-screen bg-slate-50 text-foreground dark:bg-background">
      <section className="border-b border-border/70 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_58%,#f1f5f9_100%)] dark:bg-[linear-gradient(180deg,hsl(var(--background))_0%,hsl(var(--card))_100%)]">
        <div className="container mx-auto px-4 py-10 md:py-16 lg:py-20">
          <div className="mx-auto flex max-w-5xl flex-col items-center text-center">
            <Badge
              variant="outline"
              className="mb-5 gap-2 rounded-full border-primary/20 bg-white/85 px-3 py-1 text-primary shadow-sm dark:bg-card/80"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Curated AI tools directory
            </Badge>

            <h1 className="max-w-4xl text-3xl font-bold leading-tight tracking-normal text-slate-950 sm:text-4xl md:text-5xl lg:text-6xl dark:text-foreground">
              Discover practical AI tools for every workflow
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base md:mt-5 md:text-lg md:leading-7 dark:text-muted-foreground">
              Search, compare, and browse a growing directory of AI products
              for writing, coding, design, research, automation, and daily work.
            </p>

            <div
              id="directory-search"
              className="mt-7 w-full max-w-3xl scroll-mt-24 md:mt-9 md:scroll-mt-28"
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

            <div className="mt-6 flex max-w-4xl flex-wrap items-center justify-center gap-2">
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

            <div className="mt-9 grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
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
        <motion.section {...sectionMotion}>
          <SectionHeader
            eyebrow="Explore"
            title="Browse AI tools by signal"
            description="Switch between the newest tools, community favorites, and the most used products."
          />

          <div className="mt-5 rounded-lg border border-border/80 bg-white p-3 shadow-sm shadow-slate-900/[0.04] dark:bg-card">
            <div className="grid gap-2 sm:grid-cols-3">
              {exploreTabs.map((tab) => {
                const Icon = tab.icon;
                const active = activeExploreTab === tab.id;

                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveExploreTab(tab.id)}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm font-medium transition-all",
                      active
                        ? "border-primary bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                        : "border-border bg-slate-50 text-slate-600 hover:border-primary/40 hover:bg-white hover:text-slate-950 dark:bg-background dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground"
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="mt-4">
              <p className="mb-4 text-sm text-slate-600 dark:text-muted-foreground">
                {activeExplore.description}
              </p>
              <ToolCardGrid
                websites={activeExplore.tools}
                categoryById={categoryById}
                onVisit={handleVisit}
              />
            </div>
          </div>
        </motion.section>

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
                  "group flex min-h-[112px] flex-col justify-between rounded-lg border border-border/80 bg-white p-4 text-left shadow-sm shadow-slate-900/[0.03] transition-all dark:bg-card",
                  "hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md hover:shadow-slate-900/[0.07]",
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

        <motion.section {...sectionMotion} id="new-tools" className="scroll-mt-28">
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

        <motion.section {...sectionMotion} id="popular-tools" className="scroll-mt-28">
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

        <motion.section {...sectionMotion} id="free-ai-tools" className="scroll-mt-28">
          <SectionHeader
            eyebrow="Free AI tools"
            title="Preview tools that may offer a free way to start"
            description="This preview uses existing directory data only. Always verify current pricing on each tool website."
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/#free-ai-tools">View preview</Link>
              </Button>
            }
          />
          <ToolCardGrid
            websites={freeToolsPreview}
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

        <div className="rounded-xl border border-border/80 bg-white px-4 py-6 shadow-sm shadow-slate-900/[0.04] dark:bg-card/70 md:px-6 md:py-8">
          <SectionHeader
            eyebrow="Resource hub"
            title="Learn what to use, compare, and try next"
            description="Browse concise news, reviews, prompts, skills, and tutorials built around practical AI workflows."
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/resources">Open resource hub</Link>
              </Button>
            }
          />
          <div className="mt-7 space-y-10 md:space-y-14">
            <motion.div {...sectionMotion}>
              <ResourceSection
                eyebrow="AI resources"
                title="Latest AI News"
                description="Short, source-attributed AI updates with original AskWalle analysis."
                href="/news"
                items={resourcePreviews.latestNews}
              />
            </motion.div>

            <motion.div {...sectionMotion}>
              <ResourceSection
                eyebrow="AI resources"
                title="Featured AI Reviews"
                description="Evaluation frameworks for comparing AI tools by workflow fit."
                href="/reviews"
                items={resourcePreviews.latestReviews}
              />
            </motion.div>

            <motion.div {...sectionMotion}>
              <ResourceSection
                eyebrow="AI resources"
                title="Popular Prompts"
                description="Reusable prompts for planning, writing, coding, research, and business tasks."
                href="/prompts"
                items={resourcePreviews.featuredPrompts}
              />
            </motion.div>

            <motion.div {...sectionMotion}>
              <ResourceSection
                eyebrow="AI resources"
                title="AI Skills to Try"
                description="Practical workflows for applying AI to repeatable work."
                href="/skills"
                items={resourcePreviews.popularSkills}
              />
            </motion.div>

            <motion.div {...sectionMotion}>
              <ResourceSection
                eyebrow="AI resources"
                title="Beginner AI Tutorials"
                description="Step-by-step guides for building confidence with AI tools and workflows."
                href="/tutorials"
                items={resourcePreviews.beginnerTutorials}
              />
            </motion.div>
          </div>
        </div>

        <motion.section
          {...sectionMotion}
          className="overflow-hidden rounded-xl border border-primary/15 bg-[linear-gradient(135deg,#ffffff_0%,#eff6ff_55%,#eef2ff_100%)] px-5 py-8 shadow-sm shadow-slate-900/[0.04] dark:bg-[linear-gradient(135deg,hsl(var(--card))_0%,hsl(var(--background))_100%)] md:px-8 md:py-10"
        >
          <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div className="max-w-2xl">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-white px-3 py-1 text-sm font-medium text-primary shadow-sm dark:bg-card">
                <Plus className="h-3.5 w-3.5" />
                Submit a tool
              </div>
              <h2 className="text-2xl font-semibold text-slate-950 md:text-3xl dark:text-foreground">
                Know an AI product worth sharing?
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600 md:text-base dark:text-muted-foreground">
                Add it to the directory for review and help others find useful
                AI tools faster.
              </p>
            </div>
            <Button
              asChild
              size="lg"
              className="w-full gap-2 shadow-sm shadow-primary/20 md:w-auto"
            >
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
        <p className="text-xs font-semibold uppercase tracking-normal text-primary">
          {eyebrow}
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-normal text-slate-950 md:text-3xl dark:text-foreground">
          {title}
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 md:text-base dark:text-muted-foreground">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/80 bg-white/90 px-4 py-3 text-left shadow-sm shadow-slate-900/[0.03] dark:bg-card/80">
      <p className="text-2xl font-semibold text-slate-950 dark:text-foreground">
        {value}
      </p>
      <p className="mt-1 text-sm text-slate-600 dark:text-muted-foreground">
        {label}
      </p>
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
        "inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm font-medium shadow-sm transition-all",
        active
          ? "border-primary bg-primary text-primary-foreground shadow-primary/20"
          : "border-border/80 bg-white text-slate-600 hover:border-primary/40 hover:bg-primary/5 hover:text-slate-950 dark:bg-card dark:text-muted-foreground dark:hover:text-foreground"
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "rounded-full px-1.5 py-0.5 text-[11px]",
          active
            ? "bg-primary-foreground/15 text-primary-foreground"
            : "bg-slate-100 text-slate-500 dark:bg-muted dark:text-muted-foreground"
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
      <div className="mt-5 rounded-lg border border-border/80 bg-white p-8 text-center text-sm text-slate-600 shadow-sm shadow-slate-900/[0.03] dark:bg-card dark:text-muted-foreground">
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
    <div className="rounded-lg border border-border/80 bg-white px-5 py-12 text-center shadow-sm shadow-slate-900/[0.03] dark:bg-card">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        <SearchX className="h-6 w-6" />
      </div>
      <h3 className="mt-4 text-lg font-semibold text-slate-950 dark:text-foreground">
        No matching AI tools
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600 dark:text-muted-foreground">
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
  const detailHref = `/tools/${createToolSlug(website)}`;

  return (
    <Card className="group flex h-full flex-col gap-4 rounded-lg border-border/80 bg-white p-4 shadow-sm shadow-slate-900/[0.03] transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md hover:shadow-slate-900/[0.07] dark:bg-card">
      <div className="flex items-start gap-3">
        <WebsiteThumbnail
          url={website.url}
          thumbnail={website.thumbnail}
          thumbnail_base64={website.thumbnail_base64}
          title={website.title}
          className="h-11 w-11 shrink-0 rounded-lg"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <Link
              href={detailHref}
              className="min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <h3 className="truncate font-semibold text-slate-950 group-hover:text-primary dark:text-foreground">
                {website.title}
              </h3>
            </Link>
            <Button
              asChild
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0 border-border/80 bg-white/70 hover:bg-primary hover:text-primary-foreground dark:bg-background/60"
            >
              <Link
                href={detailHref}
                aria-label={`View details for ${website.title}`}
              >
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
          <Badge
            variant="secondary"
            className="mt-1 bg-slate-100 font-normal text-slate-600 dark:bg-muted dark:text-muted-foreground"
          >
            {category?.name || "Uncategorized"}
          </Badge>
        </div>
      </div>

      <Link href={detailHref}>
        <p className="line-clamp-2 min-h-[40px] text-sm leading-5 text-slate-600 dark:text-muted-foreground">
          {website.description}
        </p>
      </Link>

      <div className="mt-auto flex items-center gap-4 border-t border-border/60 pt-3 text-xs text-slate-500 dark:text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <BarChart3 className="h-3.5 w-3.5" />
          {website.visits}
        </span>
        <span className="inline-flex items-center gap-1">
          <Heart className="h-3.5 w-3.5" />
          {website.likes}
        </span>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="ml-auto h-8 gap-1 border-border/80 bg-white/70 px-2 text-xs hover:bg-primary hover:text-primary-foreground dark:bg-background/60"
        >
          <Link href={detailHref}>
            View Details
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => onVisit(website)}
          className="h-8 gap-1 px-2 text-xs shadow-sm shadow-primary/20"
          aria-label={`Visit website for ${website.title}`}
        >
          Visit Website
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </Card>
  );
}
