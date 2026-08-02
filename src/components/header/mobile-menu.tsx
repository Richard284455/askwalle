"use client";

import { useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  CalendarDays,
  Flame,
  Folder,
  GraduationCap,
  Menu,
  Newspaper,
  Plus,
  Radio,
  ScrollText,
  Search,
  Sparkles,
  Trophy,
  X,
} from "lucide-react";
import { Button } from "@/ui/common/button";
import ThemeSwitch from "@/components/theme-switcher/theme-switch";

const mobileNavItems = [
  { href: "/", label: "AI Tools", icon: Sparkles },
  { href: "/categories", label: "Categories", icon: Folder },
  { href: "/rankings", label: "Rankings", icon: Trophy },
  { href: "/#directory-search", label: "Search", icon: Search },
];

/** 与桌面导航同一份清单：一律指向 /en，其余语言由文章页的语言互链进入 */
const newsroomItems = [
  { href: "/en/trending", label: "Trending", icon: Flame },
  { href: "/en/updates", label: "AI Updates", icon: Radio },
  { href: "/en/briefings/daily", label: "Daily Briefing", icon: CalendarDays },
];

const resourceItems = [
  { href: "/news", label: "AI News", icon: Newspaper },
  { href: "/reviews", label: "Reviews", icon: ScrollText },
  { href: "/prompts", label: "Prompts", icon: Sparkles },
  { href: "/skills", label: "Skills", icon: GraduationCap },
  { href: "/tutorials", label: "Tutorials", icon: BookOpen },
];

export default function MobileMenu() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="md:hidden">
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9 rounded-md text-slate-700 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-200 dark:hover:bg-slate-800 dark:hover:text-white"
        onClick={() => setIsOpen((open) => !open)}
        aria-label={isOpen ? "Close navigation menu" : "Open navigation menu"}
      >
        {isOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </Button>

      {isOpen && (
        <div className="absolute left-0 right-0 top-14 mx-3 rounded-lg border border-border/80 bg-white/95 p-3 shadow-xl shadow-slate-900/10 backdrop-blur-xl dark:bg-card/95 dark:shadow-black/30 md:top-16">
          <div className="flex flex-col gap-1.5">
            <div className="px-3 pb-2 pt-1">
              <p className="text-sm font-semibold text-foreground">
                AskWalle AI Hub
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Browse tools, rankings, and AI resources.
              </p>
            </div>

            {mobileNavItems.map(({ href, label, icon: Icon }) => (
              <Button
                key={href}
                asChild
                variant="ghost"
                className="h-11 justify-start gap-3 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-200 dark:hover:bg-slate-800 dark:hover:text-white"
                onClick={() => setIsOpen(false)}
              >
                <Link href={href}>
                  <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
                  {label}
                </Link>
              </Button>
            ))}

            <div className="my-2 h-px bg-border" />

            <div className="px-3 py-1 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
              Newsroom
            </div>

            {newsroomItems.map(({ href, label, icon: Icon }) => (
              <Button
                key={href}
                asChild
                variant="ghost"
                className="h-11 justify-start gap-3 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-200 dark:hover:bg-slate-800 dark:hover:text-white"
                onClick={() => setIsOpen(false)}
              >
                <Link href={href}>
                  <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
                  {label}
                </Link>
              </Button>
            ))}

            <div className="my-2 h-px bg-border" />

            <div className="px-3 py-1 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
              Resources
            </div>

            {resourceItems.map(({ href, label, icon: Icon }) => (
              <Button
                key={href}
                asChild
                variant="ghost"
                className="h-11 justify-start gap-3 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-200 dark:hover:bg-slate-800 dark:hover:text-white"
                onClick={() => setIsOpen(false)}
              >
                <Link href={href}>
                  <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
                  {label}
                </Link>
              </Button>
            ))}

            <div className="my-2 h-px bg-border" />

            <Button
              asChild
              className="h-11 justify-start gap-3 rounded-md shadow-sm shadow-primary/20"
              onClick={() => setIsOpen(false)}
            >
              <Link href="/submit">
                <Plus className="h-4 w-4" aria-hidden="true" />
                Submit Tool
              </Link>
            </Button>

            <div className="flex items-center justify-between rounded-md px-3 py-2">
              <span className="text-sm font-medium text-muted-foreground">Theme</span>
              <ThemeSwitch />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
