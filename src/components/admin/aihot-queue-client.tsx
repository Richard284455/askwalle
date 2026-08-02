"use client";

import { useCallback, useEffect, useState } from "react";

import type { FamilyDetail, QueueRow, QueueTab } from "@/lib/content/publishing/queue";
import { QUEUE_TABS, TAB_LABEL } from "@/lib/content/publishing/queue";
import { REVIEW_CHECKLIST } from "@/lib/content/publishing/types";

/**
 * AI HOT 编辑审核队列。
 *
 * 这一页是内部视图：实际来源名称、来源指纹、QA 明细都要看得见。
 * 公开页把它们藏起来是产品决定，审核台藏起来只会让审核无从下手。
 *
 * **不提供任何编辑 AI HOT 原始输入的入口** —— 来源区块全是只读的。
 * 内容要改只能重新生成，那会造出新 revision 并作废旧的批准。
 */

const LOCALE_LABEL: Record<string, string> = {
  EN_US: "en-US", ES_ES: "es-ES", PT_BR: "pt-BR", JA_JP: "ja-JP",
};

const ISSUE_CATEGORIES = [
  "NO_ISSUE", "STYLE_ONLY", "TRUE_FACT_DRIFT", "TRANSLATION_QUALITY_ISSUE",
  "UNSUPPORTED_DETAIL", "ATTRIBUTION_ERROR", "SOURCE_INSUFFICIENT", "QA_FALSE_NEGATIVE",
] as const;

type Counts = Record<QueueTab, number>;

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data: T | null; message: string }> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const json = await res.json().catch(() => null);
  return {
    ok: res.ok && Boolean(json?.success),
    data: (json?.data ?? null) as T | null,
    message: json?.message ?? `HTTP ${res.status}`,
  };
}

export function AihotQueueClient({
  initialRows, initialCounts, initialTab, attributionMode,
}: {
  initialRows: QueueRow[];
  initialCounts: Counts;
  initialTab: QueueTab;
  attributionMode: { mode: string; requested: string; denied: boolean; authorization: string | null };
}) {
  const [tab, setTab] = useState<QueueTab>(initialTab);
  const [rows, setRows] = useState<QueueRow[]>(initialRows);
  const [counts, setCounts] = useState<Counts>(initialCounts);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<FamilyDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadTab = useCallback(async (next: QueueTab) => {
    setLoading(true);
    const r = await api<{ rows: QueueRow[]; counts: Counts }>(
      `/api/admin/content/aihot/queue?tab=${next}`
    );
    if (r.ok && r.data) { setRows(r.data.rows); setCounts(r.data.counts); }
    else setNotice(r.message);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (tab !== initialTab) void loadTab(tab);
  }, [tab, initialTab, loadTab]);

  const openDetail = useCallback(async (familyId: number) => {
    setOpenId(familyId);
    setDetail(null);
    const r = await api<FamilyDetail>(`/api/admin/content/aihot/family/${familyId}`);
    if (r.ok) setDetail(r.data);
    else setNotice(r.message);
  }, []);

  async function act(familyId: number, path: string, body?: unknown) {
    setBusy(true);
    setNotice(null);
    const r = await api<unknown>(`/api/admin/content/aihot/family/${familyId}/${path}`, {
      method: "POST", body: JSON.stringify(body ?? {}),
    });
    setNotice(r.ok ? `${path} 完成` : `${path} 失败：${r.message}`);
    setBusy(false);
    await loadTab(tab);
    if (r.ok) await openDetail(familyId);
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-8">
      <h1 className="text-2xl font-semibold">AI HOT 编辑审核队列</h1>
      <p className="mt-2 rounded-md border border-amber-400/60 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        Internal source metadata — not displayed publicly · 自动发布未启用，发布只能在本页手工触发
      </p>

      <div className="mt-3 rounded-md border border-border/70 p-3 text-sm">
        <div>公开归因模式：<strong>{attributionMode.mode}</strong>（请求值 {attributionMode.requested}）</div>
        {attributionMode.denied ? (
          <div className="mt-1 text-red-600">已请求 AIHOT_ONLY 但未登记书面授权，已 fail closed 回落默认模式。</div>
        ) : null}
        <div className="mt-1 text-muted-foreground">授权记录：{attributionMode.authorization ?? "（无）"}</div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {QUEUE_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              tab === t ? "border-primary bg-primary/10 font-medium" : "border-border/70"
            }`}
          >
            {TAB_LABEL[t]}
            <span className="ml-1.5 text-xs text-muted-foreground">{counts[t] ?? 0}</span>
          </button>
        ))}
      </div>

      {notice ? (
        <div className="mt-3 rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-sm">{notice}</div>
      ) : null}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[1150px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border/70 text-left">
              <th className="py-2 pr-3">#</th>
              <th className="py-2 pr-3">类型 / 模式</th>
              <th className="py-2 pr-3">英文母版</th>
              <th className="py-2 pr-3">四语言状态</th>
              <th className="py-2 pr-3">来源</th>
              <th className="py-2 pr-3">QA</th>
              <th className="py-2 pr-3">审核</th>
              <th className="py-2 pr-3">发布</th>
              <th className="py-2 pr-3" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="py-6 text-center text-muted-foreground">加载中…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={9} className="py-6 text-center text-muted-foreground">该栏目暂无内容</td></tr>
            ) : rows.map((r) => (
              <tr key={r.familyId} className="border-b border-border/40 align-top">
                <td className="py-2 pr-3">{r.familyId}</td>
                <td className="py-2 pr-3">
                  <div className="font-medium">{r.contentForm}</div>
                  <div className="text-xs text-muted-foreground">{r.unitKey}</div>
                  {r.hotTopicMode ? <div className="text-xs">模式 {r.hotTopicMode}</div> : null}
                </td>
                <td className="py-2 pr-3 max-w-[300px]">
                  <div className="line-clamp-2">{r.masterHeadline ?? "—"}</div>
                  <div className="text-xs text-muted-foreground">/{r.slug}</div>
                </td>
                <td className="py-2 pr-3">
                  <div className="flex flex-wrap gap-1">
                    {r.locales.map((l) => (
                      <span
                        key={l.locale}
                        title={`${l.status} · rev ${l.currentRevisionNumber ?? "-"}`}
                        className={`rounded px-1.5 py-0.5 text-xs ${
                          l.publishedPath ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
                          : l.approvedIsCurrent ? "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300"
                          : l.status === "REJECTED" ? "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300"
                          : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {LOCALE_LABEL[l.locale]}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="py-2 pr-3 max-w-[200px] text-xs">
                  <div className="break-words">{r.originalSourceName ?? "—"}</div>
                  <div className="text-muted-foreground">{r.sourceSnapshotHash.slice(0, 12)}</div>
                  <div className="text-muted-foreground">
                    {r.sourcePublishedAt ? r.sourcePublishedAt.toString().slice(0, 10) : "—"}
                  </div>
                </td>
                <td className="py-2 pr-3 text-xs">
                  {r.qaIssueCount ? <span className="text-red-600">{r.qaIssueCount} 项</span> : "通过"}
                </td>
                <td className="py-2 pr-3 text-xs">
                  {r.locales.filter((l) => l.reviewCount > 0).length}/4
                  {r.locales[0]?.lastReviewerType ? (
                    <div className="text-muted-foreground">{r.locales[0].lastReviewerType}</div>
                  ) : null}
                </td>
                <td className="py-2 pr-3 text-xs">{r.publishedCount}/4</td>
                <td className="py-2 pr-3">
                  <button
                    onClick={() => (openId === r.familyId ? setOpenId(null) : void openDetail(r.familyId))}
                    className="rounded border border-border/70 px-2 py-1 text-xs"
                  >
                    {openId === r.familyId ? "收起" : "详情"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openId !== null ? (
        <FamilyPanel
          detail={detail}
          busy={busy}
          onAct={(path, body) => act(openId, path, body)}
        />
      ) : null}
    </div>
  );
}

function FamilyPanel({
  detail, busy, onAct,
}: {
  detail: FamilyDetail | null;
  busy: boolean;
  onAct: (path: string, body?: unknown) => void;
}) {
  const [reviewerName, setReviewerName] = useState("");
  const [notes, setNotes] = useState("");
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [categories, setCategories] = useState<string[]>([]);

  if (!detail) {
    return <div className="mt-6 rounded-md border border-border/70 p-4 text-sm text-muted-foreground">加载详情…</div>;
  }

  const { row, source, contents, comparison } = detail;
  const allApproved = row.locales.every((l) => l.approvedIsCurrent);

  function review(locale: string, decision: "APPROVED" | "REJECTED" | "NEEDS_REVISION") {
    onAct("review", {
      locale, decision, reviewerName, notes,
      checklist: decision === "APPROVED" ? checks : undefined,
      issueCategories: categories,
    });
  }

  return (
    <div className="mt-6 rounded-md border border-border/70 p-4">
      <h2 className="text-lg font-semibold">#{row.familyId} · {row.unitKey}</h2>

      {/* ── 来源事实（只读）── */}
      <section className="mt-4">
        <h3 className="text-sm font-semibold">
          来源事实 <span className="font-normal text-muted-foreground">（AI HOT 原始输入，只读，不可编辑）</span>
        </h3>
        {source ? (
          <div className="mt-2 rounded border border-border/60 p-3 text-sm">
            <div className="font-medium">{source.title}</div>
            {source.summary ? <div className="mt-1 text-muted-foreground">{source.summary}</div> : null}
            <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
              {source.facts.map((f) => (
                <div key={f.label} className="flex gap-2">
                  <dt className="shrink-0 text-muted-foreground">{f.label}</dt>
                  <dd className="break-words">
                    {f.value}
                    {f.volatile ? <span className="ml-1 text-amber-600">（易变，不触发重写）</span> : null}
                  </dd>
                </div>
              ))}
            </dl>
            {source.sectionLabels.length ? (
              <div className="mt-2 text-xs">
                <div className="text-muted-foreground">栏目顺序（必须与译文一致）</div>
                <div>{source.sectionLabels.join(" · ")}</div>
              </div>
            ) : null}
            <div className="mt-2 break-all text-xs text-muted-foreground">
              AI HOT：{source.aihotUrl}
              {source.originalUrl ? <> · 原文：{source.originalUrl}</> : null}
              <> · 指纹 {source.snapshotHash.slice(0, 20)}</>
            </div>
          </div>
        ) : (
          <div className="mt-2 text-sm text-muted-foreground">未关联来源记录</div>
        )}
      </section>

      {/* ── 四语言并排 ── */}
      <section className="mt-5">
        <h3 className="text-sm font-semibold">四语言并排</h3>
        <div className="mt-2 grid grid-cols-1 gap-3 lg:grid-cols-4">
          {contents.map((c) => (
            <div key={c.locale} className="rounded border border-border/60 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{LOCALE_LABEL[c.locale]}</span>
                <span className="text-xs text-muted-foreground">
                  rev {c.currentRevisionNumber ?? "-"} · {c.status}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground break-all">{c.targetPath}</div>
              {c.publishedPath ? (
                <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">已发布 {c.publishedPath}</div>
              ) : null}
              <div className="mt-2 text-sm font-medium">{c.headline ?? "—"}</div>
              <div className="mt-1 text-xs text-muted-foreground">{c.summary ?? ""}</div>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">正文</summary>
                <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{c.body ?? ""}</pre>
              </details>

              {c.qaIssues.length ? (
                <div className="mt-2 text-xs text-red-600">
                  {c.qaIssues.map((i, n) => <div key={n}>[{i.code}] {i.detail}</div>)}
                </div>
              ) : (
                <div className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">QA 通过</div>
              )}

              <div className="mt-2 border-t border-border/50 pt-2 text-xs">
                <div>
                  审核：{c.reviewCount} 次
                  {c.lastReviewerType ? (
                    <span className={`ml-1 rounded px-1 ${
                      c.lastReviewerType === "HUMAN"
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
                        : "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
                    }`}>
                      {c.lastReviewerType}
                    </span>
                  ) : null}
                </div>
                {c.lastReviewerId ? (
                  <div className="text-muted-foreground">
                    {c.lastReviewerName ?? c.lastReviewerId} · {c.lastDecision ?? "—"} ·{" "}
                    {c.lastReviewedAt ? String(c.lastReviewedAt).slice(0, 19).replace("T", " ") : ""}
                  </div>
                ) : null}
                {c.lastNotes ? <div className="mt-1">备注：{c.lastNotes}</div> : null}
                {!c.approvedIsCurrent && c.approvedRevisionId ? (
                  <div className="mt-1 text-amber-600">批准的不是当前版本，需重新审核</div>
                ) : null}
              </div>

              <div className="mt-2 flex flex-wrap gap-1">
                <button disabled={busy} onClick={() => review(c.locale, "APPROVED")}
                  className="rounded border border-emerald-500/60 px-2 py-1 text-xs text-emerald-700 disabled:opacity-50 dark:text-emerald-400">批准</button>
                <button disabled={busy} onClick={() => review(c.locale, "NEEDS_REVISION")}
                  className="rounded border border-amber-500/60 px-2 py-1 text-xs text-amber-700 disabled:opacity-50 dark:text-amber-400">退回</button>
                <button disabled={busy} onClick={() => review(c.locale, "REJECTED")}
                  className="rounded border border-red-500/60 px-2 py-1 text-xs text-red-700 disabled:opacity-50 dark:text-red-400">拒绝</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── 对照 ── */}
      <section className="mt-5">
        <h3 className="text-sm font-semibold">
          数字 / 日期 / 模型 / 实体对照
          <span className="ml-2 font-normal text-muted-foreground">母版为准；红色表示该语言没找到</span>
        </h3>
        <div className="mt-2 max-h-80 overflow-auto rounded border border-border/60">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-background">
              <tr className="border-b border-border/60 text-left">
                <th className="px-2 py-1">维度</th>
                <th className="px-2 py-1">母版值</th>
                <th className="px-2 py-1">es-ES</th>
                <th className="px-2 py-1">pt-BR</th>
                <th className="px-2 py-1">ja-JP</th>
              </tr>
            </thead>
            <tbody>
              {comparison.length === 0 ? (
                <tr><td colSpan={5} className="px-2 py-3 text-muted-foreground">母版为空或无可对照的 token</td></tr>
              ) : comparison.map((c, i) => (
                <tr key={`${c.dimension}-${c.master}-${i}`} className="border-b border-border/30">
                  <td className="px-2 py-1 text-muted-foreground">{c.dimension}</td>
                  <td className="px-2 py-1 font-medium">{c.master}</td>
                  {(["ES_ES", "PT_BR", "JA_JP"] as const).map((l) => (
                    <td key={l} className={`px-2 py-1 ${c.present[l] ? "text-emerald-700 dark:text-emerald-400" : "text-red-600"}`}>
                      {c.present[l] ? "✓" : "✗"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 审核表单 ── */}
      <section className="mt-5 rounded border border-border/60 p-3">
        <h3 className="text-sm font-semibold">审核记录</h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-xs">
            审核人姓名（必填，记为 HUMAN 审核）
            <input value={reviewerName} onChange={(e) => setReviewerName(e.target.value)}
              className="mt-1 w-full rounded border border-border/70 bg-transparent px-2 py-1 text-sm" />
          </label>
          <label className="text-xs">
            备注
            <input value={notes} onChange={(e) => setNotes(e.target.value)}
              className="mt-1 w-full rounded border border-border/70 bg-transparent px-2 py-1 text-sm" />
          </label>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
          {REVIEW_CHECKLIST.map((c) => (
            <label key={c.key} className="flex items-center gap-2">
              <input type="checkbox" checked={Boolean(checks[c.key])}
                onChange={(e) => setChecks((p) => ({ ...p, [c.key]: e.target.checked }))} />
              {c.label}
            </label>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {ISSUE_CATEGORIES.map((c) => (
            <label key={c} className="flex items-center gap-1">
              <input type="checkbox" checked={categories.includes(c)}
                onChange={(e) => setCategories((p) => e.target.checked ? [...p, c] : p.filter((x) => x !== c))} />
              {c}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          十项未全部勾选时不能标记为 APPROVED；勾了实质问题分类同样不能批准。
        </p>
      </section>

      {/* ── family 级动作 ── */}
      <section className="mt-5 flex flex-wrap items-center gap-2">
        <button disabled={busy} onClick={() => onAct("regenerate")}
          className="rounded border border-border/70 px-3 py-1.5 text-sm disabled:opacity-50">
          重新生成（造新 revision）
        </button>
        <button disabled={busy || !allApproved} onClick={() => onAct("publish", { dryRun: true })}
          className="rounded border border-border/70 px-3 py-1.5 text-sm disabled:opacity-50">
          发布预检（dry-run）
        </button>
        <button disabled={busy || !allApproved} onClick={() => onAct("publish")}
          className="rounded border border-emerald-500/60 px-3 py-1.5 text-sm text-emerald-700 disabled:opacity-50 dark:text-emerald-400">
          手工发布已批准 revision
        </button>
        {!allApproved ? (
          <span className="text-xs text-muted-foreground">四种语言全部批准当前版本后才能发布</span>
        ) : null}
      </section>
    </div>
  );
}
