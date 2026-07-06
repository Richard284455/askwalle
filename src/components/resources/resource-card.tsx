import Link from "next/link";
import { ArrowRight, CalendarDays, ExternalLink, Star } from "lucide-react";
import type { ResourceItem } from "@/data/resources/types";
import { Badge } from "@/ui/common/badge";
import { Card } from "@/ui/common/card";
import { cn } from "@/lib/utils/utils";

interface ResourceCardProps {
  item: ResourceItem;
  href?: string;
  className?: string;
}

function formatPublishedAt(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getOptionalMeta(item: ResourceItem) {
  if ("rating" in item && typeof item.rating === "number") {
    return {
      icon: Star,
      label: `${item.rating.toFixed(1)}`,
    };
  }

  if ("difficulty" in item && typeof item.difficulty === "string") {
    return {
      icon: null,
      label: item.difficulty,
    };
  }

  if ("level" in item && typeof item.level === "string") {
    return {
      icon: null,
      label: item.level,
    };
  }

  if (item.sourceName) {
    return {
      icon: ExternalLink,
      label: item.sourceName,
    };
  }

  return {
    icon: null,
    label: item.meta,
  };
}

export function ResourceCard({ item, href = item.href, className }: ResourceCardProps) {
  const optionalMeta = getOptionalMeta(item);
  const OptionalMetaIcon = optionalMeta.icon;

  return (
    <Link href={href} className="block h-full">
      <Card
        className={cn(
          "group flex h-full min-h-[184px] flex-col rounded-lg border-border/80 bg-white p-4 shadow-sm shadow-slate-900/[0.03] dark:bg-card",
          "transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md hover:shadow-slate-900/[0.07]",
          className
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <Badge
            variant="secondary"
            className="max-w-full truncate bg-slate-100 px-2 py-0 text-[11px] font-medium text-slate-600 dark:bg-muted dark:text-muted-foreground"
          >
            {item.category}
          </Badge>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-slate-500 dark:text-muted-foreground">
            <CalendarDays className="h-3.5 w-3.5" />
            {formatPublishedAt(item.publishedAt)}
          </span>
        </div>

        <h3 className="mt-3 line-clamp-2 text-sm font-semibold leading-5 text-slate-950 group-hover:text-primary dark:text-foreground">
          {item.title}
        </h3>
        <p className="mt-2 line-clamp-3 text-xs leading-5 text-slate-600 dark:text-muted-foreground">
          {item.summary}
        </p>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {item.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-border/70 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-500 dark:bg-background dark:text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>

        <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/60 pt-3">
          <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-xs font-medium text-slate-500 dark:text-muted-foreground">
            {OptionalMetaIcon ? (
              <OptionalMetaIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
            ) : null}
            <span className="truncate">{optionalMeta.label}</span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
            Read
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>
      </Card>
    </Link>
  );
}
