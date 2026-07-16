"use client";

import Link from "next/link";
import { ArrowUpRight, CalendarDays, Eye, Heart, Medal } from "lucide-react";
import { Badge } from "@/ui/common/badge";
import { Button } from "@/ui/common/button";
import { Card } from "@/ui/common/card";
import { cn } from "@/lib/utils/utils";
import type { Category, Website } from "@/lib/types";
import { getToolHref } from "@/lib/website/tool-index";
import { WebsiteThumbnail } from "./website-thumbnail";

export type RankedWebsite = Website & {
  created_at: string;
  category: Category | null;
};

interface RankingsProps {
  websites: RankedWebsite[];
  onVisit: (website: RankedWebsite) => void;
}

type RankingMetric = "visits" | "likes" | "newest";

interface RankingSection {
  title: string;
  description: string;
  metric: RankingMetric;
  icon: typeof Eye;
  websites: RankedWebsite[];
}

const rankStyles = [
  "border-amber-400/40 bg-amber-400/10 text-amber-700 dark:text-amber-300",
  "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200",
  "border-orange-300/60 bg-orange-400/10 text-orange-700 dark:text-orange-300",
];

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function metricLabel(website: RankedWebsite, metric: RankingMetric) {
  if (metric === "visits") {
    return `${website.visits.toLocaleString()} visits`;
  }

  if (metric === "likes") {
    return `${website.likes.toLocaleString()} likes`;
  }

  return formatDate(website.created_at);
}

function RankingRow({
  website,
  index,
  metric,
  onVisit,
}: {
  website: RankedWebsite;
  index: number;
  metric: RankingMetric;
  onVisit: (website: RankedWebsite) => void;
}) {
  const MetricIcon = metric === "likes" ? Heart : metric === "newest" ? CalendarDays : Eye;

  return (
    <div
      className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-t border-border/60 px-3 py-3 transition-colors hover:bg-muted/40 sm:gap-3 sm:px-4"
    >
      <div
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-full border text-xs font-semibold",
          rankStyles[index] || "border-border bg-muted/60 text-muted-foreground"
        )}
      >
        {index < 3 ? <Medal className="h-3.5 w-3.5" /> : index + 1}
      </div>

      <div className="flex min-w-0 items-center gap-3">
        <WebsiteThumbnail
          url={website.url}
          thumbnail={website.thumbnail}
          thumbnail_base64={website.thumbnail_base64}
          title={website.title}
          className="h-9 w-9 shrink-0 rounded-md sm:h-10 sm:w-10"
        />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Link
              href={getToolHref(website)}
              className="min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <h3 className="truncate text-sm font-semibold group-hover:text-primary">
                {website.title}
              </h3>
            </Link>
            {website.category && (
              <Badge variant="secondary" className="hidden shrink-0 px-2 py-0 text-[11px] sm:inline-flex">
                {website.category.name}
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-1 text-xs leading-5 text-muted-foreground">
            {website.description}
          </p>
          <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Eye className="h-3 w-3" />
              {website.visits.toLocaleString()}
            </span>
            <span className="inline-flex items-center gap-1">
              <Heart className="h-3 w-3" />
              {website.likes.toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        <div className="hidden text-right text-xs text-muted-foreground md:block">
          <div className="inline-flex items-center gap-1 font-medium text-foreground">
            <MetricIcon className="h-3.5 w-3.5" />
            {metricLabel(website, metric)}
          </div>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => onVisit(website)}
          aria-label={`Visit ${website.title}`}
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function RankingPanel({
  section,
  onVisit,
}: {
  section: RankingSection;
  onVisit: (website: RankedWebsite) => void;
}) {
  const Icon = section.icon;

  return (
    <Card className="overflow-hidden rounded-lg border-border/70 bg-card shadow-sm">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Icon className="h-4 w-4" />
            </span>
            <h2 className="text-base font-semibold">{section.title}</h2>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {section.description}
          </p>
        </div>
        <Badge variant="outline" className="w-fit shrink-0">
          Top {section.websites.length}
        </Badge>
      </div>

      {section.websites.length > 0 ? (
        <div>
          {section.websites.map((website, index) => (
            <RankingRow
              key={`${section.metric}-${website.id}`}
              website={website}
              index={index}
              metric={section.metric}
              onVisit={onVisit}
            />
          ))}
        </div>
      ) : (
        <div className="border-t border-border/60 px-4 py-10 text-center text-sm text-muted-foreground">
          No approved AI tools are available yet.
        </div>
      )}
    </Card>
  );
}

export function Rankings({ websites, onVisit }: RankingsProps) {
  const topByVisits = [...websites]
    .sort((a, b) => b.visits - a.visits || b.likes - a.likes)
    .slice(0, 10);
  const topByLikes = [...websites]
    .sort((a, b) => b.likes - a.likes || b.visits - a.visits)
    .slice(0, 10);
  const newest = [...websites]
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
    .slice(0, 10);

  const sections: RankingSection[] = [
    {
      title: "Top AI Tools by Visits",
      description: "The most visited tools in the directory, ranked by usage signals.",
      metric: "visits",
      icon: Eye,
      websites: topByVisits,
    },
    {
      title: "Most Liked AI Tools",
      description: "Community favorites based on likes from public tool cards.",
      metric: "likes",
      icon: Heart,
      websites: topByLikes,
    },
    {
      title: "Newest AI Tools",
      description: "Recently added approved tools from the latest database updates.",
      metric: "newest",
      icon: CalendarDays,
      websites: newest,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-col gap-4 md:mb-8 md:flex-row md:items-end md:justify-between">
        <div>
          <Badge variant="secondary" className="mb-3">
            AI tool rankings
          </Badge>
          <h1 className="text-2xl font-semibold tracking-normal sm:text-3xl md:text-4xl">
            Discover the tools people use, like, and add now
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground md:text-base">
            Browse public rankings for AI tools by visits, likes, and newest approvals.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-1.5 rounded-lg border bg-card p-2 text-center shadow-sm sm:gap-2">
          <div className="px-3 py-2">
            <div className="text-lg font-semibold">{websites.length}</div>
            <div className="text-[11px] text-muted-foreground">Tools</div>
          </div>
          <div className="px-3 py-2">
            <div className="text-lg font-semibold">
              {websites.reduce((sum, item) => sum + item.visits, 0).toLocaleString()}
            </div>
            <div className="text-[11px] text-muted-foreground">Visits</div>
          </div>
          <div className="px-3 py-2">
            <div className="text-lg font-semibold">
              {websites.reduce((sum, item) => sum + item.likes, 0).toLocaleString()}
            </div>
            <div className="text-[11px] text-muted-foreground">Likes</div>
          </div>
        </div>
      </div>

      <div className="grid gap-5">
        {sections.map((section) => (
          <RankingPanel key={section.metric} section={section} onVisit={onVisit} />
        ))}
      </div>
    </div>
  );
}
