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
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils/utils";
import type { RewriteBatchDetail } from "@/lib/website/tool-rewrite-batch";

const ITEM_STATUS_COLORS: Record<string, string> = {
  queued: "text-muted-foreground",
  submitted: "text-yellow-500",
  completed: "text-blue-500",
  saved: "text-green-600",
  qc_failed: "text-orange-500",
  failed: "text-red-500",
};

export function RewriteBatchDetailView({
  initialBatch,
  providerHasKey,
  providerKeyEnv,
}: {
  initialBatch: RewriteBatchDetail;
  providerHasKey: boolean;
  providerKeyEnv: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [batch] = useState(initialBatch);
  const [busy, setBusy] = useState<string | null>(null);
  const [jsonlPreview, setJsonlPreview] = useState<string[]>([]);
  const [jsonlLineCount, setJsonlLineCount] = useState<number | null>(null);

  const statusCounts = batch.items.reduce((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {} as Record<string, number>);

  const callAction = async (
    action: string,
    endpoint: string,
    onSuccess: (data: { code: number; data: unknown; message?: string }) => void
  ) => {
    if (busy) return;
    setBusy(action);
    try {
      const response = await fetch(
        `/api/admin/tools/rewrite/${batch.id}/${endpoint}`,
        { method: "POST" }
      );
      const data = await response.json().catch(() => null);
      if (response.ok && data?.code === 200) {
        onSuccess(data);
      } else {
        toast({
          title: `${action} 失败`,
          description: data?.message || "请重试",
          variant: "destructive",
        });
      }
    } catch {
      toast({ title: `${action} 失败`, description: "请重试", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleGenerateJsonl = () =>
    callAction("Generate JSONL", "generate-jsonl", (data) => {
      const payload = data.data as { lineCount: number; preview: string[] };
      setJsonlPreview(payload.preview);
      setJsonlLineCount(payload.lineCount);
      toast({ title: "JSONL 已生成", description: `${payload.lineCount} 行` });
    });

  const handleSubmit = () =>
    callAction("Submit", "submit", (data) => {
      const payload = data.data as
        | { mode: "batch"; openaiBatchId: string }
        | { mode: "direct"; saved: number; qcFailed: number; failed: number };
      if (payload.mode === "batch") {
        toast({ title: "已提交到 OpenAI", description: payload.openaiBatchId });
      } else {
        toast({
          title: "直连改写完成",
          description: `saved: ${payload.saved}, qc_failed: ${payload.qcFailed}, failed: ${payload.failed}`,
        });
      }
      router.refresh();
      setTimeout(() => window.location.reload(), 800);
    });

  const handleRefresh = () =>
    callAction("Refresh", "refresh", (data) => {
      const payload = data.data as { status: string };
      toast({ title: "状态已刷新", description: `OpenAI 状态: ${payload.status}` });
      router.refresh();
      setTimeout(() => window.location.reload(), 800);
    });

  const handleImport = () =>
    callAction("Import results", "import-results", (data) => {
      const payload = data.data as {
        saved: number;
        qcFailed: number;
        failed: number;
      };
      toast({
        title: "结果已导入",
        description: `saved: ${payload.saved}, qc_failed: ${payload.qcFailed}, failed: ${payload.failed}`,
      });
      router.refresh();
      setTimeout(() => window.location.reload(), 800);
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
          <div className="flex items-center gap-3">
            <h1 className="text-2xl sm:text-3xl font-semibold text-foreground">
              改写批次 #{batch.id}
            </h1>
            <Badge variant="outline" className="px-2 py-0.5">
              {batch.status}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {batch.name || "未命名"} · {batch.provider} · {batch.model}
            {batch.openaiBatchId ? ` · ${batch.openaiBatchId}` : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/tools/rewrite" className="flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            返回批次列表
          </Link>
        </Button>
      </div>

      {!providerHasKey && (
        <div className="flex items-center gap-3 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-700 dark:text-yellow-300">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          Missing {providerKeyEnv} — 提交将不可用；生成/预览 JSONL 可正常使用。
        </div>
      )}

      <div className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-6 space-y-4">
        <div className="flex flex-wrap gap-2">
          {["queued", "submitted", "completed", "saved", "qc_failed", "failed"].map(
            (status) => (
              <Badge
                key={status}
                variant="outline"
                className={cn("px-2.5 py-1", ITEM_STATUS_COLORS[status])}
              >
                {status}: {statusCounts[status] ?? 0}
              </Badge>
            )
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={handleGenerateJsonl}
            className="gap-2"
          >
            <FileJson className="w-4 h-4" />
            Generate JSONL
          </Button>
          <Button
            size="sm"
            disabled={
              busy !== null ||
              Boolean(batch.openaiBatchId) ||
              batch.status === "imported"
            }
            title={
              batch.openaiBatchId
                ? "已提交过"
                : batch.status === "imported"
                ? "批次已完成"
                : undefined
            }
            onClick={handleSubmit}
            className="gap-2"
          >
            <Send className="w-4 h-4" />
            {batch.providerMode === "batch"
              ? "Submit to OpenAI"
              : `Run rewrite now (${batch.provider})`}
          </Button>
          {batch.providerMode === "batch" && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null || !batch.openaiBatchId}
                onClick={handleRefresh}
                className="gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                Refresh status
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null || !batch.openaiBatchId}
                onClick={handleImport}
                className="gap-2"
              >
                <Download className="w-4 h-4" />
                Import results
              </Button>
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          导入结果只写入 ai_rewrite_draft（rewrite_status=draft_generated），不会自动
          human_reviewed / approved。失败项重试：TODO（V1 暂不支持，重新创建批次即可）。
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

      <div className="rounded-xl border border-border/40 bg-background/30 shadow-sm overflow-hidden backdrop-blur-sm">
        <div className="border-b border-border/40 bg-background/20 p-4">
          <h2 className="text-lg font-semibold text-foreground">
            条目（{batch.items.length}）
          </h2>
        </div>
        <div className="bg-background/20 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>工具</TableHead>
                <TableHead>custom_id</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>QC</TableHead>
                <TableHead>错误</TableHead>
                <TableHead className="text-right">编辑</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batch.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="max-w-[200px] truncate font-medium">
                    {item.websiteTitle}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {item.customId}
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "text-sm font-medium",
                        ITEM_STATUS_COLORS[item.status]
                      )}
                    >
                      {item.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {item.qcStatus ?? "—"}
                  </TableCell>
                  <TableCell className="max-w-[280px]">
                    {item.qcErrors.length > 0 ? (
                      <span className="text-xs text-orange-500">
                        {item.qcErrors.join("; ").slice(0, 120)}
                      </span>
                    ) : item.errorMessage ? (
                      <span className="text-xs text-red-500">
                        {item.errorMessage.slice(0, 120)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/admin/tools/${item.websiteId}/edit`}>
                        编辑
                      </Link>
                    </Button>
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
