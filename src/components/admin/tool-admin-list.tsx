"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Archive,
  Check,
  ExternalLink,
  Pencil,
  Search,
  Undo2,
} from "lucide-react";
import { Button } from "@/ui/common/button";
import { Badge } from "@/ui/common/badge";
import { Input } from "@/ui/common/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/common/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/common/table";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils/utils";
import type {
  AdminCategoryOption,
  AdminToolListItem,
} from "@/lib/website/tool-admin";

const STATUS_LABELS: Record<string, string> = {
  pending: "待审核",
  approved: "已发布",
  rejected: "已拒绝",
  archived: "已归档",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "text-yellow-500",
  approved: "text-green-500",
  rejected: "text-red-500",
  archived: "text-muted-foreground",
};

export function ToolAdminList({
  initialTools,
  categories,
}: {
  initialTools: AdminToolListItem[];
  categories: AdminCategoryOption[];
}) {
  const { toast } = useToast();
  const [tools, setTools] = useState(initialTools);
  const [activeStatus, setActiveStatus] = useState<string>("pending");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingId, setPendingId] = useState<number | null>(null);

  const statusCounts = useMemo(() => {
    return tools.reduce((counts, tool) => {
      counts[tool.status] = (counts[tool.status] ?? 0) + 1;
      return counts;
    }, {} as Record<string, number>);
  }, [tools]);

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return tools.filter((tool) => {
      const matchesStatus =
        activeStatus === "all" || tool.status === activeStatus;
      const matchesCategory =
        selectedCategory === "all" ||
        tool.categoryId === parseInt(selectedCategory);
      const matchesQuery =
        !query ||
        tool.title.toLowerCase().includes(query) ||
        tool.url.toLowerCase().includes(query) ||
        tool.description.toLowerCase().includes(query);
      return matchesStatus && matchesCategory && matchesQuery;
    });
  }, [tools, activeStatus, selectedCategory, searchQuery]);

  const handleStatusChange = async (
    tool: AdminToolListItem,
    status: string,
    successLabel: string
  ) => {
    setPendingId(tool.id);
    try {
      const response = await fetch(`/api/websites/${tool.id}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.code === 200) {
        setTools((prev) =>
          prev.map((item) =>
            item.id === tool.id ? { ...item, status } : item
          )
        );
        toast({ title: successLabel, description: tool.title });
      } else {
        toast({
          title: "操作失败",
          description: data?.message || "请重试",
          variant: "destructive",
        });
      }
    } catch {
      toast({ title: "操作失败", description: "请重试", variant: "destructive" });
    } finally {
      setPendingId(null);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="container max-w-6xl mx-auto px-4 sm:px-6 py-4 sm:py-6 min-h-[calc(100vh-4rem)] space-y-6"
    >
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-background/30 backdrop-blur-sm p-6 rounded-xl border border-border/40">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-foreground">
            工具管理
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            管理 AI 工具目录：基础信息、详情内容与审核发布
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/tools/rewrite">批量 AI 改写</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/tools/review">批量审核/发布</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/settings/ai-providers">Provider 配置</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin" className="flex items-center gap-2">
              <ArrowLeft className="w-4 h-4" />
              返回后台
            </Link>
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border/40 bg-background/30 shadow-sm overflow-hidden backdrop-blur-sm">
        <div className="border-b border-border/40 bg-background/20 p-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            {["all", "pending", "approved", "rejected", "archived"].map(
              (status) => (
                <button
                  key={status}
                  onClick={() => setActiveStatus(status)}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm transition-all duration-200",
                    activeStatus === status
                      ? "bg-background/40 border-primary/30 shadow-sm " +
                          (STATUS_COLORS[status] ?? "text-foreground")
                      : "bg-background/20 border-border/40 text-muted-foreground hover:text-foreground hover:border-border/60"
                  )}
                >
                  {status === "all" ? "全部" : STATUS_LABELS[status]}
                  <Badge variant="outline" className="px-1.5 py-0 text-[11px]">
                    {status === "all"
                      ? tools.length
                      : statusCounts[status] ?? 0}
                  </Badge>
                </button>
              )
            )}
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索标题 / URL / 描述"
                className="pl-9 bg-background/40 border-border/40"
              />
            </div>
            <Select value={selectedCategory} onValueChange={setSelectedCategory}>
              <SelectTrigger className="w-full sm:w-[240px] bg-background/40 border-border/40">
                <SelectValue placeholder="选择分类" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部分类</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id.toString()}>
                    {category.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="bg-background/20 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>工具</TableHead>
                <TableHead>分类</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>详情</TableHead>
                <TableHead>收录时间</TableHead>
                <TableHead>更新时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-muted-foreground py-10"
                  >
                    暂无符合条件的工具
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((tool) => (
                  <TableRow key={tool.id}>
                    <TableCell className="max-w-[260px]">
                      <div className="font-medium truncate">{tool.title}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {tool.slug || "(无 slug)"}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {tool.parentCategoryName
                        ? `${tool.parentCategoryName} / ${tool.categoryName}`
                        : tool.categoryName}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "text-sm font-medium",
                          STATUS_COLORS[tool.status]
                        )}
                      >
                        {STATUS_LABELS[tool.status] ?? tool.status}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          "px-2 py-0 text-[11px]",
                          tool.hasDetail
                            ? "border-green-500/30 text-green-600 dark:text-green-400"
                            : "text-muted-foreground"
                        )}
                      >
                        {tool.hasDetail ? "有详情" : "无详情"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {tool.listedAt ? tool.listedAt.slice(0, 10) : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {tool.updatedAt.slice(0, 10)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" asChild title="编辑">
                          <Link href={`/admin/tools/${tool.id}/edit`}>
                            <Pencil className="w-4 h-4" />
                          </Link>
                        </Button>
                        {tool.status === "approved" && tool.slug ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            asChild
                            title="View public page"
                          >
                            <a
                              href={`/tools/${tool.slug}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <ExternalLink className="w-4 h-4" />
                            </a>
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled
                            title="发布后可查看公开页"
                          >
                            <ExternalLink className="w-4 h-4 opacity-30" />
                          </Button>
                        )}
                        {tool.status !== "approved" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pendingId === tool.id}
                            onClick={() =>
                              handleStatusChange(tool, "approved", "已发布")
                            }
                            title="发布"
                          >
                            <Check className="w-4 h-4 text-green-500" />
                          </Button>
                        )}
                        {tool.status === "approved" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pendingId === tool.id}
                            onClick={() =>
                              handleStatusChange(tool, "pending", "已退回待审核")
                            }
                            title="退回待审核"
                          >
                            <Undo2 className="w-4 h-4 text-yellow-500" />
                          </Button>
                        )}
                        {tool.status !== "archived" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pendingId === tool.id}
                            onClick={() =>
                              handleStatusChange(tool, "archived", "已归档")
                            }
                            title="归档"
                          >
                            <Archive className="w-4 h-4 text-red-500" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </motion.div>
  );
}
