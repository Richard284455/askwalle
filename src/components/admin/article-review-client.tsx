"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import type { ReviewListItem } from "@/lib/content/article-gen/review";

/**
 * 资讯草稿审核台。
 *
 * 链路：从指定信源获取 → 生成文章 → **人工审核后发布**。
 * 这一页只回答「这篇能不能发」，不做真实性核实，也不做重复性核实 ——
 * 内容与既有文章重复不是拒绝理由。
 */

const TABS = [
  { key: "pending", label: "待审核", match: ["DRAFTED", "FAITHFULNESS_REVIEW"] },
  { key: "ready", label: "待发布", match: ["READY_TO_PUBLISH"] },
  { key: "published", label: "已发布", match: ["PUBLISHED"] },
  { key: "blocked", label: "未通过", match: ["REJECTED_BY_REVIEWER", "FAITHFULNESS_FAILED", "SOURCE_INSUFFICIENT", "GENERATION_FAILED", "PUBLICATION_FAILED"] },
] as const;

const STATUS_LABEL: Record<string, string> = {
  DRAFTED: "草稿",
  FAITHFULNESS_REVIEW: "待复核",
  READY_TO_PUBLISH: "待发布",
  PUBLISHED: "已发布",
  REJECTED_BY_REVIEWER: "人工退回",
  FAITHFULNESS_FAILED: "忠实度未通过",
  SOURCE_INSUFFICIENT: "来源信息不足",
  GENERATION_FAILED: "生成失败",
  PUBLICATION_FAILED: "发布失败",
};

export function ArticleReviewClient({ initial }: { initial: ReviewListItem[] }) {
  const [items, setItems] = useState(initial);
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("pending");
  const [openId, setOpenId] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [category, setCategory] = useState("AI News");

  const active = TABS.find((t) => t.key === tab)!;
  const visible = useMemo(
    () => items.filter((i) => (active.match as readonly string[]).includes(i.status)),
    [items, active]
  );

  async function act(id: number, action: "approve" | "reject" | "publish", notes?: string) {
    setBusy(id);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/content/articles/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, notes, category }),
      });
      const json = await res.json();
      if (!res.ok || json?.code !== 0) {
        setNotice(json?.message ?? "操作失败");
        return;
      }
      const listed = await fetch("/api/admin/content/articles").then((r) => r.json());
      if (listed?.code === 0) setItems(listed.data as ReviewListItem[]);
      setNotice(json.data?.message ?? "已完成");
    } catch {
      setNotice("请求失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="space-y-2">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">资讯草稿审核</h1>
          <Link href="/admin" className="text-sm text-muted-foreground hover:underline">
            返回后台
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">
          草稿依据指定信源改写而成。审核判断的是「这篇能不能发」——
          系统不核实信源陈述的真实性，也不因内容与既有文章重复而拒绝。
        </p>
      </header>

      <nav className="flex gap-2 border-b">
        {TABS.map((t) => {
          const count = items.filter((i) => (t.match as readonly string[]).includes(i.status)).length;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm transition ${
                tab === t.key
                  ? "border-b-2 border-primary font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
              <span className="ml-1.5 text-xs opacity-60">{count}</span>
            </button>
          );
        })}
      </nav>

      {notice && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm">
          {notice}
        </div>
      )}

      {tab === "ready" && (
        <label className="flex items-center gap-2 text-sm">
          发布分类
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-md border bg-background px-2 py-1"
          />
        </label>
      )}

      {visible.length === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">该状态下暂无草稿</p>
      )}

      <ul className="space-y-4">
        {visible.map((a) => (
          <li key={a.id} className="rounded-lg border p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <h2 className="font-medium">{a.headline ?? "（无标题）"}</h2>
                <p className="text-sm text-muted-foreground">{a.shortSummary}</p>
                <p className="text-xs text-muted-foreground">
                  {a.publisher} · {a.mode === "FULL_SOURCE" ? "完整来源" : "订阅简讯"} ·{" "}
                  {STATUS_LABEL[a.status] ?? a.status}
                  {a.qaVerdict && ` · 忠实度 ${a.qaVerdict === "PASSED" ? "通过" : `${a.qaIssueCount} 个问题`}`}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => setOpenId(openId === a.id ? null : a.id)}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                >
                  {openId === a.id ? "收起" : "查看"}
                </button>
                {(a.status === "DRAFTED" || a.status === "FAITHFULNESS_REVIEW") && (
                  <>
                    <button
                      disabled={busy === a.id}
                      onClick={() => act(a.id, "approve")}
                      className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
                    >
                      通过
                    </button>
                    <button
                      disabled={busy === a.id}
                      onClick={() => act(a.id, "reject")}
                      className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                    >
                      退回
                    </button>
                  </>
                )}
                {a.status === "READY_TO_PUBLISH" && (
                  <button
                    disabled={busy === a.id}
                    onClick={() => act(a.id, "publish")}
                    className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
                  >
                    发布
                  </button>
                )}
                {a.resourceContentId && (
                  <Link
                    href={`/admin/resources`}
                    className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                  >
                    已发布内容
                  </Link>
                )}
              </div>
            </div>

            {openId === a.id && (
              <div className="mt-4 space-y-4 border-t pt-4 text-sm">
                <section>
                  <h3 className="mb-1 font-medium">正文</h3>
                  <p className="whitespace-pre-wrap text-muted-foreground">{a.body}</p>
                </section>

                <section>
                  <h3 className="mb-1 font-medium">信源</h3>
                  <p className="text-muted-foreground">
                    {a.publisher} · {a.sourcePublishedAt?.slice(0, 10) ?? "无发布时间"}
                  </p>
                  <a
                    href={a.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all text-primary hover:underline"
                  >
                    {a.sourceUrl}
                  </a>
                  <p className="mt-1 text-muted-foreground">原标题：{a.sourceTitle}</p>
                </section>

                {a.factMapping.length > 0 && (
                  <section>
                    <h3 className="mb-1 font-medium">事实对照</h3>
                    <ul className="space-y-1 text-muted-foreground">
                      {a.factMapping.map((m, i) => (
                        <li key={i} className="border-l-2 pl-2">
                          <span className="text-foreground">{m.fact}</span>
                          <br />
                          <span className="text-xs">← {m.sourceEvidence}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1 text-xs text-muted-foreground">
                      对照关系由生成模型自行标注，仅作定位线索，未经逐条校验。
                    </p>
                  </section>
                )}

                {a.qaIssues.length > 0 && (
                  <section>
                    <h3 className="mb-1 font-medium">忠实度问题</h3>
                    <ul className="space-y-1">
                      {a.qaIssues.map((q, i) => (
                        <li key={i} className="text-amber-600 dark:text-amber-500">
                          {q.code}：{q.detail}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
