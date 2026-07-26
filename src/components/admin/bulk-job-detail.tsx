"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
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
import type { BulkJobView } from "@/lib/website/bulk-job";
import { JOB_STATUS_COLORS, JOB_TYPE_LABELS } from "@/components/admin/bulk-job-list";

const ITEM_STATUS_COLORS: Record<string, string> = {
  queued: "text-muted-foreground",
  running: "text-blue-500",
  success: "text-green-600",
  skipped: "text-yellow-600",
  failed: "text-red-500",
};

const TERMINAL = ["completed", "completed_with_errors", "failed", "canceled"];
// 暂停：服务端 worker 不再自动推进，需人工确认后继续
const PAUSED = "paused";

export function BulkJobDetail({ initialJob }: { initialJob: BulkJobView }) {
  const [job, setJob] = useState(initialJob);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const drivingRef = useRef(false);

  const runChunk = async (): Promise<boolean> => {
    const data = await fetch(`/api/admin/jobs/${job.id}/run-next`, {
      method: "POST",
    }).then((r) => r.json());
    if (data?.code === 200) {
      setJob(data.data.job);
      setDriveError(null);
      return true;
    }
    setDriveError(data?.message || "执行分块失败，将自动重试");
    return false;
  };

  // 服务端 worker 已经在后台推进任务（关页面也继续）。页面这里的循环是
  // 「进度轮询 + worker 未启用时的兜底」：任务级租约保证同一时刻只有一个驱动者
  // 真正干活，抢不到租约的一方拿到的是当前进度快照，不会重复执行、也不会
  // 额外增加 provider 并发。暂停（熔断）状态不自动推进，必须人工点「继续执行」。
  useEffect(() => {
    if (TERMINAL.includes(job.status) || job.status === PAUSED) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled || drivingRef.current) return;
      drivingRef.current = true;
      try {
        await runChunk();
      } catch {
        if (!cancelled) setDriveError("网络异常，将自动重试");
      } finally {
        drivingRef.current = false;
      }
    };

    tick();
    const timer = setInterval(tick, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id, job.status]);

  const handleResume = async () => {
    if (resuming) return;
    setResuming(true);
    try {
      await runChunk();
    } catch {
      setDriveError("网络异常，请重试");
    } finally {
      setResuming(false);
    }
  };

  const percent = job.totalCount
    ? Math.round((job.processedCount / job.totalCount) * 100)
    : 0;
  const done = TERMINAL.includes(job.status);
  const paused = job.status === PAUSED;
  const result = (job.result ?? null) as Record<string, number> | null;
  const mediaStats = job.type === "publish" ? result : null;
  const rewriteStats = job.type === "rewrite_direct" ? result : null;
  const jobError = (job.error ?? null) as { message?: string } | null;
  const failures = job.items.filter((item) => item.status === "failed" || item.status === "skipped");

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="container max-w-5xl mx-auto px-4 sm:px-6 py-4 sm:py-6 min-h-[calc(100vh-4rem)] space-y-6"
    >
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-background/30 backdrop-blur-sm p-6 rounded-xl border border-border/40">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl sm:text-3xl font-semibold text-foreground">
              任务 #{job.id} · {JOB_TYPE_LABELS[job.type] ?? job.type}
            </h1>
            <Badge variant="outline" className={cn("px-2 py-0.5", JOB_STATUS_COLORS[job.status])}>
              {job.status}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            创建 {job.createdAt.slice(0, 16).replace("T", " ")}
            {job.finishedAt ? ` · 完成 ${job.finishedAt.slice(0, 16).replace("T", " ")}` : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/jobs" className="flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            返回任务列表
          </Link>
        </Button>
      </div>

      {/* 进度 */}
      <div className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-6 space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span>
            进度 {job.processedCount}/{job.totalCount}（{percent}%）
          </span>
          <span>
            <span className="text-green-600">成功 {job.successCount}</span>
            {" · "}
            <span className="text-yellow-600">跳过 {job.skippedCount}</span>
            {" · "}
            <span className="text-red-500">失败 {job.failedCount}</span>
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-border/40">
          <div
            className={cn(
              "h-full transition-all",
              job.status === "completed"
                ? "bg-green-500"
                : job.failedCount + job.skippedCount > 0
                ? "bg-orange-500"
                : "bg-primary"
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
        {!done && !paused && (
          <p className="text-xs text-muted-foreground">
            正在分块执行，服务端后台会自动推进 —— <strong>关闭本页任务也会继续跑</strong>，
            回来打开即可看到最新进度。
            {driveError ? ` ${driveError}` : ""}
          </p>
        )}
        {mediaStats && (
          <p className="text-xs text-muted-foreground">
            媒体：本地化 {mediaStats.mediaLocalized ?? 0} 张 · 此前已缓存{" "}
            {mediaStats.mediaAlreadyCached ?? 0} 张 · 失败 {mediaStats.mediaFailed ?? 0} 张
          </p>
        )}
        {rewriteStats && (
          <p className="text-xs text-muted-foreground">
            改写批次：QC 通过 {rewriteStats.saved ?? 0} 条 · QC 失败{" "}
            {rewriteStats.qcFailed ?? 0} 条 · 失败 {rewriteStats.failed ?? 0} 条（结果只写
            AI 草稿，不会自动发布）
          </p>
        )}
        {jobError?.message && !paused && (
          <p className="text-xs text-red-500">任务中断：{jobError.message}</p>
        )}
      </div>

      {/* 熔断暂停：需人工确认后继续 */}
      {paused && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-yellow-500/40 bg-yellow-500/10 p-4 text-sm">
          <span className="text-yellow-700 dark:text-yellow-300">
            任务已自动暂停：{jobError?.message ?? "连续失败"}
          </span>
          <Button size="sm" onClick={handleResume} disabled={resuming}>
            {resuming ? "继续中..." : "继续执行"}
          </Button>
        </div>
      )}

      {/* 完成后下一步 */}
      {done && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/40 bg-background/20 p-4 text-sm">
          <span className="text-muted-foreground">下一步：</span>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/tools/review">返回审核工作台</Link>
          </Button>
          {job.type === "publish" && (
            <Button variant="outline" size="sm" asChild>
              <Link href="/admin/tools/review?tab=published">查看已发布</Link>
            </Button>
          )}
          {job.type === "apply_and_review" && (
            <Button variant="outline" size="sm" asChild>
              <Link href="/admin/tools/review?tab=publish">查看待发布</Link>
            </Button>
          )}
          {job.relatedRewriteBatchId && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/admin/tools/rewrite/${job.relatedRewriteBatchId}`}>查看改写批次</Link>
            </Button>
          )}
          {job.type === "rewrite_direct" && job.relatedRewriteBatchId && (
            <Button variant="outline" size="sm" asChild>
              <Link
                href={`/admin/tools/review?rewriteBatchId=${job.relatedRewriteBatchId}&qcStatus=passed`}
              >
                去审核本批草稿
              </Link>
            </Button>
          )}
          {job.relatedImportBatchId && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/admin/tools/import/${job.relatedImportBatchId}`}>查看导入批次</Link>
            </Button>
          )}
        </div>
      )}

      {/* 失败/跳过原因 */}
      {failures.length > 0 && (
        <div className="rounded-xl border border-orange-500/30 bg-orange-500/5 p-4 space-y-2">
          <p className="text-sm font-medium">跳过 / 失败原因（{failures.length}）</p>
          {failures.map((item) => (
            <p key={item.id} className="text-xs text-muted-foreground">
              <span className={ITEM_STATUS_COLORS[item.status]}>[{item.status}]</span>{" "}
              #{item.websiteId} {item.websiteTitle ?? ""} — {item.error ?? "无原因"}
            </p>
          ))}
        </div>
      )}

      {/* 条目表 */}
      <div className="rounded-xl border border-border/40 bg-background/30 shadow-sm overflow-hidden backdrop-blur-sm">
        <div className="bg-background/20 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>工具</TableHead>
                <TableHead>slug</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>错误 / 原因</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {job.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="max-w-[220px] truncate font-medium">
                    {item.websiteTitle ?? `#${item.websiteId ?? "-"}`}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {item.websiteSlug ?? "—"}
                  </TableCell>
                  <TableCell>
                    <span className={cn("text-sm font-medium", ITEM_STATUS_COLORS[item.status])}>
                      {item.status}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-[320px]">
                    {item.error ? (
                      <span className="text-xs text-orange-500">{item.error.slice(0, 140)}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </motion.div>
  );
}
