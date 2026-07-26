"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/ui/common/button";
import { Input } from "@/ui/common/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/common/select";
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
import { BATCH_LIMIT_MAX } from "@/lib/website/rewrite-limits";
import type {
  RewriteProviderId,
  RewriteProviderInfo,
} from "@/lib/website/tool-rewrite-batch";

const MODEL_TYPES = ["general", "fast", "reasoning", "custom"] as const;

const BackToList = () => (
  <Button variant="outline" size="sm" asChild>
    <Link href="/admin/tools/rewrite" className="flex items-center gap-2">
      <ArrowLeft className="w-4 h-4" />
      返回改写任务列表
    </Link>
  </Button>
);

type EstimateView = {
  eligible: number;
  wouldProcess: number;
  wouldSkip: number;
  skippedApproved: number;
  skippedHumanReviewed: number;
  skippedMissingRaw: number;
  skippedExistingDraft: number;
  skippedInActiveBatch: number;
  retryableFailed: number;
  retryableQcFailed: number;
};

const RETRY_FILTERS = [
  { value: "all", label: "全部符合条件" },
  { value: "failed", label: "仅有失败记录的（重试）" },
  { value: "qc_failed", label: "仅 QC 失败的（重试）" },
  { value: "no_draft", label: "仅无草稿的" },
] as const;

export function RewriteWizard({
  categories,
  providers,
  defaultProvider,
  importBatches,
  presetImportBatchId,
  presetRetryFilter,
}: {
  categories: AdminCategoryOption[];
  providers: RewriteProviderInfo[];
  defaultProvider: RewriteProviderId;
  importBatches: { id: number; label: string }[];
  presetImportBatchId: number | null;
  presetRetryFilter?: string | null;
}) {
  const { toast } = useToast();
  const [step, setStep] = useState(1);

  // Step 1
  const [importBatchId, setImportBatchId] = useState(
    presetImportBatchId ? String(presetImportBatchId) : "all"
  );
  const [categoryId, setCategoryId] = useState("all");
  const [rewriteStatus, setRewriteStatus] = useState("raw_imported");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState("20");
  const [retryFilter, setRetryFilter] = useState(
    presetRetryFilter && ["failed", "qc_failed", "no_draft"].includes(presetRetryFilter)
      ? presetRetryFilter
      : "all"
  );
  const [overwriteDraft, setOverwriteDraft] = useState(false);
  const [estimate, setEstimate] = useState<EstimateView | null>(null);
  const [estimating, setEstimating] = useState(false);

  // Step 2
  const [name, setName] = useState("");
  const [providerId, setProviderId] = useState<string>(defaultProvider);
  const [model, setModel] = useState("");
  const [modelType, setModelType] = useState<string>("general");

  // Step 3/4
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ batchId: number; total: number } | null>(null);

  const selectedProvider = providers.find((p) => p.id === providerId) ?? providers[0];

  const buildBody = () => ({
    name: name.trim() || undefined,
    importBatchId: importBatchId === "all" ? undefined : parseInt(importBatchId),
    categoryId: categoryId === "all" ? undefined : parseInt(categoryId),
    rewriteStatuses: [rewriteStatus],
    search: search.trim() || undefined,
    limit: parseInt(limit) || 20,
    retryFilter: retryFilter === "all" ? undefined : retryFilter,
    overwriteExistingDraft: overwriteDraft,
    provider: providerId,
    model: model.trim() || undefined,
    modelType,
  });

  const runEstimate = async () => {
    setEstimating(true);
    try {
      const res = await fetch("/api/admin/tools/rewrite/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.code === 200) setEstimate(data.data);
      else setEstimate(null);
    } finally {
      setEstimating(false);
    }
  };

  // Step 1 每次筛选变化后自动重新预估
  useEffect(() => {
    if (step === 1 || step === 3) runEstimate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, importBatchId, categoryId, rewriteStatus, search, limit, retryFilter, overwriteDraft]);

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/tools/rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.code === 200) {
        setCreated(data.data);
        setConfirmOpen(false);
        setStep(4);
        toast({ title: "任务已创建", description: `批次 #${data.data.batchId}` });
      } else {
        toast({ title: "创建失败", description: data?.message || "请重试", variant: "destructive" });
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="container max-w-3xl mx-auto px-4 sm:px-6 py-4 sm:py-6 min-h-[calc(100vh-4rem)] space-y-6"
    >
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-background/30 backdrop-blur-sm p-6 rounded-xl border border-border/40">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-foreground">
            创建 AI 改写任务
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            第 {step} / 4 步 · 结果只保存为草稿，不会自动审核或发布
          </p>
        </div>
        <BackToList />
      </div>

      {/* 步骤指示 */}
      <div className="flex items-center gap-2">
        {[1, 2, 3, 4].map((n) => (
          <div
            key={n}
            className={cn(
              "flex-1 h-1.5 rounded-full",
              n <= step ? "bg-primary" : "bg-border/60"
            )}
          />
        ))}
      </div>

      {/* Step 1 */}
      {step === 1 && (
        <div className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-6 space-y-4">
          <h2 className="text-lg font-semibold text-foreground">Step 1 · 选择数据范围</h2>
          <p className="text-xs text-muted-foreground">
            默认只选 pending + raw_imported，自动排除 approved / human_reviewed。
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="导入批次">
              <Select value={importBatchId} onValueChange={setImportBatchId}>
                <SelectTrigger className="bg-background/40 border-border/40">
                  <SelectValue placeholder="全部" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部批次</SelectItem>
                  {importBatches.map((b) => (
                    <SelectItem key={b.id} value={b.id.toString()}>
                      {b.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="分类">
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger className="bg-background/40 border-border/40">
                  <SelectValue placeholder="全部" />
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
            </Field>
            <Field label="rewrite_status">
              <Select value={rewriteStatus} onValueChange={setRewriteStatus}>
                <SelectTrigger className="bg-background/40 border-border/40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="raw_imported">raw_imported</SelectItem>
                  <SelectItem value="draft_generated">draft_generated（重写已有草稿）</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={`Limit（最大 ${BATCH_LIMIT_MAX}）`}>
              <Input value={limit} onChange={(e) => setLimit(e.target.value)} className="bg-background/40 border-border/40" />
            </Field>
            <Field label="重试范围">
              <Select value={retryFilter} onValueChange={setRetryFilter}>
                <SelectTrigger className="bg-background/40 border-border/40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RETRY_FILTERS.map((f) => (
                    <SelectItem key={f.value} value={f.value}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="搜索 title / slug">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="可选" className="bg-background/40 border-border/40" />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground/80">
            <input
              type="checkbox"
              checked={overwriteDraft}
              onChange={(e) => setOverwriteDraft(e.target.checked)}
            />
            覆盖已有 AI 草稿（默认跳过；human_reviewed / approved 始终不会被覆盖）
          </label>

          <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm space-y-2">
            {estimating ? (
              "预估中..."
            ) : estimate ? (
              <>
                <p>
                  当前筛选下符合条件 <strong>{estimate.eligible}</strong> 条，本次将处理
                  <strong> {estimate.wouldProcess}</strong> 条，
                  跳过 <strong>{estimate.wouldSkip}</strong> 条（超出 limit 部分）。
                </p>
                <p className="text-xs text-muted-foreground">
                  可重试：有失败记录 {estimate.retryableFailed} · QC 失败 {estimate.retryableQcFailed}
                  ｜范围内被排除：approved {estimate.skippedApproved} · human_reviewed {estimate.skippedHumanReviewed}
                  · 缺 raw 数据 {estimate.skippedMissingRaw} · 已有草稿 {estimate.skippedExistingDraft}
                  · 已在其它未完成批次 {estimate.skippedInActiveBatch}
                </p>
                {estimate.skippedInActiveBatch > 0 && (
                  <p className="text-xs text-orange-500">
                    有 {estimate.skippedInActiveBatch} 条已被其它未完成批次占用，本次不会重复选中
                    （避免同一条工具被改写两次、重复计费）。跑完或删除那些批次后即可再次选中。
                  </p>
                )}
                {estimate.skippedMissingRaw > 0 && (
                  <p className="text-xs text-orange-500">
                    有 {estimate.skippedMissingRaw} 条缺 raw_imported_content，需先修复 raw 数据后才能改写。
                  </p>
                )}
              </>
            ) : (
              "无法预估"
            )}
          </div>
        </div>
      )}

      {/* Step 2 */}
      {step === 2 && selectedProvider && (
        <div className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-6 space-y-4">
          <h2 className="text-lg font-semibold text-foreground">Step 2 · 选择模型</h2>
          <Field label="任务名称（可选）">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 kimi-batch-1" className="bg-background/40 border-border/40" />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="大模型服务">
              <Select value={providerId} onValueChange={setProviderId}>
                <SelectTrigger className="bg-background/40 border-border/40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label} · key: {p.keySource}
                      {p.enabled ? "" : "（已禁用）"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedProvider.mode === "batch" ? "Batch API 异步" : "直连同步"} · key 状态:{" "}
                <span className={cn(selectedProvider.keySource === "missing" ? "text-yellow-500" : "text-green-500")}>
                  {selectedProvider.keySource}
                </span>
              </p>
            </Field>
            <Field label="Model type（仅 UI/metadata）">
              <Select value={modelType} onValueChange={setModelType}>
                <SelectTrigger className="bg-background/40 border-border/40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="模型 ID（选 preset 或手动输入）">
            {selectedProvider.modelPresets.length > 0 && (
              <Select
                value={selectedProvider.modelPresets.includes(model) ? model : "__custom__"}
                onValueChange={(v) => setModel(v === "__custom__" ? "" : v)}
              >
                <SelectTrigger className="mb-2 bg-background/40 border-border/40">
                  <SelectValue placeholder="从 presets 选择" />
                </SelectTrigger>
                <SelectContent>
                  {selectedProvider.modelPresets.map((preset) => (
                    <SelectItem key={preset} value={preset}>
                      {preset}
                    </SelectItem>
                  ))}
                  <SelectItem value="__custom__">自定义模型 ID…</SelectItem>
                </SelectContent>
              </Select>
            )}
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={selectedProvider.model || "留空用默认"}
              className="bg-background/40 border-border/40"
            />
          </Field>
          {selectedProvider.keySource === "missing" && (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-700 dark:text-yellow-300">
              该 provider 缺少 key：仍可创建任务，但在详情页运行时会返回缺 key 错误。请先在
              Provider 配置中心配置 key。
            </div>
          )}
        </div>
      )}

      {/* Step 3 */}
      {step === 3 && selectedProvider && (
        <div className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-6 space-y-4">
          <h2 className="text-lg font-semibold text-foreground">Step 3 · 预估与确认</h2>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Info label="将处理" value={estimate ? String(estimate.wouldProcess) : "…"} />
            <Info label="将跳过" value={estimate ? String(estimate.wouldSkip) : "…"} />
            <Info label="Provider" value={selectedProvider.label} />
            <Info label="Model" value={model.trim() || selectedProvider.model || "(默认)"} />
            <Info label="Model type" value={modelType} />
            <Info label="预计成本" value="未估算" />
          </div>
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-700 dark:text-yellow-300">
            AI 改写可能产生 API 成本；结果只会保存为 AI 草稿，<strong>不会自动审核，不会自动发布</strong>。
          </div>
          <Button
            onClick={() => setConfirmOpen(true)}
            disabled={!estimate || estimate.wouldProcess === 0}
          >
            确认创建任务
          </Button>
        </div>
      )}

      {/* Step 4 */}
      {step === 4 && created && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-6 space-y-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-green-700 dark:text-green-300">
            <CheckCircle2 className="w-5 h-5" />
            任务已创建 — 批次 #{created.batchId}
          </h2>
          <p className="text-sm">共加入 {created.total} 条工具，等待运行改写。</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" asChild>
              <Link href={`/admin/tools/rewrite/${created.batchId}`}>查看任务详情</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/admin/tools/rewrite">返回改写任务列表</Link>
            </Button>
            <Button variant="outline" size="sm" disabled title="改写完成后可审核">
              去审核列表（改写完成后可用）
            </Button>
          </div>
        </div>
      )}

      {/* 步骤导航 */}
      {step < 4 && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            disabled={step === 1}
            className="gap-1"
          >
            <ChevronLeft className="w-4 h-4" />
            上一步
          </Button>
          {step < 3 && (
            <Button onClick={() => setStep((s) => s + 1)} className="gap-1">
              下一步
              <ChevronRight className="w-4 h-4" />
            </Button>
          )}
        </div>
      )}

      {/* 确认弹窗（无确认词） */}
      <Dialog open={confirmOpen} onOpenChange={(o) => !o && setConfirmOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认创建 AI 改写任务</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>将处理约 <strong>{estimate?.wouldProcess ?? 0}</strong> 条工具。</p>
            <p className="text-muted-foreground">
              Provider: {selectedProvider?.label} · Model: {model.trim() || selectedProvider?.model || "(默认)"} · Type: {modelType}
            </p>
            <p className="text-xs text-muted-foreground">
              可能产生 API 成本；结果只保存为草稿，不会自动审核或发布。服务端会重新校验资格。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>取消</Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? "创建中..." : "确认创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium mb-2 text-foreground/80">{label}</label>
      {children}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/20 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium text-foreground truncate">{value}</p>
    </div>
  );
}
