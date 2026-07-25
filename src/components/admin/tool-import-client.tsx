"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, FileSpreadsheet, Upload, X } from "lucide-react";
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

const MAX_FILES = 20;
const MAX_BYTES = 20 * 1024 * 1024;

type BatchRow = {
  id: number;
  name: string | null;
  fileCount: number;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  startedAt: string;
};

type PreviewResult = {
  previewToken: string;
  overwrite: boolean;
  fileCount: number;
  totalRows: number;
  validRows: number;
  skippedRows: number;
  importableCount: number;
  duplicateCount: number;
  invalidUrlCount: number;
  categorySummary: { label: string; fileCount: number }[];
  files: {
    fileName: string;
    rowCount: number;
    validCount: number;
    importableCount: number;
    skippedCount: number;
    errorCount: number;
    duplicateCount: number;
  }[];
  errors: { row: number; name: string; reason: string }[];
};

export function ToolImportClient({
  initialBatches,
}: {
  initialBatches: BatchRow[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [slowNotice, setSlowNotice] = useState(false);

  // 创建任务只做解析（不逐行导入），正常秒级返回；超时兜底避免界面无限 loading
  const CONFIRM_TIMEOUT_MS = 60_000;

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const picked = Array.from(list);
    const merged = [...files];
    for (const f of picked) {
      if (!f.name.toLowerCase().endsWith(".xlsx")) {
        toast({ title: "已忽略", description: `${f.name} 不是 .xlsx`, variant: "destructive" });
        continue;
      }
      if (f.size > MAX_BYTES) {
        toast({ title: "已忽略", description: `${f.name} 超过 20MB`, variant: "destructive" });
        continue;
      }
      if (!merged.some((m) => m.name === f.name && m.size === f.size)) merged.push(f);
    }
    if (merged.length > MAX_FILES) {
      toast({ title: "文件过多", description: `单次最多 ${MAX_FILES} 个`, variant: "destructive" });
      setFiles(merged.slice(0, MAX_FILES));
    } else {
      setFiles(merged);
    }
    setPreview(null);
    setImportError(null);
    setSlowNotice(false);
  };

  const handlePreview = async () => {
    if (!files.length || previewing) return;
    setPreviewing(true);
    setImportError(null);
    setSlowNotice(false);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      fd.append("overwrite", String(overwrite));
      const res = await fetch("/api/admin/tools/import/preview", { method: "POST", body: fd });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.code === 200) {
        setPreview(data.data);
        toast({ title: "预检完成", description: `可导入 ${data.data.importableCount} 条` });
      } else {
        toast({ title: "预检失败", description: data?.message || "请重试", variant: "destructive" });
      }
    } finally {
      setPreviewing(false);
    }
  };

  const handleConfirm = async () => {
    if (!preview || importing) return;
    setImporting(true);
    setImportError(null);
    setSlowNotice(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIRM_TIMEOUT_MS);
    try {
      // 创建后台导入任务：本请求只解析建 job，不做逐行导入，秒级返回
      const res = await fetch("/api/admin/tools/import/confirm-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ previewToken: preview.previewToken, overwrite: preview.overwrite }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.code === 200) {
        // 任务已创建：跳转任务进度页分块执行（token 已被服务端消费）
        setConfirmOpen(false);
        setPreview(null);
        setFiles([]);
        toast({
          title: "导入任务已创建",
          description: `任务 #${data.data.jobId}（批次 #${data.data.batchId}），正在跳转进度页`,
        });
        router.push(data.data.jobUrl);
        return;
      } else {
        // 服务端明确失败：显示原因；token 已被消费，需重新预检
        setImportError(data?.message || `创建导入任务失败（HTTP ${res.status}）`);
        setConfirmOpen(false);
        setPreview(null);
        toast({ title: "创建导入任务失败", description: data?.message || "请重新预检后重试", variant: "destructive" });
      }
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (aborted) {
        // 创建任务超过 60s（解析大文件较慢）：任务可能已创建，引导去任务中心核对
        setSlowNotice(true);
        setConfirmOpen(false);
        setPreview(null);
        toast({ title: "任务创建较慢", description: "请稍后在批量任务中心核对" });
      } else {
        setImportError(
          err instanceof Error ? `请求失败：${err.message}` : "请求失败，请重试"
        );
        setConfirmOpen(false);
        setPreview(null);
        toast({ title: "导入失败", description: "网络异常，请重新预检后重试", variant: "destructive" });
      }
    } finally {
      // 无论成功 / 失败 / 超时都结束 loading，界面不会永久卡在“导入中”
      clearTimeout(timer);
      setImporting(false);
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
          <h1 className="text-2xl sm:text-3xl font-semibold text-foreground">
            批量导入工具（Excel）
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            上传 .xlsx（≤20 个、≤20MB/个）→ 预检 → 确认后创建后台导入任务，逐行分块执行
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/jobs">批量任务中心</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/tools" className="flex items-center gap-2">
              <ArrowLeft className="w-4 h-4" />
              返回工具管理
            </Link>
          </Button>
        </div>
      </div>

      {/* 上传区 */}
      <div className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-6 space-y-4">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            addFiles(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border/60 p-8 cursor-pointer hover:border-primary/40"
        >
          <Upload className="w-8 h-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">点击或拖拽 .xlsx 文件到此</p>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx"
            multiple
            hidden
            onChange={(e) => addFiles(e.target.files)}
          />
        </div>

        {files.length > 0 && (
          <div className="space-y-2">
            {files.map((f, i) => (
              <div key={i} className="flex items-center justify-between rounded-md border border-border/40 bg-background/20 px-3 py-2 text-sm">
                <span className="flex items-center gap-2 truncate">
                  <FileSpreadsheet className="w-4 h-4 text-primary shrink-0" />
                  <span className="truncate">{f.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {(f.size / 1024 / 1024).toFixed(2)}MB
                  </span>
                </span>
                <Button variant="ghost" size="sm" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-foreground/80">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
            覆盖已存在工具（approved / human_reviewed 仍不会被覆盖）
          </label>
          <Button onClick={handlePreview} disabled={!files.length || previewing} className="gap-2">
            {previewing ? "预检中..." : "预检 / Preview"}
          </Button>
        </div>
      </div>

      {/* 预检结果 */}
      {preview && (
        <div className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-6 space-y-4">
          <h2 className="text-lg font-semibold text-foreground">预检结果</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Stat label="文件数" value={preview.fileCount} />
            <Stat label="总行数" value={preview.totalRows} />
            <Stat label="有效行" value={preview.validRows} />
            <Stat label="可导入" value={preview.importableCount} highlight />
            <Stat label="跳过/错误行" value={preview.skippedRows} />
            <Stat label="重复工具" value={preview.duplicateCount} />
            <Stat label="无效 URL" value={preview.invalidUrlCount} />
          </div>

          {preview.categorySummary.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {preview.categorySummary.map((c) => (
                <Badge key={c.label} variant="outline" className="text-[11px]">
                  {c.label} · {c.fileCount} 文件
                </Badge>
              ))}
            </div>
          )}

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>文件</TableHead>
                  <TableHead>行数</TableHead>
                  <TableHead>有效</TableHead>
                  <TableHead>可导入</TableHead>
                  <TableHead>重复</TableHead>
                  <TableHead>跳过</TableHead>
                  <TableHead>错误</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.files.map((f) => (
                  <TableRow key={f.fileName}>
                    <TableCell className="max-w-[220px] truncate">{f.fileName}</TableCell>
                    <TableCell>{f.rowCount}</TableCell>
                    <TableCell>{f.validCount}</TableCell>
                    <TableCell>{f.importableCount}</TableCell>
                    <TableCell>{f.duplicateCount}</TableCell>
                    <TableCell>{f.skippedCount}</TableCell>
                    <TableCell>{f.errorCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {preview.errors.length > 0 && (
            <details className="rounded-md border border-border/40 bg-background/20 p-3">
              <summary className="cursor-pointer text-sm font-medium">
                前 {preview.errors.length} 条错误明细
              </summary>
              <div className="mt-2 space-y-1 text-xs text-orange-500">
                {preview.errors.map((e, i) => (
                  <p key={i}>第 {e.row} 行 ({e.name}): {e.reason}</p>
                ))}
              </div>
            </details>
          )}

          <Button onClick={() => setConfirmOpen(true)} disabled={preview.importableCount === 0} className="gap-2">
            确认导入
          </Button>
        </div>
      )}

      {/* 创建导入任务失败区 */}
      {importError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 space-y-3">
          <h2 className="text-lg font-semibold text-red-700 dark:text-red-300">创建导入任务失败</h2>
          <p className="text-sm">{importError}</p>
          <p className="text-xs text-muted-foreground">
            该预检已失效。请重新选择文件并预检后再次导入。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={handlePreview} disabled={!files.length || previewing}>
              {previewing ? "预检中..." : "重新预检"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => router.refresh()}>
              刷新批次列表
            </Button>
          </div>
        </div>
      )}

      {/* 创建任务较慢 / 超时提示区 */}
      {slowNotice && (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-6 space-y-3">
          <h2 className="text-lg font-semibold text-yellow-700 dark:text-yellow-300">
            任务创建较慢
          </h2>
          <p className="text-sm">
            请求超过 60 秒仍未返回（解析大文件较慢）。任务可能已创建，
            请到批量任务中心核对，不要重复提交。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" asChild>
              <Link href="/admin/jobs">前往批量任务中心</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => router.refresh()}>
              刷新批次列表
            </Button>
          </div>
        </div>
      )}

      {/* 历史批次 */}
      <div className="rounded-xl border border-border/40 bg-background/30 shadow-sm overflow-hidden backdrop-blur-sm">
        <div className="border-b border-border/40 bg-background/20 p-4">
          <h2 className="text-lg font-semibold text-foreground">历史导入批次</h2>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>文件</TableHead>
                <TableHead>导入</TableHead>
                <TableHead>跳过</TableHead>
                <TableHead>错误</TableHead>
                <TableHead>时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initialBatches.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-10">
                    暂无导入批次
                  </TableCell>
                </TableRow>
              ) : (
                initialBatches.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>{b.id}</TableCell>
                    <TableCell className="max-w-[160px] truncate">{b.name || "—"}</TableCell>
                    <TableCell>{b.fileCount}</TableCell>
                    <TableCell>{b.importedCount}</TableCell>
                    <TableCell>{b.skippedCount}</TableCell>
                    <TableCell>{b.errorCount}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {b.startedAt.slice(0, 16).replace("T", " ")}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/admin/tools/import/${b.id}`}>详情</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* 确认弹窗（无确认词） */}
      <Dialog open={confirmOpen} onOpenChange={(o) => !o && setConfirmOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认导入</DialogTitle>
          </DialogHeader>
          {preview && (
            <div className="space-y-2 text-sm">
              <p>将导入约 <strong>{preview.importableCount}</strong> 条工具（status=pending）。</p>
              <p className="text-muted-foreground">
                预计跳过 {preview.duplicateCount} 条重复
                {preview.overwrite ? "（已勾选覆盖；approved / human_reviewed 仍会被跳过）" : "（默认不覆盖已存在工具）"}，
                错误行 {preview.skippedRows} 条。
              </p>
              <p className="text-xs text-muted-foreground">
                导入内容作为内部底稿（raw_imported），不会自动发布。
              </p>
              <p className="text-xs text-muted-foreground">
                将创建后台导入任务并跳转进度页，逐行分块执行，无需在此等待。
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>取消</Button>
            <Button onClick={handleConfirm} disabled={importing}>
              {importing ? "创建任务中..." : "确认导入"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={cn("rounded-lg border border-border/40 bg-background/20 p-3", highlight && "border-primary/30")}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold", highlight && "text-primary")}>{value}</p>
    </div>
  );
}
