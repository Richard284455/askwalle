import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { ResourceItem } from "@/data/resources/types";
import { Button } from "@/ui/common/button";
import { Card } from "@/ui/common/card";
import { ResourceCard } from "./resource-card";

interface ResourceSectionProps {
  eyebrow?: string;
  title: string;
  description: string;
  href: string;
  items: ResourceItem[];
  emptyDescription?: string;
}

export function ResourceSection({
  eyebrow = "Resources",
  title,
  description,
  href,
  items,
  emptyDescription = "No published resources are available for this section yet.",
}: ResourceSectionProps) {
  return (
    <section>
      <div className="mb-5 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-normal text-primary">
            {eyebrow}
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-normal text-slate-950 md:text-2xl dark:text-foreground">
            {title}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 md:text-base dark:text-muted-foreground">
            {description}
          </p>
        </div>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="w-full bg-white/70 md:w-auto dark:bg-background/60"
        >
          <Link href={href} className="gap-2">
            View all
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
      {items.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <ResourceCard key={item.slug} item={item} />
          ))}
        </div>
      ) : (
        <Card className="rounded-lg border-border/80 bg-white p-5 text-sm leading-6 text-slate-600 shadow-sm shadow-slate-900/[0.03] dark:bg-card dark:text-muted-foreground">
          {emptyDescription}
        </Card>
      )}
    </section>
  );
}
