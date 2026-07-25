"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  FileJson,
  RefreshCw,
  Send,
} from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/common/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils/utils";
import type {
  RewriteBatchDetail,
  RewriteItemSummary,
} from "@/lib/website/tool-rewrite-batch";

const ITEM_STATUS_COLORS: Record<string, string> = {
  queued: "text-muted-foreground",
  submitted: "text-yellow-500",
  completed: "text-blue-500",
  saved: "text-green-600",
  qc_failed: "text-orange-500",
  failed: "text-red-500",
};

// 失败项分类（供 batch detail 展示）
type FailClass =
  | "API failed"
  | "Parse failed"
  | "QC failed"
  | "Skipped human_reviewed"
  | "Skipped approved"
  | "Missing raw content"
  | "Unknown";

function classifyFailure(item: RewriteItemSummary): FailClass | null {
  if (item.status === "qc_failed") return "QC failed";
  if (item.status !== "failed") return null;
  const msg = (item.errorMessage ?? "").toLowerCase();
  if (msg.includes("human_reviewed")) return "Skipped human_reviewed";
  if (msg.includes("approved")) return "Skipped approved";
  if (msg.includes("无法从响应") || msg.includes("parse") || msg.includes("json"))
    return "Parse failed";
  if (msg.includes("raw")) return "Missing raw content";
  if (msg.includes("http") || msg.includes("api") || msg.includes("请求"))
    return "API failed";
  return "Unknown";
}

const FAIL_CLASSES: FailClass[] = [
  "API failed",
  "Parse failed",
  "QC failed",
  "Skipped human_reviewed",
  "Skipped approved",
  "Missing raw content",
  "Unknown",
];

type ExecAction = {
  key: string;
  title: string;
  endpoint: string;
  run: (data: { code: number; data: unknown; message?: string }) => void;
};

export function RewriteBatchDetailView({
  initialBatch,
  providerHasKey,
  providerKeyEnv,
  rewriteJob = null,
}: {
  initialBatch: RewriteBatchDetail;
  providerHasKey: boolean;
  providerKeyEnv: string;
  rewriteJob?: { id: number; status: string } | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [batch] = useState(initialBatch);
  const [busy, setBusy] = useState<string | null>(null);
  const [jsonlPreview, setJsonlPreview] = useState<string[]>([]);
  const [jsonlLineCount, setJsonlLineCount] = useState<number | null>(null);
  const [pendingAction, setPendingAction] = useState<ExecAction | null>(null);

  const statusCounts = batch.items.reduce((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {} as Record<string, number>);

  const failures = batch.items
    .map((item) => ({ item, cls: classifyFailure(item) }))
    .filter((x): x is { item: RewriteItemSummary; cls: FailClass } => x.cls !== null);

  const runAction = async (action: ExecAction) => {
    if (busy) return;
    setBusy(action.key);
    try {
      const response = await fetch(
        `/api/admin/tools/rewrite/${batch.id}/${action.endpoint}`,
        { method: "POST" }
      );
      const data = await response.json().catch(() => null);
      if (response.ok && data?.code === 200) {
        action.run(data);
      } else {
        toast({ title: `${action.title} 失败`, description: data?.message || "请重试", variant: "destructive" });
      }
    } catch {
      toast({ title: `${action.title} 失败`, description: "请重试", variant: "destructive" });
    } finally {
      setBusy(null);
      setPendingAction(null);
    }
  };

  const generateJsonl: ExecAction = {
    key: "jsonl",
    title: "Generate JSONL",
    endpoint: "generate-jsonl",
    run: (data) => {
      const p = data.data as { lineCount: number; preview: string[] };
      setJsonlPreview(p.preview);
      setJsonlLineCount(p.lineCount);
      toast({ title: "JSONL 已生成", description: `${p.lineCount} 行` });
    },
  };
  const submitToOpenAI: ExecAction = {
    key: "submit",
    title: "Submit to OpenAI",
    endpoint: "submit",
    run: (data) => {
      const p = data.data as { mode: "batch"; openaiBatchId: string };
      toast({ title: "已提交到 OpenAI", description: p.openaiBatchId });
      router.refresh();
      setTimeout(() => window.location.reload(), 800);
    },
  };
  // 直连 provider：不在本请求内跑 AI，改为创建后台任务并跳转进度页
  const submitDirectJob: ExecAction = {
    key: "submit",
    title: "Run rewrite now",
    endpoint: "submit-job",
    run: (data) => {
      const p = data.data as { jobId: number; total: number; jobUrl: string };
      toast({
        title: "改写任务已创建",
        description: `任务 #${p.jobId}：${p.total} 条排队中，正在进度页逐条执行`,
      });
      router.push(p.jobUrl);
    },
  };
  const submit = batch.providerMode === "batch" ? submitToOpenAI : submitDirectJob;
  const refresh: ExecAction = {
    key: "refresh",
    title: "Refresh status",
    endpoint: "refresh",
    run: (data) => {
      const p = data.data as { status: string };
      toast({ title: "状态已刷新", description: `OpenAI 状态: ${p.status}` });
      router.refresh();
      setTimeout(() => window.location.reload(), 800);
    },
  };
  const importResults: ExecAction = {
    key: "import",
    title: "Import results",
    endpoint: "import-results",
    run: (data) => {
      const p = data.data as { saved: number; qcFailed: number; failed: number };
      toast({ title: "结果已导入", description: `saved: ${p.saved}, qc_failed: ${p.qcFailed}, failed: ${p.failed}` });
      router.refresh();
      setTimeout(() => window.location.reload(), 800);
    },
  };
  // 为失败条目新建重试批次（服务端重新校验资格；只创建不运行 AI），成功后跳新批次
  const retryFailed: ExecAction = {
    key: "retry",
    title: "Retry Failed（新建批次）",
    endpoint: "retry",
    run: (data) => {
      const p = data.data as { batchId: number; total: number; skipped: number };
      toast({
        title: "重试批次已创建",
        description: `新批次 #${p.batchId}：${p.total} 条待运行${p.skipped ? `，跳过 ${p.skipped} 条不合格` : ""}`,
      });
      router.push(`/admin/tools/rewrite/${p.batchId}`);
    },
  };

  const hasQcPassed = batch.qcPassedCount > 0 || statusCounts.saved > 0;
  // paused（熔断暂停）也算未结束：批次仍在这个任务手里，不允许再建新任务
  const jobRunning = Boolean(
    rewriteJob && ["queued", "running", "paused"].includes(rewriteJob.status)
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="container max-w-6xl mx-auto px-4 sm:px-6 py-4 sm:py-6 min-h-[calc(100vh-4rem)] space-y-6"
    >
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-background/30 backdrop-blur-sm p-6 rounded-xl border border-border/40">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl sm:text-3xl font-semibold text-foreground">改写批次 #{batch.id}</h1>
            <Badge variant="outline" className="px-2 py-0.5">{batch.status}</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {batch.name || "未命名"} · {batch.provider} · {batch.model}
            {batch.modelType ? ` · ${batch.modelType}` : ""}
            {batch.openaiBatchId ? ` · ${batch.openaiBatchId}` : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/tools/rewrite" className="flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            返回改写任务列表
          </Link>
        </Button>
      </div>

      {/* 概览 */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <Stat label="总数" value={batch.totalCount} />
        <Stat label="已提交" value={batch.submittedCount} />
        <Stat label="完成" value={batch.completedCount} />
        <Stat label="失败" value={batch.failedCount} />
        <Stat label="QC通过" value={batch.qcPassedCount} />
        <Stat label="QC失败" value={batch.qcFailedCount} />
      </div>
      <p className="text-xs text-muted-foreground">
        创建 {batch.createdAt.slice(0, 16).replace("T", " ")}
        {batch.submittedAt ? ` · 提交 ${batch.submittedAt.slice(0, 16).replace("T", " ")}` : ""}
        {batch.completedAt ? ` · 完成 ${batch.completedAt.slice(0, 16).replace("T", " ")}` : ""}
      </p>

      {!providerHasKey && (
        <div className="flex items-center gap-3 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-700 dark:text-yellow-300">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          Missing {providerKeyEnv} — 运行将不可用；生成/预览 JSONL 可正常使用。
        </div>
      )}

      {/* 后台改写任务入口（直连 provider 异步执行） */}
      {rewriteJob && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
          <span className="text-muted-foreground">
            本批次{jobRunning ? "有未结束的" : "最近一次"}后台改写任务 #{rewriteJob.id}
            （{rewriteJob.status}）
            {rewriteJob.status === "paused"
              ? "，已自动暂停，需在任务页确认后继续。"
              : jobRunning
              ? "，服务端会自动推进，无需守着页面。"
              : ""}
          </span>
          <Button variant={jobRunning ? "default" : "outline"} size="sm" asChild>
            <Link href={`/admin/jobs/${rewriteJob.id}`}>查看任务进度</Link>
          </Button>
        </div>
      )}

      {/* 执行控制（按 provider 模式，所有按钮弹确认） */}
      <div className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-6 space-y-4">
        <div className="flex flex-wrap gap-2">
          {["queued", "submitted", "completed", "saved", "qc_failed", "failed"].map((s) => (
            <Badge key={s} variant="outline" className={cn("px-2.5 py-1", ITEM_STATUS_COLORS[s])}>
              {s}: {statusCounts[s] ?? 0}
            </Badge>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setPendingAction(generateJsonl)} className="gap-2">
            <FileJson className="w-4 h-4" />
            Generate JSONL
          </Button>
          <Button
            size="sm"
            disabled={
              busy !== null ||
              Boolean(batch.openaiBatchId) ||
              batch.status === "imported" ||
              jobRunning
            }
            title={
              batch.openaiBatchId
                ? "已提交过"
                : batch.status === "imported"
                ? "批次已完成"
                : jobRunning
                ? `已有进行中的任务 #${rewriteJob?.id}`
                : undefined
            }
            onClick={() => setPendingAction(submit)}
            className="gap-2"
          >
            <Send className="w-4 h-4" />
            {batch.providerMode === "batch" ? "Submit to OpenAI" : `Run now (${batch.provider})`}
          </Button>
          {batch.providerMode === "batch" && (
            <>
              <Button variant="outline" size="sm" disabled={busy !== null || !batch.openaiBatchId} onClick={() => setPendingAction(refresh)} className="gap-2">
                <RefreshCw className="w-4 h-4" />
                Refresh status
              </Button>
              <Button variant="outline" size="sm" disabled={busy !== null || !batch.openaiBatchId} onClick={() => setPendingAction(importResults)} className="gap-2">
                <Download className="w-4 h-4" />
                Import results
              </Button>
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={
              busy !== null ||
              (statusCounts.failed ?? 0) + (statusCounts.qc_failed ?? 0) === 0
            }
            title={
              (statusCounts.failed ?? 0) + (statusCounts.qc_failed ?? 0) === 0
                ? "没有可重试的失败条目"
                : "为失败条目新建重试批次（不运行 AI）"
            }
            onClick={() => setPendingAction(retryFailed)}
            className="gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Retry Failed
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          结果只写入 ai_rewrite_draft（rewrite_status=draft_generated），不会自动 human_reviewed / approved。
        </p>
        {jsonlLineCount !== null && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground/80">
              JSONL 预览（共 {jsonlLineCount} 行，显示前 {jsonlPreview.length} 行）
            </p>
            <pre className="max-h-64 overflow-auto rounded-md border border-border/40 bg-background/40 p-3 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
              {jsonlPreview.join("\n\n")}
            </pre>
          </div>
        )}
      </div>

      {/* 成功下一步 CTA */}
      {hasQcPassed && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-green-500/30 bg-green-500/10 p-4 text-sm">
          <span className="text-green-700 dark:text-green-300">
            已有 {batch.qcPassedCount} 条 QC 通过草稿，可进入审核。
          </span>
          <Button size="sm" asChild>
            <Link href={`/admin/tools/review?rewriteBatchId=${batch.id}&qcStatus=passed`}>
              去审核列表
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/tools/rewrite">返回改写任务列表</Link>
          </Button>
        </div>
      )}

      {/* 失败项分类 */}
      {failures.length > 0 && (
        <div className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-6 space-y-3">
          <h2 className="text-lg font-semibold text-foreground">失败项分类（{failures.length}）</h2>
          {FAIL_CLASSES.map((cls) => {
            const rows = failures.filter((f) => f.cls === cls);
            if (!rows.length) return null;
            return (
              <details key={cls} className="rounded-md border border-border/40 bg-background/20 p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  {cls} · {rows.length}
                </summary>
                <div className="mt-2 space-y-2">
                  {rows.map(({ item }) => (
                    <div key={item.id} className="rounded border border-border/40 bg-background/30 p-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium truncate">
                          {item.websiteTitle}{" "}
                          <span className="text-muted-foreground">({item.websiteSlug ?? "no-slug"})</span>
                        </span>
                        <Link href={`/admin/tools/${item.websiteId}/edit`} className="text-primary hover:underline shrink-0">
                          查看工具
                        </Link>
                      </div>
                      <p className="mt-1 text-muted-foreground">
                        status={item.status} · qc={item.qcStatus ?? "—"}
                      </p>
                      {item.qcErrors.length > 0 && (
                        <p className="text-orange-500">QC: {item.qcErrors.join("; ")}</p>
                      )}
                      {item.errorMessage && <p className="text-red-500">{item.errorMessage}</p>}
                    </div>
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      )}

      {/* 全部条目 */}
      <div className="rounded-xl border border-border/40 bg-background/30 shadow-sm overflow-hidden backdrop-blur-sm">
        <div className="border-b border-border/40 bg-background/20 p-4">
          <h2 className="text-lg font-semibold text-foreground">条目（{batch.items.length}）</h2>
        </div>
        <div className="bg-background/20 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>工具</TableHead>
                <TableHead>slug</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>QC</TableHead>
                <TableHead>错误</TableHead>
                <TableHead className="text-right">编辑</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batch.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="max-w-[200px] truncate font-medium">{item.websiteTitle}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{item.websiteSlug ?? "—"}</TableCell>
                  <TableCell>
                    <span className={cn("text-sm font-medium", ITEM_STATUS_COLORS[item.status])}>{item.status}</span>
                  </TableCell>
                  <TableCell className="text-sm">{item.qcStatus ?? "—"}</TableCell>
                  <TableCell className="max-w-[280px]">
                    {item.qcErrors.length > 0 ? (
                      <span className="text-xs text-orange-500">{item.qcErrors.join("; ").slice(0, 120)}</span>
                    ) : item.errorMessage ? (
                      <span className="text-xs text-red-500">{item.errorMessage.slice(0, 120)}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/admin/tools/${item.websiteId}/edit`}>编辑</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* 执行确认弹窗（无确认词） */}
      <Dialog open={pendingAction !== null} onOpenChange={(o) => !o && setPendingAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pendingAction?.title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {pendingAction?.key === "retry" ? (
              <p>
                将为本批次的 <strong>{(statusCounts.failed ?? 0) + (statusCounts.qc_failed ?? 0)}</strong>{" "}
                条失败工具<strong>新建重试批次</strong>（只创建，不自动运行 AI；服务端会跳过已审核/已发布/已有草稿的工具）。
              </p>
            ) : pendingAction?.key === "submit" && batch.providerMode === "direct" ? (
              <p>
                将为本批次待处理条目创建<strong>后台改写任务</strong>并跳转进度页，
                逐条调用 AI（每次 1 条）。服务端会自动推进，<strong>关闭页面也会继续跑</strong>；
                连续失败会自动暂停，避免无人看管时白烧额度。
              </p>
            ) : (
              <p>将对本批次的 <strong>{batch.totalCount}</strong> 条工具执行「{pendingAction?.title}」。</p>
            )}
            <p className="text-muted-foreground">
              Provider: {batch.provider} · Model: {batch.model}
            </p>
            <p className="text-xs text-muted-foreground">
              可能产生 API 成本；结果只保存为 AI 草稿，<strong>不会自动发布</strong>。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingAction(null)}>取消</Button>
            <Button onClick={() => pendingAction && runAction(pendingAction)} disabled={busy !== null}>
              {busy ? "执行中..." : "确认运行"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/20 p-3 text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
    </div>
  );
}
