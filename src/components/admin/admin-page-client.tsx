"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";

import { WebsiteList } from "@/components/admin/website-list";
import { Badge } from "@/ui/common/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/common/select";
import { Input } from "@/ui/common/input";
import type { Category, Website } from "@/lib/types";
import { cn } from "@/lib/utils/utils";

/**
 * 后台首页的列表。
 *
 * **筛选条件走 URL，不走组件 state。**
 * 分页已经下推到 SQL，服务端必须知道「现在筛的是什么、翻到第几页」，
 * 而这两件事只有放在 URL 上才既能被服务端读到、又能被刷新和后退保住。
 *
 * 计数由服务端 groupBy 给出，不再在浏览器里数数组 ——
 * 那需要先把整表拉过来，正是把后台拖垮的原因。
 */

const STATUS_LABEL: Record<string, string> = {
  pending: "待审核",
  approved: "已通过",
  rejected: "已拒绝",
};

const STATUS_COLOR: Record<string, string> = {
  pending: "text-yellow-500",
  approved: "text-green-500",
  rejected: "text-red-500",
};

export function AdminPageClient({
  websites,
  categories,
  counts,
  activeStatus,
  activeCategory,
  query,
  page,
  pageSize,
  totalPages,
  total,
}: {
  websites: Website[];
  categories: Category[];
  counts: Record<string, number>;
  activeStatus: string;
  activeCategory: string;
  query: string;
  page: number;
  pageSize: number;
  totalPages: number;
  total: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [draftQuery, setDraftQuery] = useState(query);

  // 服务端换了一批数据（比如点了后退），输入框跟着回到那一次的搜索词
  useEffect(() => setDraftQuery(query), [query]);

  /**
   * 改一个筛选条件。
   *
   * 除翻页本身外，任何条件变化都把 page 重置回第一页 ——
   * 站在第 7 页把状态切成「已拒绝」，而已拒绝只有 2 条，
   * 不重置就会停在一个空页上，看起来像没有数据。
   */
  function setParam(patch: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "" || v === "all") next.delete(k);
      else next.set(k, v);
    }
    if (!("page" in patch)) next.delete("page");
    startTransition(() => router.push(`${pathname}?${next.toString()}`));
  }

  /*
   * 起始序号按**每页容量**算，不能按本页实际条数算 ——
   * 最后一页往往不满，用实际条数会把序号算小（第 5 页 3 条时算成「第 13 条」）。
   */
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="container max-w-6xl mx-auto px-4 sm:px-6 py-4 sm:py-6 min-h-[calc(100vh-4rem)] space-y-6"
    >
      {/* Header Section */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-background/30 backdrop-blur-sm p-6 rounded-xl border border-border/40">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-foreground">
            后台管理
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            管理网站内容和系统设置
          </p>
        </div>
      </div>

      {/* Main Content */}
      <div className="rounded-xl border border-border/40 bg-background/30 shadow-sm overflow-hidden backdrop-blur-sm">
        {/* Filter Section */}
        <div className="border-b border-border/40 bg-background/20 p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex flex-wrap gap-2 flex-1">
              {["pending", "approved", "rejected"].map((status) => (
                <motion.button
                  key={status}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setParam({ status })}
                  className={`
                    flex items-center gap-2 px-4 py-2 rounded-lg border transition-all duration-200
                    ${
                      activeStatus === status
                        ? "bg-background/40 border-primary/30 shadow-sm " +
                          STATUS_COLOR[status]
                        : "bg-background/20 border-border/40 hover:border-border/60 text-muted-foreground hover:text-foreground"
                    }
                  `}
                >
                  <span className="text-sm font-medium">{STATUS_LABEL[status]}</span>
                  <Badge
                    variant={activeStatus === status ? "secondary" : "outline"}
                    className={cn(
                      "ml-1 bg-background/50",
                      activeStatus === status && STATUS_COLOR[status]
                    )}
                  >
                    {counts[status] ?? 0}
                  </Badge>
                </motion.button>
              ))}
            </div>

            <form
              onSubmit={(e) => { e.preventDefault(); setParam({ q: draftQuery }); }}
              className="flex-1 sm:max-w-[260px]"
            >
              <Input
                value={draftQuery}
                onChange={(e) => setDraftQuery(e.target.value)}
                placeholder="搜索标题 / 网址 / 描述，回车"
                className="bg-background/40 border-border/40"
              />
            </form>

            <Select
              value={activeCategory}
              onValueChange={(v) => setParam({ category: v })}
            >
              <SelectTrigger className="w-full sm:w-[180px] bg-background/40 border-border/40">
                <SelectValue placeholder="选择分类" />
              </SelectTrigger>
              <SelectContent
                align="end"
                className="bg-background/95 backdrop-blur-sm"
              >
                <SelectItem value="all">全部分类</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id.toString()}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Website List */}
        <div className={cn("bg-background/20 transition-opacity", pending && "opacity-50")}>
          <WebsiteList
            key={`${activeStatus}-${activeCategory}-${page}-${query}`}
            websites={websites}
            categories={categories}
            showActions={true}
          />
        </div>

        {/* Pager */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 bg-background/20 px-4 py-3 text-sm">
          <span className="text-muted-foreground">
            {total === 0
              ? "没有匹配的内容"
              : `共 ${total} 条 · 第 ${from}–${from + websites.length - 1} 条 · 第 ${page}/${totalPages} 页`}
          </span>
          <div className="flex items-center gap-2">
            <button
              disabled={page <= 1 || pending}
              onClick={() => setParam({ page: String(page - 1) })}
              className="rounded-md border border-border/60 px-3 py-1.5 disabled:opacity-40"
            >
              上一页
            </button>
            <button
              disabled={page >= totalPages || pending}
              onClick={() => setParam({ page: String(page + 1) })}
              className="rounded-md border border-border/60 px-3 py-1.5 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
