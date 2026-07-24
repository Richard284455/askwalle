"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "@/ui/common/button";
import { Badge } from "@/ui/common/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/common/table";
import { cn } from "@/lib/utils/utils";
import type { BulkJobSummary } from "@/lib/website/bulk-job";

export const JOB_TYPE_LABELS: Record<string, string> = {
  apply_and_review: "Apply & Mark Reviewed",
  publish: "批量发布",
  import_excel: "Excel 导入",
  rewrite_direct: "AI 改写",
  apply_drafts: "应用草稿",
  mark_reviewed: "标记审核",
  media_cache: "媒体缓存",
};

export const JOB_STATUS_COLORS: Record<string, string> = {
  queued: "text-muted-foreground",
  running: "text-blue-500",
  completed: "text-green-600",
  completed_with_errors: "text-orange-500",
  failed: "text-red-500",
  canceled: "text-muted-foreground",
};

export function BulkJobList({ initialJobs }: { initialJobs: BulkJobSummary[] }) {
  const [jobs, setJobs] = useState(initialJobs);
  const [loading, setLoading] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const data = await fetch("/api/admin/jobs").then((r) => r.json());
      if (data?.code === 200) setJobs(data.data);
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="container max-w-5xl mx-auto px-4 sm:px-6 py-4 sm:py-6 min-h-[calc(100vh-4rem)] space-y-6"
    >
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-background/30 backdrop-blur-sm p-6 rounded-xl border border-border/40">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-foreground">批量任务中心</h1>
          <p className="text-sm text-muted-foreground mt-1">
            长操作以后台任务分块执行；点击详情查看进度与逐条结果
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={reload} disabled={loading} className="gap-2">
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            刷新
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/tools/review" className="flex items-center gap-2">
              <ArrowLeft className="w-4 h-4" />
              返回审核工作台
            </Link>
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border/40 bg-background/30 shadow-sm overflow-hidden backdrop-blur-sm">
        <div className="bg-background/20 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>进度</TableHead>
                <TableHead>成功/跳过/失败</TableHead>
                <TableHead>创建</TableHead>
                <TableHead>完成</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-10">
                    暂无批量任务
                  </TableCell>
                </TableRow>
              ) : (
                jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>{job.id}</TableCell>
                    <TableCell className="text-sm">{JOB_TYPE_LABELS[job.type] ?? job.type}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("px-2 py-0.5", JOB_STATUS_COLORS[job.status])}>
                        {job.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {job.processedCount}/{job.totalCount}
                    </TableCell>
                    <TableCell className="text-sm">
                      <span className="text-green-600">{job.successCount}</span>
                      {" / "}
                      <span className="text-yellow-600">{job.skippedCount}</span>
                      {" / "}
                      <span className="text-red-500">{job.failedCount}</span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {job.createdAt.slice(0, 16).replace("T", " ")}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {job.finishedAt ? job.finishedAt.slice(0, 16).replace("T", " ") : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/admin/jobs/${job.id}`}>详情</Link>
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
