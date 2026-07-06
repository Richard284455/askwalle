import type { ReactNode } from "react";
import { Badge } from "@/ui/common/badge";

interface ResourceHeroProps {
  icon: ReactNode;
  label?: string;
  title: string;
  description: string;
}

export function ResourceHero({
  icon,
  label = "AI resource hub",
  title,
  description,
}: ResourceHeroProps) {
  return (
    <section className="border-b border-border/70 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_58%,#f1f5f9_100%)] dark:bg-[linear-gradient(180deg,hsl(var(--background))_0%,hsl(var(--card))_100%)]">
      <div className="container mx-auto px-4 py-10 md:py-16">
        <div className="mx-auto max-w-4xl text-center">
          <Badge
            variant="outline"
            className="mb-4 gap-2 rounded-full border-primary/20 bg-white/85 px-3 py-1 text-primary shadow-sm dark:bg-card/80"
          >
            {icon}
            {label}
          </Badge>
          <h1 className="text-3xl font-semibold tracking-normal text-slate-950 md:text-5xl dark:text-foreground">
            {title}
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-slate-600 md:text-base dark:text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
    </section>
  );
}
