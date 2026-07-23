"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, Plus, Sparkles } from "lucide-react";
import { Button } from "@/ui/common/button";
import { Badge } from "@/ui/common/badge";
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
import { cn } from "@/lib/utils/utils";
import type { AdminCategoryOption } from "@/lib/website/tool-admin";
import type { RewriteBatchSummary } from "@/lib/website/tool-rewrite-batch";

const BATCH_STATUS_COLORS: Record<string, string> = {
  created: "text-muted-foreground",
  jsonl_generated: "text-blue-500",
  submitted: "text-yellow-500",
  in_progress: "text-yellow-500",
  completed: "text-green-500",
  imported: "text-green-600",
  failed: "text-red-500",
};

export function RewriteBatchList({
  initialBatches,
  categories,
}: {
  initialBatches: RewriteBatchSummary[];
  categories: AdminCategoryOption[];
}) {
  const [provider, setProvider] = useState("all");
  const [model, setModel] = useState("all");
  const [status, setStatus] = useState("all");
  const [categoryId, setCategoryId] = useState("all");

  const providers = useMemo(
    () => [...new Set(initialBatches.map((b) => b.provider))],
    [initialBatches]
  );
  const models = useMemo(
    () => [...new Set(initialBatches.map((b) => b.model))],
    [initialBatches]
  );
  const statuses = useMemo(
    () => [...new Set(initialBatches.map((b) => b.status))],
    [initialBatches]
  );

  const filtered = initialBatches.filter((b) => {
    return (
      (provider === "all" || b.provider === provider) &&
      (model === "all" || b.model === model) &&
      (status === "all" || b.status === status) &&
      (categoryId === "all" || String(b.categoryId ?? "") === categoryId)
    );
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="container max-w-6xl mx-auto px-4 sm:px-6 py-4 sm:py-6 min-h-[calc(100vh-4rem)] space-y-6"
    >
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-background/30 backdrop-blur-sm p-6 rounded-xl border border-border/40">
        <div>
          <h1 className="flex items-center gap-2 text-2xl sm:text-3xl font-semibold text-foreground">
            <Sparkles className="w-6 h-6 text-primary" />
            批量 AI 改写任务
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            多 provider 可配置 · 结果只写入草稿，须人工审核后才能发布
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" asChild className="gap-2">
            <Link href="/admin/tools/rewrite/new">
              <Plus className="w-4 h-4" />
              创建 AI 改写任务
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/tools" className="flex items-center gap-2">
              <ArrowLeft className="w-4 h-4" />
              返回工具管理
            </Link>
          </Button>
        </div>
      </div>

      {/* 筛选 */}
      <div className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <FilterSelect label="Provider" value={provider} onChange={setProvider} options={providers} />
          <FilterSelect label="Model" value={model} onChange={setModel} options={models} />
          <FilterSelect label="状态" value={status} onChange={setStatus} options={statuses} />
          <div>
            <label className="block text-xs font-medium mb-1 text-muted-foreground">分类</label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger className="bg-background/40 border-border/40">
                <SelectValue placeholder="全部分类" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部分类</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id.toString()}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* 列表 */}
      <div className="rounded-xl border border-border/40 bg-background/30 shadow-sm overflow-hidden backdrop-blur-sm">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>Provider / Model</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>总数</TableHead>
                <TableHead>完成/失败</TableHead>
                <TableHead>QC 通过/失败</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-10">
                    暂无符合条件的批次
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>{b.id}</TableCell>
                    <TableCell className="max-w-[160px] truncate">{b.name || "—"}</TableCell>
                    <TableCell className="text-sm">
                      {b.provider} / {b.model}
                      {b.modelType ? (
                        <Badge variant="outline" className="ml-1 text-[10px]">
                          {b.modelType}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <span className={cn("text-sm font-medium", BATCH_STATUS_COLORS[b.status] ?? "")}>
                        {b.status}
                      </span>
                    </TableCell>
                    <TableCell>{b.totalCount}</TableCell>
                    <TableCell>
                      {b.completedCount} / {b.failedCount}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="px-2 py-0 text-[11px]">
                        {b.qcPassedCount} / {b.qcFailedCount}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {b.createdAt.slice(0, 16).replace("T", " ")}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/admin/tools/rewrite/${b.id}`}>详情</Link>
                      </Button>
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

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1 text-muted-foreground">{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="bg-background/40 border-border/40">
          <SelectValue placeholder={`全部`} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
