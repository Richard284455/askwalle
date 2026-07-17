"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { AlertTriangle, ArrowLeft, Plus, Sparkles } from "lucide-react";
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
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils/utils";
import type { AdminCategoryOption } from "@/lib/website/tool-admin";
import type {
  RewriteBatchSummary,
  RewriteProviderId,
  RewriteProviderInfo,
} from "@/lib/website/tool-rewrite-batch";

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
  providers,
  defaultProvider,
}: {
  initialBatches: RewriteBatchSummary[];
  categories: AdminCategoryOption[];
  providers: RewriteProviderInfo[];
  defaultProvider: RewriteProviderId;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<string>("all");
  const [limit, setLimit] = useState("20");
  const [includeRaw, setIncludeRaw] = useState(true);
  const [includeDraft, setIncludeDraft] = useState(false);
  const [creating, setCreating] = useState(false);
  const [providerId, setProviderId] = useState<string>(defaultProvider);
  const [model, setModel] = useState("");

  const selectedProvider =
    providers.find((provider) => provider.id === providerId) ?? providers[0];

  const handleCreate = async () => {
    if (creating) return;
    const parsedLimit = parseInt(limit, 10);
    if (Number.isNaN(parsedLimit) || parsedLimit <= 0 || parsedLimit > 20) {
      toast({
        title: "limit 无效",
        description: "limit 必须是 1-20 的整数（防止误创建大批量）",
        variant: "destructive",
      });
      return;
    }
    const rewriteStatuses = [
      ...(includeRaw ? ["raw_imported"] : []),
      ...(includeDraft ? ["draft_generated"] : []),
    ];
    if (!rewriteStatuses.length) {
      toast({
        title: "请选择 rewrite_status 范围",
        description: "至少勾选 raw_imported 或 draft_generated",
        variant: "destructive",
      });
      return;
    }

    setCreating(true);
    try {
      const response = await fetch("/api/admin/tools/rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          categoryId: categoryId === "all" ? undefined : parseInt(categoryId),
          limit: parsedLimit,
          rewriteStatuses,
          provider: providerId,
          model: model.trim() || undefined,
        }),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.code === 200) {
        toast({
          title: "批次已创建",
          description: `批次 #${data.data.batchId}，共 ${data.data.total} 条`,
        });
        router.push(`/admin/tools/rewrite/${data.data.batchId}`);
      } else {
        toast({
          title: "创建失败",
          description: data?.message || "请重试",
          variant: "destructive",
        });
      }
    } catch {
      toast({ title: "创建失败", description: "请重试", variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

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
            批量 AI 改写
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            多 provider 可配置（OpenAI / DeepSeek / Qwen / Kimi）· 结果只写入草稿，须人工审核后才能发布
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/tools" className="flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            返回工具管理
          </Link>
        </Button>
      </div>

      {selectedProvider && !selectedProvider.hasKey && (
        <div className="flex items-center gap-3 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-700 dark:text-yellow-300">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          {selectedProvider.label} 未配置 {selectedProvider.keyEnv}
          ：可以创建批次并生成/预览 JSONL，但提交会返回 &quot;Missing {selectedProvider.keyEnv}&quot;。
          请在服务端 .env 中配置后重启。
        </div>
      )}

      <div className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-6 space-y-4">
        <h2 className="text-lg font-semibold text-foreground">创建批量改写任务</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground/80">
              大模型服务
            </label>
            <Select value={providerId} onValueChange={setProviderId}>
              <SelectTrigger className="bg-background/40 border-border/40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.label}
                    {provider.hasKey ? " ✓" : "（未配置 key）"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedProvider && (
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedProvider.mode === "batch"
                  ? "Batch API 异步"
                  : "直连同步"}
                · key: {selectedProvider.keySource}
                {selectedProvider.enabled ? "" : " · 已禁用"}
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground/80">
              模型 ID（可选 presets 或手动输入）
            </label>
            {selectedProvider && selectedProvider.modelPresets.length > 0 && (
              <Select
                value={
                  selectedProvider.modelPresets.includes(model) ? model : "__custom__"
                }
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
              placeholder={selectedProvider?.model ?? "留空用默认"}
              className="bg-background/40 border-border/40"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground/80">
              批次名称（可选）
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 first-rewrite-batch"
              className="bg-background/40 border-border/40"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground/80">
              分类
            </label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger className="bg-background/40 border-border/40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部分类</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id.toString()}>
                    {category.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground/80">
              Limit（最大 20）
            </label>
            <Input
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className="bg-background/40 border-border/40"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground/80">
              rewrite_status 范围
            </label>
            <div className="flex flex-col gap-1.5 text-sm text-foreground/80">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={includeRaw}
                  onChange={(e) => setIncludeRaw(e.target.checked)}
                />
                raw_imported
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={includeDraft}
                  onChange={(e) => setIncludeDraft(e.target.checked)}
                />
                draft_generated（重写已有草稿）
              </label>
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          只会选取 status=pending 的工具；human_reviewed 与 approved 自动排除。
        </p>
        <Button onClick={handleCreate} disabled={creating} className="gap-2">
          <Plus className="w-4 h-4" />
          {creating ? "创建中..." : "创建批次"}
        </Button>
      </div>

      <div className="rounded-xl border border-border/40 bg-background/30 shadow-sm overflow-hidden backdrop-blur-sm">
        <div className="border-b border-border/40 bg-background/20 p-4">
          <h2 className="text-lg font-semibold text-foreground">历史批次</h2>
        </div>
        <div className="bg-background/20 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>总数</TableHead>
                <TableHead>QC 通过/失败</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initialBatches.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-10">
                    暂无批次
                  </TableCell>
                </TableRow>
              ) : (
                initialBatches.map((batch) => (
                  <TableRow key={batch.id}>
                    <TableCell>{batch.id}</TableCell>
                    <TableCell className="max-w-[180px] truncate">
                      {batch.name || "—"}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "text-sm font-medium",
                          BATCH_STATUS_COLORS[batch.status] ?? ""
                        )}
                      >
                        {batch.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {batch.provider} / {batch.model}
                    </TableCell>
                    <TableCell>{batch.totalCount}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="px-2 py-0 text-[11px]">
                        {batch.qcPassedCount} / {batch.qcFailedCount}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {batch.createdAt.slice(0, 16).replace("T", " ")}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/admin/tools/rewrite/${batch.id}`}>详情</Link>
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
