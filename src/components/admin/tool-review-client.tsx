"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, Eye, Search } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/common/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils/utils";
import type { AdminCategoryOption } from "@/lib/website/tool-admin";
import type { ReviewListItem, ReviewPreview } from "@/lib/website/tool-review";

const REWRITE_STATUS_COLORS: Record<string, string> = {
  raw_imported: "text-yellow-500",
  draft_generated: "text-blue-500",
  human_reviewed: "text-green-600",
};

type BulkResult = {
  selected: number;
  succeeded: number;
  skipped: number;
  failed: number;
  failedReasons: { websiteId: number; reason: string }[];
  affectedIds: number[];
};

type ConfirmAction = {
  title: string;
  word: string;
  endpoint: string;
  extra?: Record<string, unknown>;
  needsNotes?: boolean;
};

export function ToolReviewClient({
  initialItems,
  categories,
  batches,
}: {
  initialItems: ReviewListItem[];
  categories: AdminCategoryOption[];
  batches: { id: number; label: string }[];
}) {
  const { toast } = useToast();
  const [items, setItems] = useState(initialItems);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);

  const [batchId, setBatchId] = useState("all");
  const [categoryId, setCategoryId] = useState("all");
  const [rewriteStatus, setRewriteStatus] = useState("draft_generated");
  const [websiteStatus, setWebsiteStatus] = useState("all");
  const [search, setSearch] = useState("");

  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [confirmInput, setConfirmInput] = useState("");
  const [reviewNotes, setReviewNotes] = useState("");
  const [result, setResult] = useState<BulkResult | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (batchId !== "all") params.set("rewriteBatchId", batchId);
    if (categoryId !== "all") params.set("categoryId", categoryId);
    if (rewriteStatus !== "all") params.set("rewriteStatus", rewriteStatus);
    if (websiteStatus !== "all") params.set("websiteStatus", websiteStatus);
    if (search.trim()) params.set("search", search.trim());
    try {
      const data = await fetch(`/api/admin/tools/review?${params}`).then((r) =>
        r.json()
      );
      if (data?.code === 200) {
        setItems(data.data);
        setSelected(new Set());
      }
    } finally {
      setLoading(false);
    }
  };

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) =>
      prev.size === items.length ? new Set() : new Set(items.map((i) => i.websiteId))
    );
  };

  const openPreview = async (websiteId: number) => {
    const data = await fetch(
      `/api/admin/tools/review?websiteId=${websiteId}`
    ).then((r) => r.json());
    if (data?.code === 200) setPreview(data.data);
    else toast({ title: "预览失败", description: data?.message, variant: "destructive" });
  };

  const runAction = async () => {
    if (!confirmAction || busy) return;
    if (confirmInput !== confirmAction.word) {
      toast({
        title: "确认词不正确",
        description: `请输入 ${confirmAction.word}`,
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    try {
      const data = await fetch(confirmAction.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          websiteIds: [...selected],
          confirm: confirmAction.word,
          ...(confirmAction.needsNotes ? { reviewNotes } : {}),
          ...(confirmAction.extra ?? {}),
        }),
      }).then((r) => r.json());
      if (data?.code === 200) {
        setResult(data.data as BulkResult);
        setConfirmAction(null);
        setConfirmInput("");
        toast({ title: "操作完成", description: confirmAction.title });
        await reload();
      } else {
        toast({
          title: "操作失败",
          description: data?.message || "请重试",
          variant: "destructive",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const selectedCount = selected.size;

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
            批量审核 / 发布
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            审核 AI 改写结果 → 应用草稿 → 标记人工已审核 → 发布（每步须输入确认词）
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/tools" className="flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            返回工具管理
          </Link>
        </Button>
      </div>

      {/* 筛选 */}
      <div className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <Select value={batchId} onValueChange={setBatchId}>
            <SelectTrigger className="bg-background/40 border-border/40">
              <SelectValue placeholder="改写批次" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部批次</SelectItem>
              {batches.map((b) => (
                <SelectItem key={b.id} value={b.id.toString()}>
                  {b.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger className="bg-background/40 border-border/40">
              <SelectValue placeholder="分类" />
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
          <Select value={rewriteStatus} onValueChange={setRewriteStatus}>
            <SelectTrigger className="bg-background/40 border-border/40">
              <SelectValue placeholder="rewrite_status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部改写状态</SelectItem>
              <SelectItem value="raw_imported">raw_imported</SelectItem>
              <SelectItem value="draft_generated">draft_generated</SelectItem>
              <SelectItem value="human_reviewed">human_reviewed</SelectItem>
            </SelectContent>
          </Select>
          <Select value={websiteStatus} onValueChange={setWebsiteStatus}>
            <SelectTrigger className="bg-background/40 border-border/40">
              <SelectValue placeholder="website status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部工具状态</SelectItem>
              <SelectItem value="pending">pending</SelectItem>
              <SelectItem value="approved">approved</SelectItem>
              <SelectItem value="rejected">rejected</SelectItem>
              <SelectItem value="archived">archived</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索 title / slug"
              className="pl-9 bg-background/40 border-border/40"
            />
          </div>
          <Button onClick={reload} disabled={loading}>
            {loading ? "加载中..." : "应用筛选"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          import batch 映射：TODO（当前批次表未存 website 关联）。
        </p>
      </div>

      {/* 批量操作栏 */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-4">
        <span className="text-sm text-muted-foreground">
          已选 {selectedCount} 条：
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={selectedCount === 0}
          onClick={() =>
            setConfirmAction({
              title: "Apply selected drafts",
              word: "APPLY",
              endpoint: "/api/admin/tools/review/apply-drafts",
            })
          }
        >
          Apply drafts
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={selectedCount === 0}
          onClick={() =>
            setConfirmAction({
              title: "Mark as human reviewed",
              word: "REVIEWED",
              endpoint: "/api/admin/tools/review/mark-reviewed",
              needsNotes: true,
            })
          }
        >
          Mark reviewed
        </Button>
        <Button
          size="sm"
          disabled={selectedCount === 0}
          onClick={() =>
            setConfirmAction({
              title: "Publish selected",
              word: "PUBLISH",
              endpoint: "/api/admin/tools/review/publish",
            })
          }
        >
          Publish
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-red-500 hover:text-red-600"
          disabled={selectedCount === 0}
          onClick={() =>
            setConfirmAction({
              title: "Archive selected",
              word: "ARCHIVE",
              endpoint: "/api/admin/tools/review/archive",
              extra: { status: "archived" },
            })
          }
        >
          Archive
        </Button>
      </div>

      {/* 结果报告 */}
      {result && (
        <div className="rounded-xl border border-border/40 bg-background/20 p-4 text-sm space-y-1">
          <p className="font-medium">
            结果：选中 {result.selected}，成功 {result.succeeded}，跳过{" "}
            {result.skipped}，失败 {result.failed}
          </p>
          {result.affectedIds.length > 0 && (
            <p className="text-xs text-muted-foreground">
              affected: {result.affectedIds.join(", ")}
            </p>
          )}
          {result.failedReasons.slice(0, 20).map((r, i) => (
            <p key={i} className="text-xs text-orange-500">
              #{r.websiteId}: {r.reason}
            </p>
          ))}
        </div>
      )}

      {/* 列表 */}
      <div className="rounded-xl border border-border/40 bg-background/30 shadow-sm overflow-hidden backdrop-blur-sm">
        <div className="bg-background/20 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    type="checkbox"
                    checked={selectedCount > 0 && selectedCount === items.length}
                    onChange={toggleAll}
                  />
                </TableHead>
                <TableHead>工具</TableHead>
                <TableHead>分类</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>rewrite</TableHead>
                <TableHead>QC</TableHead>
                <TableHead>provider/model</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-10">
                    暂无符合条件的工具
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item) => (
                  <TableRow key={item.websiteId}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selected.has(item.websiteId)}
                        onChange={() => toggle(item.websiteId)}
                      />
                    </TableCell>
                    <TableCell className="max-w-[220px]">
                      <div className="font-medium truncate">{item.title}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {item.slug || "(无 slug)"}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{item.categoryName}</TableCell>
                    <TableCell className="text-sm">{item.websiteStatus}</TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "text-sm font-medium",
                          item.rewriteStatus
                            ? REWRITE_STATUS_COLORS[item.rewriteStatus]
                            : ""
                        )}
                      >
                        {item.rewriteStatus ?? "—"}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {item.qcStatus ? (
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[11px]",
                            item.qcStatus === "passed"
                              ? "border-green-500/30 text-green-600"
                              : "border-orange-500/30 text-orange-500"
                          )}
                        >
                          {item.qcStatus}
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {item.provider ? `${item.provider}/${item.model}` : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openPreview(item.websiteId)}
                          title="预览草稿"
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/admin/tools/${item.websiteId}/edit`}>
                            编辑
                          </Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* 预览对话框 */}
      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>
              草稿预览 — {preview?.title}（{preview?.rewriteStatus}）
            </DialogTitle>
          </DialogHeader>
          {preview && (
            <div className="space-y-4 text-sm">
              {preview.qcErrors.length > 0 && (
                <div className="rounded-md border border-orange-500/30 bg-orange-500/10 p-3 text-xs text-orange-600">
                  QC 错误: {preview.qcErrors.join("; ")}
                </div>
              )}
              <div>
                <p className="font-semibold text-foreground/70">AI 改写草稿</p>
                <pre className="mt-1 overflow-auto rounded-md border border-border/40 bg-background/40 p-3 text-xs whitespace-pre-wrap break-all">
                  {preview.draft
                    ? JSON.stringify(preview.draft, null, 2)
                    : "（无草稿）"}
                </pre>
              </div>
              <div>
                <p className="font-semibold text-foreground/70">
                  公开页当前字段
                </p>
                <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                  <p>description: {preview.current.description}</p>
                  <p>what: {preview.current.what || "（空）"}</p>
                  <p>how: {preview.current.how || "（空）"}</p>
                  <p>features: {preview.current.features.length} 条</p>
                  <p>useCases: {preview.current.useCases.length} 条</p>
                  <p>faqs: {preview.current.faqs.length} 条</p>
                </div>
              </div>
              <details>
                <summary className="cursor-pointer text-xs font-medium text-foreground/70">
                  Raw imported content（仅内部）
                </summary>
                <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-border/40 bg-background/40 p-3 text-xs whitespace-pre-wrap break-all">
                  {preview.raw ? JSON.stringify(preview.raw, null, 2) : "（无）"}
                </pre>
              </details>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 确认词对话框 */}
      <Dialog
        open={confirmAction !== null}
        onOpenChange={(o) => {
          if (!o) {
            setConfirmAction(null);
            setConfirmInput("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmAction?.title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              将对已选的 <strong>{selectedCount}</strong> 条工具执行此操作。
              服务端会逐条重新校验资格，不合格的会被跳过。
            </p>
            {confirmAction?.needsNotes && (
              <Input
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                placeholder="审核备注（可选）"
                className="bg-background/40 border-border/40"
              />
            )}
            <p className="text-muted-foreground">
              输入确认词 <strong>{confirmAction?.word}</strong> 以继续：
            </p>
            <Input
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={confirmAction?.word}
              className="bg-background/40 border-border/40"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmAction(null);
                setConfirmInput("");
              }}
            >
              取消
            </Button>
            <Button
              onClick={runAction}
              disabled={busy || confirmInput !== confirmAction?.word}
            >
              {busy ? "执行中..." : "确认执行"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
