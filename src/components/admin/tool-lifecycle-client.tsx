"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, RefreshCw, Search } from "lucide-react";
import { Button } from "@/ui/common/button";
import { Badge } from "@/ui/common/badge";
import { Input } from "@/ui/common/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/ui/common/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils/utils";
import type {
  LifecycleEvent,
  LifecycleListItem,
  LifecycleStats,
} from "@/lib/website/tool-lifecycle";

/**
 * 生命周期观察页（A7）—— **只读**。
 *
 * 观察期（2 周）内刻意不提供任何修改/归档/下线按钮：这一阶段的唯一目的是
 * 看真实判定分布与误判率，然后才决定要不要把结论放到公开页。
 * 唯一的写操作是「建一个探测任务」，它只写 lifecycle/event 两张表。
 */

const REACH_STYLE: Record<string, string> = {
  ok: "bg-emerald-500/10 text-emerald-500 border-emerald-500/30",
  dead: "bg-red-500/10 text-red-500 border-red-500/30",
  unverifiable: "bg-amber-500/10 text-amber-500 border-amber-500/30",
  unknown: "bg-muted text-muted-foreground border-border/40",
};

const OUTCOME_STYLE: Record<string, string> = {
  ok: "text-emerald-500",
  deferred: "text-sky-500",
  blocked: "text-amber-500",
  unknown: "text-muted-foreground",
  unsafe_target: "text-fuchsia-500",
};

type ListResponse = {
  stats: LifecycleStats;
  breakdown: { errorKind: string; count: number }[];
  items: LifecycleListItem[];
  total: number;
  page: number;
  pageSize: number;
};

const REACH_TABS = [
  { key: "", label: "全部" },
  { key: "ok", label: "可访问" },
  { key: "dead", label: "失联" },
  { key: "unverifiable", label: "无法验证" },
  { key: "unknown", label: "未检查" },
];

export function ToolLifecycleClient({ initial }: { initial: ListResponse | null }) {
  const { toast } = useToast();
  const [data, setData] = useState<ListResponse | null>(initial);
  const [reach, setReach] = useState("");
  const [errorKind, setErrorKind] = useState("");
  const [tier, setTier] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [timeline, setTimeline] = useState<{ item: LifecycleListItem; events: LifecycleEvent[] } | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    async (nextPage = page) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ page: String(nextPage), pageSize: "50" });
        if (reach) params.set("reach", reach);
        if (errorKind) params.set("errorKind", errorKind);
        if (tier) params.set("tier", tier);
        if (search.trim()) params.set("search", search.trim());
        const res = await fetch(`/api/admin/tools/lifecycle?${params}`).then((r) => r.json());
        if (res?.code === 200) setData(res.data as ListResponse);
        else toast({ title: "加载失败", description: res?.message, variant: "destructive" });
      } finally {
        setLoading(false);
      }
    },
    [page, reach, errorKind, tier, search, toast]
  );

  useEffect(() => {
    void load(1);
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reach, errorKind, tier]);

  const openTimeline = async (item: LifecycleListItem) => {
    const res = await fetch(
      `/api/admin/tools/lifecycle/timeline?websiteId=${item.websiteId}`
    ).then((r) => r.json());
    if (res?.code === 200) setTimeline({ item, events: res.data as LifecycleEvent[] });
    else toast({ title: "加载事件失败", description: res?.message, variant: "destructive" });
  };

  const createJob = async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/admin/tools/lifecycle/job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then((r) => r.json());
      if (res?.code === 200) {
        toast({
          title: `已创建探测任务 #${res.data.jobId}`,
          description: `${res.data.total} 条到期工具，将由后台 worker 自动推进`,
        });
      } else {
        toast({ title: "创建失败", description: res?.message, variant: "destructive" });
      }
    } finally {
      setCreating(false);
    }
  };

  const stats = data?.stats;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/admin">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4" /> 返回
            </Button>
          </Link>
          <div>
            <h1 className="text-lg font-semibold">工具生命周期 · 可达性</h1>
            <p className="text-xs text-muted-foreground">
              观察期只读：不会修改工具状态、不影响公开页
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <a href="/api/admin/tools/lifecycle/export" download>
            <Button variant="outline" size="sm">
              <Download className="h-4 w-4" /> 导出失联清单
            </Button>
          </a>
          <Button size="sm" onClick={createJob} disabled={creating}>
            <RefreshCw className={cn("h-4 w-4", creating && "animate-spin")} />
            {creating ? "创建中..." : "探测到期工具"}
          </Button>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          <StatCard label="可访问" value={stats.ok} tone="ok" />
          <StatCard label="失联" value={stats.dead} tone="dead" />
          <StatCard label="无法验证" value={stats.unverifiable} tone="unverifiable" />
          <StatCard label="未检查" value={stats.unknown} tone="unknown" />
          <StatCard label="待人工核对" value={stats.needsManualCheck} />
          <StatCard label="从未探测" value={stats.neverChecked} />
          <StatCard label="当前到期" value={stats.dueNow} />
        </div>
      )}

      {data?.breakdown?.length ? (
        <div className="flex flex-wrap gap-1.5 rounded-lg border border-border/40 bg-background/20 p-3">
          <span className="text-xs text-muted-foreground">最近错误类型：</span>
          {data.breakdown.map((b) => (
            <button
              key={b.errorKind}
              onClick={() => setErrorKind(errorKind === b.errorKind ? "" : b.errorKind)}
              className={cn(
                "rounded border px-1.5 py-0.5 text-[11px]",
                errorKind === b.errorKind
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border/40 text-muted-foreground hover:text-foreground"
              )}
            >
              {b.errorKind} · {b.count}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {REACH_TABS.map((tab) => (
          <Button
            key={tab.key}
            size="sm"
            variant={reach === tab.key ? "default" : "outline"}
            onClick={() => setReach(tab.key)}
          >
            {tab.label}
          </Button>
        ))}
        <select
          value={tier}
          onChange={(e) => setTier(e.target.value)}
          className="h-8 rounded-md border border-border/40 bg-background/40 px-2 text-xs"
        >
          <option value="">全部分层</option>
          <option value="featured">featured</option>
          <option value="featured_candidate">featured_candidate</option>
          <option value="standard">standard</option>
          <option value="longtail">longtail</option>
        </select>
        <div className="flex items-center gap-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load(1)}
            placeholder="标题 / slug / URL"
            className="h-8 w-48 bg-background/40 text-xs"
          />
          <Button size="sm" variant="outline" onClick={() => load(1)}>
            <Search className="h-3.5 w-3.5" />
          </Button>
        </div>
        {(errorKind || tier || search) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setErrorKind("");
              setTier("");
              setSearch("");
            }}
          >
            清除筛选
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border/40">
        <table className="w-full min-w-[900px] text-xs">
          <thead className="bg-background/40 text-muted-foreground">
            <tr>
              <th className="p-2 text-left">工具</th>
              <th className="p-2 text-left">状态</th>
              <th className="p-2 text-left">最近错误</th>
              <th className="p-2 text-right">连续失败</th>
              <th className="p-2 text-right">独立日期</th>
              <th className="p-2 text-left">最后成功</th>
              <th className="p-2 text-left">最后探测</th>
              <th className="p-2 text-left">下次探测</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {data?.items.map((item) => (
              <tr key={item.websiteId} className="border-t border-border/30">
                <td className="p-2">
                  <div className="font-medium text-foreground">{item.title}</div>
                  <div className="truncate text-[11px] text-muted-foreground" title={item.url}>
                    {item.url}
                  </div>
                  {item.finalUrl && item.finalUrl !== item.url && (
                    <div className="truncate text-[11px] text-sky-500" title={item.finalUrl}>
                      → {item.finalUrl}
                    </div>
                  )}
                </td>
                <td className="p-2">
                  <Badge variant="outline" className={cn("text-[10px]", REACH_STYLE[item.reach])}>
                    {item.reach}
                  </Badge>
                  {item.needsManualCheck && (
                    <div className="mt-1 text-[10px] text-fuchsia-500">待人工核对</div>
                  )}
                  <div className="mt-0.5 text-[10px] text-muted-foreground">{item.tier}</div>
                </td>
                <td className="p-2 text-muted-foreground">{item.lastErrorKind ?? "—"}</td>
                <td className="p-2 text-right">{item.consecutiveFails}</td>
                <td className="p-2 text-right">{item.distinctFailDates}</td>
                <td className="p-2 text-muted-foreground">{fmt(item.lastOkAt)}</td>
                <td className="p-2 text-muted-foreground">{fmt(item.lastCheckedAt)}</td>
                <td className="p-2 text-muted-foreground">{fmt(item.nextCheckAt)}</td>
                <td className="p-2">
                  <Button size="sm" variant="ghost" onClick={() => openTimeline(item)}>
                    事件
                  </Button>
                </td>
              </tr>
            ))}
            {!data?.items.length && (
              <tr>
                <td colSpan={9} className="p-6 text-center text-muted-foreground">
                  {loading ? "加载中..." : "没有匹配的工具"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data && data.total > data.pageSize && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            共 {data.total} 条 · 第 {data.page}/{totalPages} 页
          </span>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={data.page <= 1 || loading}
              onClick={() => {
                setPage(data.page - 1);
                load(data.page - 1);
              }}
            >
              上一页
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={data.page >= totalPages || loading}
              onClick={() => {
                setPage(data.page + 1);
                load(data.page + 1);
              }}
            >
              下一页
            </Button>
          </div>
        </div>
      )}

      <Dialog open={Boolean(timeline)} onOpenChange={(open) => !open && setTimeline(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {timeline?.item.title} · 探测事件（最近 {timeline?.events.length ?? 0} 条）
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {timeline?.events.map((event) => (
              <div key={event.id} className="rounded-md border border-border/40 bg-background/20 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("font-medium", OUTCOME_STYLE[event.outcome] ?? "text-red-500")}>
                    {event.outcome}
                  </span>
                  {event.errorKind && (
                    <span className="text-muted-foreground">{event.errorKind}</span>
                  )}
                  {event.reachFrom !== event.reachTo && (
                    <Badge variant="outline" className="text-[10px]">
                      {event.reachFrom} → {event.reachTo}
                    </Badge>
                  )}
                  {event.changeFlags.map((flag) => (
                    <Badge key={flag} variant="outline" className="text-[10px] text-sky-500">
                      {flag}
                    </Badge>
                  ))}
                  <span className="ml-auto text-muted-foreground">
                    v{event.probeVersion} · {fmt(event.createdAt)}
                  </span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  {event.finalStatus !== null && <>HTTP {event.finalStatus} · </>}
                  {event.latencyMs !== null && <>{event.latencyMs}ms · </>}
                  {event.contentVerdict && <>{event.contentVerdict} · </>}
                  confidence {event.confidence}
                  {event.jobId && <> · job #{event.jobId}</>}
                </div>
                {event.finalUrl && (
                  <div className="mt-1 truncate text-muted-foreground" title={event.finalUrl}>
                    → {event.finalUrl}
                  </div>
                )}
                {event.evidence ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-muted-foreground">完整证据</summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded bg-background/40 p-2 text-[10px]">
                      {JSON.stringify(event.evidence, null, 2)}
                    </pre>
                  </details>
                ) : (
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    正常轮次，只存轻量证据
                  </div>
                )}
              </div>
            ))}
            {!timeline?.events.length && (
              <p className="p-4 text-center text-xs text-muted-foreground">暂无探测事件</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function fmt(value: string | null): string {
  if (!value) return "—";
  return value.slice(0, 16).replace("T", " ");
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: keyof typeof REACH_STYLE;
}) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/20 p-3 text-center">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-lg font-semibold",
          tone === "ok" && "text-emerald-500",
          tone === "dead" && "text-red-500",
          tone === "unverifiable" && "text-amber-500",
          !tone && "text-foreground"
        )}
      >
        {value}
      </p>
    </div>
  );
}
