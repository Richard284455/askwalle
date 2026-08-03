"use client";

import Link from "next/link";
import { useState } from "react";

import type { NewsroomModelResolution } from "@/lib/content/multilingual/model-settings";

/**
 * Newsroom 使用的模型。
 *
 * 这条链路的三件事 —— 英文母版改写、三种译文、简报摘要 —— **共用一个模型**。
 * 刻意不做分模型配置：翻译漂移的判定基准是母版，两端换模型会让
 * 「这处差异是翻译问题还是模型差异」再也说不清。
 */

export type ModelOption = {
  providerKey: string;
  displayName: string;
  enabled: boolean;
  hasApiKey: boolean;
  keySource: string;
  defaultModel: string;
  models: string[];
};

export function NewsroomModelSettings({
  initialCurrent, initialOptions,
}: {
  initialCurrent: NewsroomModelResolution;
  initialOptions: ModelOption[];
}) {
  const [current, setCurrent] = useState(initialCurrent);
  const [provider, setProvider] = useState(initialCurrent.provider);
  const [model, setModel] = useState(initialCurrent.model ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const selected = initialOptions.find((o) => o.providerKey === provider);
  const usable = Boolean(selected?.enabled && selected?.hasApiKey);

  async function save() {
    setBusy(true);
    setNotice(null);
    const res = await fetch("/api/admin/settings/newsroom-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, model: model.trim() || null }),
    });
    const json = await res.json().catch(() => null);
    if (res.ok && json?.success) {
      setCurrent(json.data as NewsroomModelResolution);
      setNotice("已保存。下一次生成即刻生效；已生成的草稿不受影响。");
    } else {
      setNotice(`保存失败：${json?.message ?? `HTTP ${res.status}`}`);
    }
    setBusy(false);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Newsroom 使用的模型</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Trending / AI Updates / Daily Briefing 三个板块在<strong>改写、翻译、撰写摘要</strong>时使用的模型。
        忠实度 QA 不使用模型（数字、日期、型号、实体是确定性比对），换模型不影响它。
      </p>

      <div className="mt-5 rounded-md border border-border/70 p-4 text-sm">
        <div className="font-medium">当前生效</div>
        <div className="mt-1">
          {current.provider}
          {current.model ? ` · ${current.model}` : "（使用该服务商的默认模型）"}
          <span className="ml-2 text-xs text-muted-foreground">
            {current.source === "setting" ? "来自后台设置" : "未设置，使用内置默认值"}
          </span>
        </div>
        {current.available ? (
          <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">服务商可用</div>
        ) : (
          <div className="mt-1 text-xs text-red-600">
            不可用：{current.unavailableReason}
            <div className="mt-1">
              生成会<strong>如实失败并留下记录</strong>，不会自动换成别的模型 ——
              悄悄换掉意味着某天的稿子是另一个模型写的，而审计里看不出痕迹。
            </div>
          </div>
        )}
      </div>

      <div className="mt-6 space-y-4">
        <label className="block text-sm">
          <span className="font-medium">服务商</span>
          <select
            value={provider}
            onChange={(e) => {
              const next = e.target.value;
              setProvider(next as typeof provider);
              // 换服务商时清掉模型，避免把 A 的模型 ID 留给 B
              setModel("");
            }}
            className="mt-1 w-full rounded border border-border/70 bg-transparent px-3 py-2 text-sm"
          >
            {initialOptions.map((o) => (
              <option key={o.providerKey} value={o.providerKey}>
                {o.displayName}
                {!o.enabled ? "（已停用）" : !o.hasApiKey ? "（缺少密钥）" : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="font-medium">模型</span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="mt-1 w-full rounded border border-border/70 bg-transparent px-3 py-2 text-sm"
          >
            <option value="">（使用该服务商的默认模型{selected?.defaultModel ? `：${selected.defaultModel}` : ""}）</option>
            {(selected?.models ?? []).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-muted-foreground">
            列表来自「AI 服务商」里登记的模型。要用刚发布的新模型，先在那一页把它加进预设。
          </span>
        </label>

        {!usable ? (
          <p className="rounded-md border border-amber-400/60 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            该服务商当前不可用，保存会被拒绝。请先到{" "}
            <Link href="/admin/settings/ai-providers" className="underline">AI 服务商</Link>{" "}
            启用并配置密钥。
          </p>
        ) : null}

        <button
          onClick={save}
          disabled={busy}
          className="rounded border border-emerald-500/60 px-4 py-2 text-sm text-emerald-700 disabled:opacity-50 dark:text-emerald-400"
        >
          {busy ? "保存中…" : "保存"}
        </button>

        {notice ? (
          <div className="rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-sm">{notice}</div>
        ) : null}
      </div>

      <div className="mt-8 rounded-md border border-border/70 p-4 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">改了之后会发生什么</div>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>下一次生成立即使用新模型；<strong>已生成的草稿与已发布内容不受影响</strong>。</li>
          <li>已发布页面要换模型重写，需要在审核台上显式点「重新生成」，那会造出新 revision 并作废旧的批准。</li>
          <li>母版与三种译文始终用同一个模型 —— 两端不一致会让翻译漂移的判定失去基准。</li>
        </ul>
      </div>
    </div>
  );
}
