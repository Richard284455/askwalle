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
import type {
  ReviewListItem,
  ReviewPreview,
  ReviewStats,
} from "@/lib/website/tool-review";

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
  mediaLocalized?: number;
  mediaAlreadyCached?: number;
  mediaFailed?: number;
};

type MediaPrecheck = {
  websites: number;
  totalMedia: number;
  externalMedia: number;
  alreadyCached: number;
  needsLocalize: number;
  previouslyFailed: number;
};

// 每个 Tab 映射到一组筛选（业务状态由现有字段推出）
type TabDef = {
  key: string;
  label: string;
  statKey?: keyof ReviewStats;
  filter: {
    rewriteStatus?: string;
    qcStatus?: string;
    websiteStatus?: string;
  };
};

const TABS: TabDef[] = [
  { key: "pending", label: "待处理", statKey: "pendingRewrite", filter: { rewriteStatus: "raw_imported" } },
  { key: "qc_failed", label: "QC 失败", statKey: "qcFailed", filter: { qcStatus: "failed" } },
  { key: "review", label: "待审核", statKey: "pendingReview", filter: { rewriteStatus: "draft_generated", qcStatus: "passed" } },
  { key: "publish", label: "待发布", statKey: "pendingPublish", filter: { rewriteStatus: "human_reviewed", websiteStatus: "pending" } },
  { key: "published", label: "已发布", statKey: "published", filter: { websiteStatus: "approved" } },
  { key: "archived", label: "已归档", statKey: "archived", filter: { websiteStatus: "archived" } },
];

// 批量操作定义（无确认词，二次确认弹窗）
type BulkOp = {
  key: string;
  label: string;
  endpoint: string;
  variant?: "default" | "outline";
  danger?: boolean;
  needsNotes?: boolean;
  extra?: Record<string, unknown>;
  risk: string;
};

const BULK_OPS: BulkOp[] = [
  {
    key: "apply-and-review",
    label: "Apply & Mark Reviewed",
    endpoint: "mark-reviewed",
    variant: "default",
    needsNotes: true,
    risk: "对 draft_generated + QC 通过的工具：先应用草稿到公开字段，再标记人工已审核（仍 pending，不发布）。",
  },
  {
    key: "apply-only",
    label: "Apply only（高级）",
    endpoint: "apply-drafts",
    variant: "outline",
    risk: "只把草稿应用到公开字段，不标记审核、不发布。",
  },
  {
    key: "publish",
    label: "Publish",
    endpoint: "publish",
    variant: "default",
    risk: "只发布 pending + human_reviewed 的工具（复用发布守卫），其它一律跳过。",
  },
  {
    key: "archive",
    label: "Archive",
    endpoint: "archive",
    variant: "outline",
    danger: true,
    extra: { status: "archived" },
    risk: "把选中工具改为 archived（仅改状态，不删除数据）。",
  },
];

export function ToolReviewClient({
  initialItems,
  initialStats,
  categories,
  batches,
  presetBatchId,
  presetTab,
}: {
  initialItems: ReviewListItem[];
  initialStats: ReviewStats | null;
  categories: AdminCategoryOption[];
  batches: { id: number; label: string }[];
  presetBatchId?: number | null;
  presetTab?: string;
}) {
  const { toast } = useToast();
  const [items, setItems] = useState(initialItems);
  const [stats, setStats] = useState<ReviewStats | null>(initialStats);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);

  const [tab, setTab] = useState(
    TABS.some((t) => t.key === presetTab) ? presetTab! : "review"
  );
  const [batchId, setBatchId] = useState(presetBatchId ? String(presetBatchId) : "all");
  const [categoryId, setCategoryId] = useState("all");
  const [search, setSearch] = useState("");

  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [pendingOp, setPendingOp] = useState<BulkOp | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [result, setResult] = useState<BulkResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [mediaPrecheck, setMediaPrecheck] = useState<MediaPrecheck | null>(null);

  // Publish 弹窗打开时做媒体预检（只读）
  const loadMediaPrecheck = async (ids: number[]) => {
    setMediaPrecheck(null);
    try {
      const data = await fetch("/api/admin/tools/review/media-precheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ websiteIds: ids }),
      }).then((r) => r.json());
      if (data?.code === 200) setMediaPrecheck(data.data);
    } catch {
      // 预检失败不阻塞弹窗；发布时服务端仍会执行媒体 guard
    }
  };

  const activeTab = TABS.find((t) => t.key === tab) ?? TABS[2];

  const buildParams = (tabKey = tab) => {
    const def = TABS.find((t) => t.key === tabKey) ?? activeTab;
    const params = new URLSearchParams();
    if (def.filter.rewriteStatus) params.set("rewriteStatus", def.filter.rewriteStatus);
    if (def.filter.qcStatus) params.set("qcStatus", def.filter.qcStatus);
    if (def.filter.websiteStatus) params.set("websiteStatus", def.filter.websiteStatus);
    if (batchId !== "all") params.set("rewriteBatchId", batchId);
    if (categoryId !== "all") params.set("categoryId", categoryId);
    if (search.trim()) params.set("search", search.trim());
    return params;
  };

  const reload = async (tabKey = tab) => {
    setLoading(true);
    try {
      const [listRes, statsRes] = await Promise.all([
        fetch(`/api/admin/tools/review?${buildParams(tabKey)}`).then((r) => r.json()),
        fetch(`/api/admin/tools/review/stats`).then((r) => r.json()),
      ]);
      if (listRes?.code === 200) setItems(listRes.data);
      if (statsRes?.code === 200) setStats(statsRes.data);
      setSelected(new Set());
    } finally {
      setLoading(false);
    }
  };

  const switchTab = (key: string) => {
    setTab(key);
    setResult(null);
    reload(key);
  };

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) =>
      prev.size === items.length ? new Set() : new Set(items.map((i) => i.websiteId))
    );

  const openPreview = async (websiteId: number) => {
    const data = await fetch(`/api/admin/tools/review?websiteId=${websiteId}`).then((r) => r.json());
    if (data?.code === 200) setPreview(data.data);
    else toast({ title: "预览失败", description: data?.message, variant: "destructive" });
  };

  const runOp = async () => {
    if (!pendingOp || busy) return;
    setBusy(true);
    try {
      const data = await fetch(`/api/admin/tools/review/${pendingOp.endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          websiteIds: [...selected],
          ...(pendingOp.needsNotes ? { reviewNotes } : {}),
          ...(pendingOp.extra ?? {}),
        }),
      }).then((r) => r.json());
      if (data?.code === 200) {
        setResult(data.data as BulkResult);
        setPendingOp(null);
        toast({ title: "操作完成", description: pendingOp.label });
        await reload();
      } else {
        toast({ title: "操作失败", description: data?.message || "请重试", variant: "destructive" });
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
          <h1 className="text-2xl sm:text-3xl font-semibold text-foreground">审核发布工作台</h1>
          <p className="text-sm text-muted-foreground mt-1">
            AI 草稿 → 应用+审核 → 发布，每步二次确认（无确认词），服务端逐条重校验
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/tools" className="flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            返回工具管理
          </Link>
        </Button>
      </div>

      {/* 统计卡片 */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          <StatCard label="待改写" value={stats.pendingRewrite} />
          <StatCard label="草稿已生成" value={stats.draftGenerated} />
          <StatCard label="QC 通过" value={stats.qcPassed} />
          <StatCard label="QC 失败" value={stats.qcFailed} />
          <StatCard label="待应用" value={stats.pendingReview} />
          <StatCard label="待审核" value={stats.pendingReview} />
          <StatCard label="待发布" value={stats.pendingPublish} />
          <StatCard label="已发布" value={stats.published} />
        </div>
      )}

      {/* 状态 Tab */}
      <div className="flex flex-wrap gap-2 border-b border-border/40 pb-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => switchTab(t.key)}
            className={cn(
              "px-3 py-1.5 rounded-lg border text-sm transition-all",
              tab === t.key
                ? "bg-background/40 border-primary/30 text-foreground shadow-sm"
                : "bg-background/20 border-border/40 text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
            {stats && t.statKey ? (
              <Badge variant="outline" className="ml-1.5 px-1.5 py-0 text-[10px]">
                {stats[t.statKey]}
              </Badge>
            ) : null}
          </button>
        ))}
      </div>

      {/* 筛选 */}
      <div className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Select value={batchId} onValueChange={setBatchId}>
            <SelectTrigger className="bg-background/40 border-border/40">
              <SelectValue placeholder="改写批次" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部批次</SelectItem>
              {batches.map((b) => (
                <SelectItem key={b.id} value={b.id.toString()}>{b.label}</SelectItem>
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
                <SelectItem key={c.id} value={c.id.toString()}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索 title / slug"
              className="pl-9 bg-background/40 border-border/40"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => reload()} disabled={loading} size="sm">
            {loading ? "加载中..." : "应用筛选"}
          </Button>
          <span className="text-xs text-muted-foreground">
            import batch 映射：TODO（当前批次表未存 website 关联）。
          </span>
        </div>
      </div>

      {/* 批量操作栏 */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-4">
        <span className="text-sm text-muted-foreground">已选 {selectedCount} 条：</span>
        {BULK_OPS.map((op) => (
          <Button
            key={op.key}
            size="sm"
            variant={op.variant ?? "outline"}
            disabled={selectedCount === 0}
            className={op.danger ? "text-red-500 hover:text-red-600" : undefined}
            onClick={() => {
              setReviewNotes("");
              setPendingOp(op);
              if (op.key === "publish") loadMediaPrecheck([...selected]);
            }}
          >
            {op.label}
          </Button>
        ))}
        {tab === "qc_failed" && (
          <Button size="sm" variant="outline" asChild>
            <Link
              href="/admin/tools/rewrite/new?retry=qc_failed"
              title="跳转改写向导，按 QC 失败筛选创建重新改写任务（不在本页调用 AI）"
            >
              重新改写（按当前筛选创建任务）
            </Link>
          </Button>
        )}
      </div>

      {/* 结果区 */}
      {result && (
        <div className="rounded-xl border border-border/40 bg-background/20 p-4 text-sm space-y-2">
          <p className="font-medium">
            结果：选中 {result.selected}，成功 {result.succeeded}，跳过 {result.skipped}，失败 {result.failed}
          </p>
          {(result.mediaLocalized ?? result.mediaAlreadyCached ?? result.mediaFailed) !==
            undefined && (
            <p className="text-xs text-muted-foreground">
              媒体：本次本地化 {result.mediaLocalized ?? 0} 张 · 此前已缓存{" "}
              {result.mediaAlreadyCached ?? 0} 张 ·{" "}
              <span className={result.mediaFailed ? "text-orange-500" : ""}>
                失败 {result.mediaFailed ?? 0} 张
              </span>
            </p>
          )}
          {result.affectedIds.length > 0 && (
            <p className="text-xs text-muted-foreground">affected: {result.affectedIds.join(", ")}</p>
          )}
          {result.failedReasons.slice(0, 20).map((r, i) => (
            <p key={i} className="text-xs text-orange-500">#{r.websiteId}: {r.reason}</p>
          ))}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => reload()}>返回审核列表</Button>
            <Button variant="outline" size="sm" onClick={() => switchTab("publish")}>查看待发布</Button>
            <Button variant="outline" size="sm" onClick={() => switchTab("published")}>查看已发布</Button>
          </div>
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
                      <input type="checkbox" checked={selected.has(item.websiteId)} onChange={() => toggle(item.websiteId)} />
                    </TableCell>
                    <TableCell className="max-w-[220px]">
                      <div className="font-medium truncate">{item.title}</div>
                      <div className="text-xs text-muted-foreground truncate">{item.slug || "(无 slug)"}</div>
                    </TableCell>
                    <TableCell className="text-sm">{item.categoryName}</TableCell>
                    <TableCell className="text-sm">{item.websiteStatus}</TableCell>
                    <TableCell>
                      <span className={cn("text-sm font-medium", item.rewriteStatus ? REWRITE_STATUS_COLORS[item.rewriteStatus] : "")}>
                        {item.rewriteStatus ?? "—"}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {item.qcStatus ? (
                        <Badge variant="outline" className={cn("text-[11px]", item.qcStatus === "passed" ? "border-green-500/30 text-green-600" : "border-orange-500/30 text-orange-500")}>
                          {item.qcStatus}
                        </Badge>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {item.provider ? `${item.provider}/${item.model}` : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openPreview(item.websiteId)} title="预览草稿">
                          <Eye className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/admin/tools/${item.websiteId}/edit`}>编辑</Link>
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
            <DialogTitle>草稿预览 — {preview?.title}（{preview?.rewriteStatus}）</DialogTitle>
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
                  {preview.draft ? JSON.stringify(preview.draft, null, 2) : "（无草稿）"}
                </pre>
              </div>
              <div>
                <p className="font-semibold text-foreground/70">公开页当前字段</p>
                <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                  <p>description: {preview.current.description}</p>
                  <p>what: {preview.current.what || "（空）"}</p>
                  <p>how: {preview.current.how || "（空）"}</p>
                  <p>features: {preview.current.features.length} 条 · useCases: {preview.current.useCases.length} 条 · faqs: {preview.current.faqs.length} 条</p>
                </div>
              </div>
              <details>
                <summary className="cursor-pointer text-xs font-medium text-foreground/70">Raw imported content（仅内部）</summary>
                <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-border/40 bg-background/40 p-3 text-xs whitespace-pre-wrap break-all">
                  {preview.raw ? JSON.stringify(preview.raw, null, 2) : "（无）"}
                </pre>
              </details>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 批量操作确认弹窗（无确认词） */}
      <Dialog open={pendingOp !== null} onOpenChange={(o) => !o && setPendingOp(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pendingOp?.label}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              将对已选的 <strong>{selectedCount}</strong> 条工具执行此操作。
              服务端会逐条重新校验资格，不合格的会被跳过。
            </p>
            <p className="text-muted-foreground">{pendingOp?.risk}</p>
            {pendingOp?.key === "publish" && (
              <div className="rounded-md border border-border/40 bg-background/30 p-3 text-xs space-y-1">
                <p className="font-medium text-foreground/80">媒体预检</p>
                {mediaPrecheck ? (
                  <>
                    <p>
                      外链图片 {mediaPrecheck.externalMedia} 张 · 已本地化{" "}
                      {mediaPrecheck.alreadyCached} 张 · 发布前将本地化{" "}
                      {mediaPrecheck.needsLocalize} 张
                      {mediaPrecheck.previouslyFailed > 0
                        ? `（其中 ${mediaPrecheck.previouslyFailed} 张上次失败，将重试）`
                        : ""}
                    </p>
                    <p className="text-muted-foreground">
                      外链图片会先下载到本站再发布；本地化失败的工具将被跳过，不会静默发布。
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground">预检中...</p>
                )}
              </div>
            )}
            {pendingOp?.needsNotes && (
              <Input
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                placeholder="审核备注（可选）"
                className="bg-background/40 border-border/40"
              />
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingOp(null)}>取消</Button>
            <Button onClick={runOp} disabled={busy}>
              {busy ? "执行中..." : "确认执行"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/20 p-3 text-center">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-foreground">{value}</p>
    </div>
  );
}
