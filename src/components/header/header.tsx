import Link from "next/link";
import {
  BrainCircuit,
  Folder,
  Plus,
  Search,
  Sparkles,
  Trophy,
} from "lucide-react";
import { Button } from "@/ui/common/button";
import ThemeSwitch from "@/components/theme-switcher/theme-switch";
import MobileMenu from "./mobile-menu";

const navItems = [
  { href: "/#all-tools", label: "AI Tools", icon: Sparkles },
  { href: "/categories", label: "Categories", icon: Folder },
  { href: "/rankings", label: "Rankings", icon: Trophy },
];

export default function Header() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/70 bg-background/85 backdrop-blur-xl">
      <nav className="container mx-auto h-14 px-4 md:h-16">
        <div className="flex h-full items-center justify-between gap-4">
          <Link
            href="/"
            className="flex min-w-0 items-center gap-2.5 transition-opacity hover:opacity-85"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm md:h-9 md:w-9">
              <BrainCircuit className="h-4 w-4 md:h-5 md:w-5" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold leading-tight sm:text-base">
                AskWalle AI Hub
              </span>
              <span className="hidden text-xs text-muted-foreground sm:block">
                AI tools directory
              </span>
            </span>
          </Link>

          <div className="hidden items-center gap-1 lg:flex">
            {navItems.map(({ href, label, icon: Icon }) => (
              <Button key={href} asChild variant="ghost" size="sm">
                <Link href={href} className="gap-2">
                  <Icon className="h-4 w-4" />
                  {label}
                </Link>
              </Button>
            ))}
          </div>

          <div className="hidden items-center gap-2 md:flex">
            <Button asChild variant="outline" size="sm">
              <Link href="/#directory-search" className="gap-2">
                <Search className="h-4 w-4" />
                Search
              </Link>
            </Button>
            <Button asChild size="sm">
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
