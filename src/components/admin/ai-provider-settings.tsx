"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Plug,
  RefreshCw,
  Save,
} from "lucide-react";
import { Button } from "@/ui/common/button";
import { Badge } from "@/ui/common/badge";
import { Input } from "@/ui/common/input";
import { Textarea } from "@/ui/common/textarea";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils/utils";
import type { ProviderSettingsView } from "@/lib/website/ai-provider-config";

function ProviderCard({
  provider,
  onSaved,
}: {
  provider: ProviderSettingsView;
  onSaved: (updated: ProviderSettingsView) => void;
}) {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(provider.enabled);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [defaultModel, setDefaultModel] = useState(provider.defaultModel);
  const [presets, setPresets] = useState(provider.modelPresets.join(", "));
  const [notes, setNotes] = useState(provider.notes);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const call = async (
    action: string,
    url: string,
    method: string,
    body?: unknown
  ): Promise<{ code: number; data: unknown; message?: string } | null> => {
    setBusy(action);
    try {
      const response = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return await response.json().catch(() => null);
    } catch {
      return null;
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async () => {
    const data = await call(
      "save",
      `/api/admin/settings/ai-providers/${provider.providerKey}`,
      "PUT",
      {
        enabled,
        baseUrl,
        defaultModel,
        modelPresets: presets,
        notes,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      }
    );
    if (data?.code === 200) {
      setApiKey("");
      onSaved(data.data as ProviderSettingsView);
      toast({ title: "已保存", description: provider.displayName });
    } else {
      toast({
        title: "保存失败",
        description: data?.message || "请重试",
        variant: "destructive",
      });
    }
  };

  const handleClearKey = async () => {
    const data = await call(
      "clear",
      `/api/admin/settings/ai-providers/${provider.providerKey}`,
      "PUT",
      { clearApiKey: true }
    );
    if (data?.code === 200) {
      onSaved(data.data as ProviderSettingsView);
      toast({ title: "已清除 DB key", description: provider.displayName });
    } else {
      toast({ title: "操作失败", description: data?.message, variant: "destructive" });
    }
  };

  const handleTest = async () => {
    const data = await call(
      "test",
      `/api/admin/settings/ai-providers/${provider.providerKey}/test`,
      "POST"
    );
    if (data?.code === 200) {
      toast({ title: "连接成功", description: provider.displayName });
    } else {
      toast({
        title: "连接失败",
        description: data?.message || "请检查 key / base URL",
        variant: "destructive",
      });
    }
  };

  const handleSync = async () => {
    const data = await call(
      "sync",
      `/api/admin/settings/ai-providers/${provider.providerKey}/sync-models`,
      "POST"
    );
    if (data?.code === 200) {
      const payload = data.data as { message: string };
      toast({ title: "同步完成", description: payload.message });
      // 同步后刷新该卡片的 presets
      const refreshed = await fetch("/api/admin/settings/ai-providers")
        .then((r) => r.json())
        .catch(() => null);
      if (refreshed?.code === 200) {
        const updated = (refreshed.data as ProviderSettingsView[]).find(
          (p) => p.providerKey === provider.providerKey
        );
        if (updated) {
          setPresets(updated.modelPresets.join(", "));
          onSaved(updated);
        }
      }
    } else {
      toast({
        title: "同步失败",
        description: data?.message || "已保留手动 presets",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-foreground">
            {provider.displayName}
          </h2>
          <Badge variant="outline" className="text-[11px]">
            {provider.mode === "batch" ? "Batch API" : "直连"}
          </Badge>
          {provider.supportsJsonSchema && (
            <Badge variant="outline" className="text-[11px]">
              JSON Schema
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              "text-[11px]",
              provider.keyStatus === "configured"
                ? "border-green-500/30 text-green-600 dark:text-green-400"
                : "border-yellow-500/30 text-yellow-600 dark:text-yellow-400"
            )}
          >
            {provider.keyStatus === "configured"
              ? `key: ${provider.keySource}${provider.keyLast4 ? ` ····${provider.keyLast4}` : ""}`
              : "key 未配置"}
          </Badge>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            enabled
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-2 text-foreground/80">
            Base URL
          </label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={provider.defaultBaseUrl || "https://..."}
            className="bg-background/40 border-border/40"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2 text-foreground/80">
            默认模型 ID
          </label>
          <Input
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder="如 deepseek-chat / qwen-plus"
            className="bg-background/40 border-border/40"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2 text-foreground/80">
          Model presets（逗号或换行分隔的模型 ID）
        </label>
        <Textarea
          value={presets}
          onChange={(e) => setPresets(e.target.value)}
          rows={2}
          placeholder="deepseek-chat, deepseek-reasoner"
          className="bg-background/40 border-border/40 font-mono text-xs"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-2 text-foreground/80">
            API key（保存后加密入库；留空不变）
          </label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              provider.masterKeyConfigured
                ? "粘贴 key 后点保存"
                : "缺 AI_PROVIDER_CREDENTIAL_KEY，无法保存 DB key"
            }
            disabled={!provider.masterKeyConfigured}
            autoComplete="off"
            className="bg-background/40 border-border/40"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2 text-foreground/80">
            备注（可选）
          </label>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="bg-background/40 border-border/40"
          />
        </div>
      </div>

      {provider.lastTestStatus && (
        <p className="text-xs text-muted-foreground">
          上次测试: {provider.lastTestStatus}
          {provider.lastTestedAt
            ? ` @ ${provider.lastTestedAt.slice(0, 16).replace("T", " ")}`
            : ""}
          {provider.lastTestError ? ` — ${provider.lastTestError}` : ""}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={handleSave} disabled={busy !== null} className="gap-2">
          <Save className="w-4 h-4" />
          保存
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleTest}
          disabled={busy !== null}
          className="gap-2"
        >
          <Plug className="w-4 h-4" />
          测试连接
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleSync}
          disabled={busy !== null}
          className="gap-2"
        >
          <RefreshCw className="w-4 h-4" />
          同步模型列表
        </Button>
        {provider.keySource === "db" && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearKey}
            disabled={busy !== null}
            className="text-red-500 hover:text-red-600"
          >
            清除 DB key
          </Button>
        )}
      </div>
    </div>
  );
}

export function AIProviderSettings({
  initialProviders,
}: {
  initialProviders: ProviderSettingsView[];
}) {
  const [providers, setProviders] = useState(initialProviders);
  const masterKeyConfigured =
    initialProviders[0]?.masterKeyConfigured ?? false;

  const updateProvider = (updated: ProviderSettingsView) => {
    setProviders((prev) =>
      prev.map((p) => (p.providerKey === updated.providerKey ? updated : p))
    );
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="container max-w-4xl mx-auto px-4 sm:px-6 py-4 sm:py-6 min-h-[calc(100vh-4rem)] space-y-6"
    >
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-background/30 backdrop-blur-sm p-6 rounded-xl border border-border/40">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-foreground">
            AI Provider 配置中心
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            配置各大模型服务的 key、base URL、默认模型与模型列表
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/tools/rewrite" className="flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            返回批量改写
          </Link>
        </Button>
      </div>

      <div
        className={cn(
          "flex items-center gap-3 rounded-xl border p-4 text-sm",
          masterKeyConfigured
            ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300"
            : "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300"
        )}
      >
        {masterKeyConfigured ? (
          <CheckCircle2 className="w-5 h-5 shrink-0" />
        ) : (
          <AlertTriangle className="w-5 h-5 shrink-0" />
        )}
        {masterKeyConfigured
          ? "AI_PROVIDER_CREDENTIAL_KEY 已配置，可加密保存后台输入的 API key。"
          : "未配置 AI_PROVIDER_CREDENTIAL_KEY：可编辑 base URL / 模型，但无法在后台保存 API key（请用 env 环境变量，或配置该 master key 后重启）。"}
      </div>

      {providers.map((provider) => (
        <ProviderCard
          key={provider.providerKey}
          provider={provider}
          onSaved={updateProvider}
        />
      ))}
    </motion.div>
  );
}
