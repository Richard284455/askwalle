import { prisma } from "@/lib/prisma";

import {
  clearSelectedCursor, ENDPOINTS, fetchAihot, LIMITS,
  loadSelectedCursor, saveSelectedCursor,
  type AihotClientOptions,
} from "./client";
import { deselectItem, ingestDaily, upsertSelectedBatch, upsertSelectedItem } from "./ingest";
import { isReportDate, type AihotItemDto } from "./types";

/**
 * AI HOT 精选的**全量回填 + 增量同步**。
 *
 * 两条路各司其职，别混：
 *   - `/selected/snapshot` 是**起点**，用 `page` 翻页，拿到完整历史；
 *   - `/selected/changes` 是**水位续传**，用 `cursor`，只拿新增/修改/取消精选。
 *
 * cursor 是流水账水位而不是会话票据 —— 存几天也不过期，离线再上线能续上。
 * 所以它必须落库，而且**每成功应用一页就立刻保存**：中途失败时，
 * 已经写进库的那部分不该再来一遍，没写的那部分一条也不能漏。
 *
 * 拿到 409 snapshot_required 说明水位已经不可用（服务端做过压缩/重建），
 * 唯一正确的反应是重做全量快照 —— 接口不会静默少给数据，我们也不该假装没事。
 */

export type SyncOptions = AihotClientOptions & {
  dryRun?: boolean;
  /** 单次最多翻多少页，防止异常情况下无限翻 */
  maxPages?: number;
};

export type SelectedSyncResult = {
  mode: "SNAPSHOT" | "CHANGES";
  status: "OK" | "SNAPSHOT_REQUIRED" | "FAILED";
  pages: number;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  skipped: number;
  cursor: string | null;
  message: string | null;
};

const emptySelected = (mode: SelectedSyncResult["mode"]): SelectedSyncResult => ({
  mode, status: "FAILED", pages: 0, fetched: 0, created: 0, updated: 0,
  unchanged: 0, removed: 0, skipped: 0, cursor: null, message: null,
});

// ── 全量回填 ──────────────────────────────────────────────────────────────

/**
 * 完整拉一遍精选历史。
 *
 * 用 `fields=default` 而不是 `minimal`：minimal 不返回 summary 与 links.original，
 * 而少了 summary 的条目在生成侧会因为「可用来源文本不足」被直接挡下 ——
 * 回填了三千条却一条也生成不了，等于白拉。
 */
export async function backfillSelected(opts: SyncOptions = {}): Promise<SelectedSyncResult> {
  const out = emptySelected("SNAPSHOT");
  const maxPages = opts.maxPages ?? 50;
  let page: string | null = null;
  let cursor: string | null = null;

  while (out.pages < maxPages) {
    const ep = ENDPOINTS.selectedSnapshot({ limit: LIMITS.snapshotPage, page });
    // 快照分页刻意不带 ETag：每页内容不同，共用一个键只会互相顶掉
    const res = await fetchAihot(ep.path, { ...opts, etag: null });
    if (!res.ok) return { ...out, message: res.reason };
    if (res.status === 304) break;

    const payload = res.data as {
      items?: AihotItemDto[]; cursor?: string; hasMore?: boolean; nextPage?: string;
    } | null;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    out.pages++;
    out.fetched += items.length;
    // 每页都带 cursor；最后保存的那个才是水位
    if (payload?.cursor) cursor = payload.cursor;

    // 整页批量写：逐条 upsert 要两趟远程往返 × 三千条，实测一个多小时
    const w = await upsertSelectedBatch(items, { dryRun: opts.dryRun });
    out.created += w.created;
    out.updated += w.updated;
    out.unchanged += w.unchanged;
    out.skipped += w.skipped;

    if (!payload?.hasMore || !payload.nextPage) break;
    page = payload.nextPage;
  }

  /*
   * 水位只在**全部页都成功写完**之后保存。
   * 中途保存会造成：前几页入库、水位却已推到末尾，中间那几页永远补不回来。
   */
  if (!opts.dryRun && cursor) await saveSelectedCursor(cursor);
  return { ...out, status: "OK", cursor };
}

// ── 增量 ──────────────────────────────────────────────────────────────────

type ChangeRecord =
  | { op: "upsert"; changedAt?: string; item: AihotItemDto }
  | { op: "remove"; changedAt?: string; id: string };

/**
 * 按水位拉增量。
 *
 * 没有水位（从没全量过）时返回 SNAPSHOT_REQUIRED —— 让调用方去做全量，
 * 而不是在这里偷偷改成「拉最近 24 小时」：那会静默漏掉历史，
 * 而漏掉的部分没有任何迹象可查。
 */
export async function syncSelectedChanges(opts: SyncOptions = {}): Promise<SelectedSyncResult> {
  const out = emptySelected("CHANGES");
  let cursor = await loadSelectedCursor();
  if (!cursor) {
    return { ...out, status: "SNAPSHOT_REQUIRED", message: "尚无同步水位，需要先做一次全量快照" };
  }

  const maxPages = opts.maxPages ?? 50;
  while (out.pages < maxPages) {
    const ep = ENDPOINTS.selectedChanges(cursor, LIMITS.changesPage);
    const res = await fetchAihot(ep.path, { ...opts, etag: null });
    if (!res.ok) {
      if (res.status === 409) {
        return { ...out, status: "SNAPSHOT_REQUIRED", cursor,
          message: "水位已失效（409 snapshot_required），需要重做全量快照" };
      }
      return { ...out, message: res.reason, cursor };
    }
    if (res.status === 304) break;

    const payload = res.data as { changes?: ChangeRecord[]; cursor?: string; hasMore?: boolean } | null;
    const changes = Array.isArray(payload?.changes) ? payload.changes : [];
    out.pages++;
    out.fetched += changes.length;

    for (const c of changes) {
      if (c?.op === "remove") {
        if (!opts.dryRun && c.id && (await deselectItem(c.id))) out.removed++;
        else if (opts.dryRun) out.removed++;
        continue;
      }
      if (c?.op === "upsert" && c.item) {
        const r = await upsertSelectedItem(c.item, { dryRun: opts.dryRun });
        if (r.outcome === "created") out.created++;
        else if (r.outcome === "updated") out.updated++;
        else if (r.outcome === "unchanged") out.unchanged++;
        else out.skipped++;
        continue;
      }
      out.skipped++;
    }

    /*
     * **每页成功应用后立刻推进水位。**
     * 攒到最后再存：中途失败时下一轮会从头重放，已经处理过的又来一遍；
     * 而如果先存后应用，失败的那页就永远跳过去了。先应用、后保存，
     * 最坏情况是重放一页 —— 而 upsert 本身是幂等的。
     */
    if (payload?.cursor) {
      cursor = payload.cursor;
      if (!opts.dryRun) await saveSelectedCursor(cursor);
    }
    if (!payload?.hasMore) break;
  }

  return { ...out, status: "OK", cursor };
}

/** 增量优先；水位不可用时自动回落到全量，并如实报告发生过回落 */
export async function syncSelected(
  opts: SyncOptions = {}
): Promise<{ result: SelectedSyncResult; bootstrapped: boolean }> {
  const incremental = await syncSelectedChanges(opts);
  if (incremental.status !== "SNAPSHOT_REQUIRED") return { result: incremental, bootstrapped: false };
  if (!opts.dryRun) await clearSelectedCursor();
  return { result: await backfillSelected(opts), bootstrapped: true };
}

// ── 日报全量 ──────────────────────────────────────────────────────────────

export type DailyBackfillResult = {
  status: "OK" | "FAILED";
  indexed: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  message: string | null;
};

/**
 * 按日期索引把所有能拿到的日报补齐。
 *
 * 索引最多给 180 天，再往前 API 不提供 —— 这是上游的边界，不是我们的选择，
 * 所以如实按索引给的日期集合来做，不去猜更早的日期。
 */
export async function backfillDailies(
  opts: SyncOptions & { days?: number; force?: boolean } = {}
): Promise<DailyBackfillResult> {
  const limit = Math.min(opts.days ?? LIMITS.dailyIndex, LIMITS.dailyIndex);
  const ep = ENDPOINTS.dailyIndex(limit);
  const res = await fetchAihot(ep.path, { ...opts, etag: null });
  if (!res.ok) {
    return { status: "FAILED", indexed: 0, created: 0, updated: 0, unchanged: 0, failed: 0, message: res.reason };
  }

  const payload = res.data as { items?: { date?: string }[] } | null;
  const dates = (Array.isArray(payload?.items) ? payload.items : [])
    .map((i) => i?.date)
    .filter(isReportDate);

  const out: DailyBackfillResult = {
    status: "OK", indexed: dates.length, created: 0, updated: 0, unchanged: 0, failed: 0, message: null,
  };

  // 已入库的日期先跳过，除非显式 force —— 回填不该把已有内容重新拉一遍
  const known = opts.force || opts.dryRun ? new Set<string>() : new Set(
    (await prisma.aihotDailyReport.findMany({ select: { report_date: true } })).map((d) => d.report_date)
  );

  for (const date of dates) {
    if (known.has(date)) { out.unchanged++; continue; }
    const r = await ingestDaily({ ...opts, date });
    if (r.status === "FAILED") out.failed++;
    else { out.created += r.created; out.updated += r.updated; out.unchanged += r.unchanged; }
  }
  return out;
}
