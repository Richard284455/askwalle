import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, CalendarDays } from "lucide-react";
import type { BaseResourceItem, ResourceSource } from "@/data/resources/types";
import { Badge } from "@/ui/common/badge";
import { Button } from "@/ui/common/button";
import { Card } from "@/ui/common/card";

interface ResourceDetailLayoutProps {
  item: BaseResourceItem;
  backHref: string;
  backLabel: string;
  eyebrow: string;
  meta?: ReactNode;
  children: ReactNode;
  sidebar?: ReactNode;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function ResourceDetailLayout({
  item,
  backHref,
  backLabel,
  eyebrow,
  meta,
  children,
  sidebar,
}: ResourceDetailLayoutProps) {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-background">
      <section className="border-b border-border/70 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_58%,#f1f5f9_100%)] dark:bg-[linear-gradient(180deg,hsl(var(--background))_0%,hsl(var(--card))_100%)]">
        <div className="container mx-auto px-4 py-8 md:py-14">
          <Button asChild variant="ghost" size="sm" className="-ml-3 mb-5 gap-2">
            <Link href={backHref}>
              <ArrowLeft className="h-4 w-4" />
              {backLabel}
            </Link>
          </Button>

          <div className="max-w-4xl">
            <Badge variant="outline" className="mb-4 bg-background px-3 py-1">
              {eyebrow}
            </Badge>
            <h1 className="text-3xl font-semibold tracking-normal text-slate-950 md:text-5xl dark:text-foreground">
              {item.title}
            </h1>
            <p className="mt-4 max-w-3xl text-sm leading-6 text-slate-600 md:text-base dark:text-muted-foreground">
              {item.summary}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-white px-3 py-1 dark:bg-card">
                <CalendarDays className="h-3.5 w-3.5" />
                {formatDate(item.publishedAt)}
              </span>
              <span className="rounded-full border border-border/80 bg-white px-3 py-1 dark:bg-card">
                {item.category}
              </span>
              {meta}
            </div>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {item.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-border/80 bg-white px-2.5 py-1 text-xs text-slate-500 dark:bg-card dark:text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <main className="container mx-auto grid gap-8 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:py-10">
        <article className="space-y-6">{children}</article>
        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          {sidebar}
          <SourcesSection sources={item.sources} />
        </aside>
      </main>
    </div>
  );
}

export function DetailCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="rounded-xl border-border/80 bg-white p-5 shadow-sm shadow-slate-900/[0.03] dark:bg-card">
      <h2 className="text-xl font-semibold text-slate-950 dark:text-foreground">
        {title}
      </h2>
      <div className="mt-3 text-sm leading-7 text-slate-600 dark:text-muted-foreground">
        {children}
      </div>
    </Card>
  );
}

export function NumberedList({ items }: { items: string[] }) {
  return (
    <ol className="space-y-3">
      {items.map((item, index) => (
        <li key={item} className="flex gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-semibold text-primary">
            {index + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

export function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item} className="flex gap-2">
          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function SourcesSection({ sources }: { sources?: ResourceSource[] }) {
  if (!sources || sources.length === 0) {
    return null;
  }

  return (
    <Card className="rounded-xl border-border/80 bg-white p-4 shadow-sm shadow-slate-900/[0.03] dark:bg-card">
      <h2 className="font-semibold text-slate-950 dark:text-foreground">
        Sources and references
      </h2>
      <div className="mt-3 space-y-3">
        {sources.map((source) => (
          <a
            key={source.url}
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-lg border border-border/80 bg-slate-50 p-3 transition-colors hover:border-primary/30 hover:bg-white dark:bg-background dark:hover:bg-card"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-slate-950 dark:text-foreground">
                  {source.title}
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-muted-foreground">
                  {source.publisher} · Accessed {source.accessedAt}
                </p>
              </div>
              <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </div>
          </a>
        ))}
      </div>
    </Card>
  );
}
