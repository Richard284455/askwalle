"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Folder,
  Menu,
  Plus,
  Search,
  Sparkles,
  Trophy,
  X,
} from "lucide-react";
import { Button } from "@/ui/common/button";
import ThemeSwitch from "@/components/theme-switcher/theme-switch";

const mobileNavItems = [
  { href: "/#all-tools", label: "AI Tools", icon: Sparkles },
  { href: "/categories", label: "Categories", icon: Folder },
  { href: "/rankings", label: "Rankings", icon: Trophy },
  { href: "/#directory-search", label: "Search", icon: Search },
];

export default function MobileMenu() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="md:hidden">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setIsOpen((open) => !open)}
        aria-label={isOpen ? "Close navigation menu" : "Open navigation menu"}
      >
        {isOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </Button>

      {isOpen && (
        <div className="absolute left-0 right-0 top-14 mx-3 rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur-xl md:top-16">
          <div className="flex flex-col gap-1">
            {mobileNavItems.map(({ href, label, icon: Icon }) => (
              <Button
                key={href}
                asChild
                variant="ghost"
                className="h-11 justify-start gap-3 rounded-md"
                onClick={() => setIsOpen(false)}
              >
                <Link href={href}>
                  <Icon className="h-4 w-4 text-primary" />
                  {label}
                </Link>
              </Button>
            ))}

            <div className="my-2 h-px bg-border" />

            <Button
              asChild
              className="h-11 justify-start gap-3 rounded-md"
              onClick={() => setIsOpen(false)}
            >
              <Link href="/submit">
                <Plus className="h-4 w-4" />
                Submit Tool
              </Link>
            </Button>

            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-sm text-muted-foreground">Theme</span>
              <ThemeSwitch />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
