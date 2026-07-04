"use client";

import { JSX, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, ChevronDown, Search, X } from "lucide-react";
import { Button } from "@/ui/common/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/common/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/common/select";
import type { Category, Website } from "@/lib/types";

interface SearchEngine {
  id: string;
  name: string;
  icon: JSX.Element;
  searchUrl: string;
}

const searchEngines: SearchEngine[] = [
  {
    id: "local",
    name: "站内",
    icon: <Search className="h-4 w-4 text-primary" />,
    searchUrl: "",
  },
  {
    id: "baidu",
    name: "百度",
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12.71 3.37c1.54-.8 3.31.2 3.31 1.56 0 1.96-2.37 5.25-2.37 5.25s2.8-1.17 2.8-4.11c0-2.37-2.14-3.49-3.74-2.7zm-1.42 0c-1.6-.79-3.74.33-3.74 2.7 0 2.94 2.8 4.11 2.8 4.11S8 6.89 8 4.93c0-1.36 1.77-2.36 3.31-1.56zm7.09 5.56c-.85-1.6-3.44-2.71-3.44-2.71s2.21 2.1 2.21 4.21c0 1.88-1.7 3.46-3.82 3.46-2.12 0-3.82-1.58-3.82-3.46h-1c0 1.88-1.7 3.46-3.82 3.46-2.12 0-3.82-1.58-3.82-3.46 0-2.11 2.21-4.21 2.21-4.21S.84 7.33 0 8.93c-1.06 2.01-.79 4.52.77 6.09 2.65 2.65 6.14 1.8 7.73.31 1.59 1.49 5.08 2.34 7.73-.31 1.56-1.57 1.83-4.08.77-6.09zM8.62 15.5c-.51 1.63-2.55 2.38-4.11 1.72-1.39-.59-1.91-2.38-1.91-2.38s.67 3.88 3.27 3.88c2.6 0 3.26-2.39 2.75-3.22zm10.78-.66s-.52 1.79-1.91 2.38c-1.56.66-3.6-.09-4.11-1.72-.51.83.15 3.22 2.75 3.22 2.6 0 3.27-3.88 3.27-3.88z" />
      </svg>
    ),
    searchUrl: "https://www.baidu.com/s?wd=",
  },
  {
    id: "google",
    name: "Google",
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24">
        <path
          fill="#4285F4"
          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        />
        <path
          fill="#34A853"
          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        />
        <path
          fill="#FBBC05"
          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        />
        <path
          fill="#EA4335"
          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        />
      </svg>
    ),
    searchUrl: "https://www.google.com/search?q=",
  },
];

interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  categories?: Category[];
  websites?: Website[];
  selectedCategory?: number | null;
  onCategoryChange?: (categoryId: number | null) => void;
  resultCount?: number;
  totalCount?: number;
  onSearchSubmit?: () => void;
}

export function SearchBox({
  value,
  onChange,
  className,
  categories = [],
  websites = [],
  selectedCategory = null,
  onCategoryChange,
  resultCount,
  totalCount,
  onSearchSubmit,
}: SearchBoxProps) {
  const router = useRouter();
  const [selectedEngine, setSelectedEngine] = useState<SearchEngine>(
    searchEngines[0]
  );
  const [localValue, setLocalValue] = useState(value);
  const [isFocused, setIsFocused] = useState(false);
  const hasDirectoryFilters =
    selectedEngine.id === "local" && (!!localValue.trim() || !!selectedCategory);
  const normalizedQuery = localValue.trim().toLowerCase();
  const categoryById = useMemo(() => {
    return new Map(categories.map((category) => [category.id, category]));
  }, [categories]);
  const suggestedTools = useMemo(() => {
    if (!normalizedQuery) return [];

    return websites
      .filter((website) => {
        const categoryName =
          categoryById.get(website.category_id)?.name.toLowerCase() || "";
        return (
          website.title.toLowerCase().includes(normalizedQuery) ||
          website.description.toLowerCase().includes(normalizedQuery) ||
          categoryName.includes(normalizedQuery)
        );
      })
      .sort((a, b) => b.visits - a.visits || b.likes - a.likes)
      .slice(0, 5);
  }, [websites, categoryById, normalizedQuery]);
  const showSuggestions =
    selectedEngine.id === "local" && isFocused && normalizedQuery.length > 0;

  useEffect(() => {
    if (selectedEngine.id === "local") {
      setLocalValue(value);
    }
  }, [value, selectedEngine.id]);

  // 处理搜索引擎切换
  useEffect(() => {
    if (selectedEngine.id === "local") {
      onChange(value); // 切换到站内搜索时保留外部传入值
    } else {
      onChange(""); // 切换到外部搜索时，清空站内搜索
    }
  }, [selectedEngine.id]);

  const handleSearch = () => {
    if (selectedEngine.id === "local") {
      const query = localValue.trim();
      if (!query) return;

      onChange(query);
      onSearchSubmit?.();
      const params = new URLSearchParams();
      if (selectedCategory) {
        params.set("category", String(selectedCategory));
      }
      const suffix = params.toString() ? `?${params.toString()}` : "";
      router.push(`/search/${encodeURIComponent(query)}${suffix}`);
    } else {
      if (!localValue.trim()) return;
      // 外部搜索引擎
      window.open(
        selectedEngine.searchUrl + encodeURIComponent(localValue),
        "_blank"
      );
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setLocalValue(newValue);
  };

  const handleCategoryChange = (value: string) => {
    onCategoryChange?.(value === "all" ? null : Number(value));
  };

  const handleClear = () => {
    setLocalValue("");
    onChange("");
    onCategoryChange?.(null);
  };

  const handleSuggestionSearch = (value: string) => {
    setLocalValue(value);
    onChange(value);
    router.push(`/search/${encodeURIComponent(value)}`);
  };

  return (
    <div className={`relative mx-auto w-full max-w-3xl ${className}`}>
      <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-background p-2 shadow-lg shadow-black/[0.04] transition-colors focus-within:border-primary/50 md:flex-row md:items-center md:p-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-10 w-full justify-start gap-2 rounded-md px-2.5 transition-colors hover:bg-muted data-[state=open]:bg-muted md:w-auto md:px-3"
            >
              {selectedEngine.icon}
              <span className="font-medium text-sm">
                {selectedEngine.name}
              </span>
              <ChevronDown className="h-3.5 w-3.5 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[150px]">
            {searchEngines.map((engine) => (
              <DropdownMenuItem
                key={engine.id}
                onClick={() => setSelectedEngine(engine)}
                className="gap-2"
              >
                {engine.icon}
                <span className="font-medium">{engine.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search AI tools, categories, use cases..."
            value={localValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => {
              window.setTimeout(() => setIsFocused(false), 120);
            }}
            className="h-10 w-full rounded-md border-0 bg-muted/40 pl-9 pr-3 text-sm outline-none ring-0 placeholder:text-muted-foreground focus:bg-muted"
          />
        </div>

        {selectedEngine.id === "local" && categories.length > 0 && (
          <Select
            value={selectedCategory ? String(selectedCategory) : "all"}
            onValueChange={handleCategoryChange}
          >
            <SelectTrigger className="h-10 w-full border-0 bg-muted/40 md:w-[190px]">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((category) => (
                <SelectItem key={category.id} value={String(category.id)}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Button
          variant="default"
          size="sm"
          className="h-10 w-full rounded-md px-4 shadow-sm md:w-auto"
          onClick={handleSearch}
        >
          搜索
        </Button>

        {hasDirectoryFilters && (
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 shrink-0"
            onClick={handleClear}
            aria-label="Clear search filters"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {selectedEngine.id === "local" &&
        typeof resultCount === "number" &&
        typeof totalCount === "number" && (
          <div className="mt-3 text-center text-xs text-muted-foreground">
            Showing {resultCount} of {totalCount} AI tools
            {selectedCategory ? " in the selected category" : ""}
          </div>
        )}

      {showSuggestions && (
        <div className="absolute left-0 right-0 z-40 mt-3 max-h-[70vh] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left text-sm transition-colors hover:bg-muted/60"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => handleSuggestionSearch(localValue.trim())}
          >
            <span className="min-w-0 break-words">
              Search for{" "}
              <span className="font-semibold text-primary">
                {localValue.trim()}
              </span>{" "}
              using AI
            </span>
            <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
          </button>

          <div className="border-t bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
            Tools({suggestedTools.length})
          </div>

          {suggestedTools.length > 0 ? (
            <div className="max-h-[48vh] divide-y overflow-y-auto">
              {suggestedTools.map((website) => (
                <button
                  key={website.id}
                  type="button"
                  className="grid w-full grid-cols-[minmax(0,1fr)] gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/60 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-3"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleSuggestionSearch(website.title)}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {website.title}
                    </div>
                    <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                      {website.description}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {website.visits.toLocaleString()} visits
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Press Enter to search the directory.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
