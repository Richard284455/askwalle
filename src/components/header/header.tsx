import Link from "next/link";
import {
  BookOpen,
  BrainCircuit,
  CalendarDays,
  ChevronDown,
  Flame,
  GraduationCap,
  Newspaper,
  Plus,
  Radio,
  ScrollText,
  Search,
  Sparkles,
} from "lucide-react";
import { Button } from "@/ui/common/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/common/dropdown-menu";
import ThemeSwitch from "@/components/theme-switcher/theme-switch";
import MobileMenu from "./mobile-menu";

const navItems = [
  { href: "/", label: "AI Tools" },
  { href: "/categories", label: "Categories" },
  { href: "/rankings", label: "Rankings" },
];

/**
 * 多语言资讯板块。
 *
 * 导航一律指向英文前缀 `/en`：主站导航本身就是英文的，其余三种语言
 * 由文章页顶部的语言互链进入。直接给 `/es` 之类会让英文读者莫名跳到西语页，
 * 而「按浏览器语言猜」是另一个更大的坑 —— 猜错时读者没有退路。
 */
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

export default function Header() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/80 bg-white/90 shadow-sm shadow-slate-900/[0.03] backdrop-blur-xl dark:bg-background/90 dark:shadow-black/20">
      <nav className="container mx-auto h-14 px-4 md:h-16">
        <div className="flex h-full items-center justify-between gap-4">
          <Link
            href="/"
            className="flex min-w-0 items-center gap-2.5 rounded-md transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm shadow-primary/20 md:h-9 md:w-9">
              <BrainCircuit className="h-4 w-4 md:h-5 md:w-5" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold leading-tight tracking-normal text-foreground sm:text-base">
                AskWalle AI Hub
              </span>
              <span className="hidden text-xs text-muted-foreground sm:block">
                AI tools directory
              </span>
            </span>
          </Link>

          <div className="hidden items-center gap-1 lg:flex">
            {navItems.map(({ href, label }) => (
              <Button
                key={href}
                asChild
                variant="ghost"
                size="sm"
                className="h-9 px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-200 dark:hover:bg-slate-800 dark:hover:text-white"
              >
                <Link href={href}>
                  {label}
                </Link>
              </Button>
            ))}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 gap-1.5 px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-200 dark:hover:bg-slate-800 dark:hover:text-white"
                >
                  <Flame className="h-4 w-4" />
                  Newsroom
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-52 rounded-lg border-border/80 bg-white/95 p-1.5 shadow-xl shadow-slate-900/10 backdrop-blur-xl dark:bg-card/95"
              >
                {newsroomItems.map(({ href, label, icon: Icon }) => (
                  <DropdownMenuItem key={href} asChild>
                    <Link
                      href={href}
                      className="gap-2 rounded-md px-2.5 py-2 text-sm font-medium"
                    >
                      <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
                      {label}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 gap-1.5 px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-200 dark:hover:bg-slate-800 dark:hover:text-white"
                >
                  <BookOpen className="h-4 w-4" />
                  Resources
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-52 rounded-lg border-border/80 bg-white/95 p-1.5 shadow-xl shadow-slate-900/10 backdrop-blur-xl dark:bg-card/95"
              >
                {resourceItems.map(({ href, label, icon: Icon }) => (
                  <DropdownMenuItem key={href} asChild>
                    <Link
                      href={href}
                      className="gap-2 rounded-md px-2.5 py-2 text-sm font-medium"
                    >
                      <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
                      {label}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="hidden items-center gap-2 md:flex">
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-9 gap-2 border-border/90 bg-white/80 text-slate-700 hover:bg-slate-50 hover:text-slate-950 dark:bg-card/70 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <Link href="/#directory-search" className="gap-2">
                <Search className="h-4 w-4" />
                Search
              </Link>
            </Button>
            <Button asChild size="sm" className="h-9 gap-2 shadow-sm shadow-primary/20">
              <Link href="/submit" className="gap-2">
                <Plus className="h-4 w-4" />
                Submit Tool
              </Link>
            </Button>
            <ThemeSwitch />
          </div>

          <MobileMenu />
        </div>
      </nav>
    </header>
  );
}
