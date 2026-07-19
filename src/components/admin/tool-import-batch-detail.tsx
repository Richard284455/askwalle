"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, Sparkles, Wrench } from "lucide-react";
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

type FileRow = {
  id: number;
  fileName: string;
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  errorLog: string | null;
  level1: string | null;
  level2: string | null;
};

type Batch = {
  id: number;
  name: string | null;
  fileCount: number;
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  startedAt: string;
  finishedAt: string | null;
  toolCount: number;
  files: FileRow[];
};

export function ToolImportBatchDetail({ batch }: { batch: Batch }) {
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
            导入批次 #{batch.id}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {batch.name || "未命名"} · {batch.startedAt.slice(0, 16).replace("T", " ")}
            {batch.finishedAt ? " → 已完成" : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/tools/import" className="flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            返回导入列表
          </Link>
        </Button>
      </div>

      {/* summary */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Stat label="文件" value={batch.fileCount} />
        <Stat label="总行" value={batch.rowCount} />
        <Stat label="导入" value={batch.importedCount} />
        <Stat label="跳过" value={batch.skippedCount} />
        <Stat label="错误" value={batch.errorCount} />
      </div>

      {/* 下一步 */}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" asChild>
          <Link href={`/admin/tools?importBatchId=${batch.id}`} className="gap-2">
            <Wrench className="w-4 h-4" />
            查看本批次工具（{batch.toolCount}）
          </Link>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/admin/tools/rewrite/new?importBatchId=${batch.id}`} className="gap-2">
            <Sparkles className="w-4 h-4" />
            创建 AI 改写任务
          </Link>
        </Button>
      </div>

      {/* 逐文件结果 */}
      <div className="rounded-xl border border-border/40 bg-background/30 shadow-sm overflow-hidden backdrop-blur-sm">
        <div className="border-b border-border/40 bg-background/20 p-4">
          <h2 className="text-lg font-semibold text-foreground">逐文件结果</h2>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>文件</TableHead>
                <TableHead>分类</TableHead>
                <TableHead>行数</TableHead>
                <TableHead>导入</TableHead>
                <TableHead>跳过</TableHead>
                <TableHead>错误</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batch.files.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="max-w-[220px] truncate">{f.fileName}</TableCell>
                  <TableCell className="text-sm">
                    {f.level1 ? (f.level2 ? `${f.level1} / ${f.level2}` : f.level1) : "—"}
                  </TableCell>
                  <TableCell>{f.rowCount}</TableCell>
                  <TableCell>{f.importedCount}</TableCell>
                  <TableCell>{f.skippedCount}</TableCell>
                  <TableCell>
                    {f.errorCount > 0 ? (
                      <Badge variant="outline" className="text-[11px] border-orange-500/30 text-orange-500">
                        {f.errorCount}
                      </Badge>
                    ) : (
                      "0"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* 错误明细 */}
      {batch.files.some((f) => f.errorLog) && (
        <div className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-6 space-y-3">
          <h2 className="text-lg font-semibold text-foreground">错误明细</h2>
          {batch.files
            .filter((f) => f.errorLog)
            .map((f) => (
              <details key={f.id} className="rounded-md border border-border/40 bg-background/20 p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  {f.fileName}（{f.errorCount} 条）
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto text-xs text-orange-500 whitespace-pre-wrap">
                  {f.errorLog}
                </pre>
              </details>
            ))}
        </div>
      )}
    </motion.div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/20 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
    </div>
  );
}
