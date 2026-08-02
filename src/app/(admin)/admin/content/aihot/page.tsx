import { AihotQueueClient } from "@/components/admin/aihot-queue-client";
import { resolveAttributionMode } from "@/lib/content/publishing/attribution";
import { listQueue, queueCounts } from "@/lib/content/publishing/queue";
import { recentRuns } from "@/lib/content/aihot/scheduler";
import { residualLeases } from "@/lib/content/aihot/lease";

/**
 * AI HOT 编辑审核队列。
 *
 * 公开页已经不再展示实际信源，但这些信息**没有被删除或匿名化** ——
 * 生成、忠实度 QA、审计与追溯都依赖它，只是不对外呈现。
 * 这一页是它唯一的查看入口，也是唯一的发布入口：
 * 定时任务只负责把内容送进队列，发不发由人在这里决定。
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = { title: "AI HOT 编辑审核队列", robots: { index: false, follow: false } };

export default async function AihotQueuePage() {
  const mode = await resolveAttributionMode();
  const [rows, counts, runs, residual] = await Promise.all([
    listQueue({ tab: "NEEDS_REVIEW" }),
    queueCounts(),
    recentRuns(undefined, 12),
    residualLeases(),
  ]);

  return (
    <>
      <AihotQueueClient
        initialRows={rows}
        initialCounts={counts}
        initialTab="NEEDS_REVIEW"
        attributionMode={{
          mode: mode.mode,
          requested: mode.requested,
          denied: mode.deniedForMissingAuthorization,
          authorization: mode.authorizationReference,
        }}
      />

      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10">
        <h2 className="text-lg font-semibold">定时任务运行审计</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          三类任务各自独立调度与租约：热点 5 分钟、精选 10 分钟、日报 30 分钟。
          「发布」一列必须恒为 0 —— 定时任务不发布。
        </p>
        {residual.length ? (
          <p className="mt-2 rounded-md border border-red-400/60 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            存在未释放的租约：{residual.map((l) => `${l.task_type}@${l.locked_by}`).join("、")}
          </p>
        ) : null}
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[1000px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-border/70 text-left">
                <th className="py-2 pr-3">开始</th>
                <th className="py-2 pr-3">任务</th>
                <th className="py-2 pr-3">结果</th>
                <th className="py-2 pr-3">耗时</th>
                <th className="py-2 pr-3">取/新/改/复用</th>
                <th className="py-2 pr-3">304</th>
                <th className="py-2 pr-3">429 / 5xx</th>
                <th className="py-2 pr-3">provider</th>
                <th className="py-2 pr-3">QA 过/未过</th>
                <th className="py-2 pr-3">新版本 / 入队</th>
                <th className="py-2 pr-3">发布</th>
                <th className="py-2 pr-3">说明</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 ? (
                <tr><td colSpan={12} className="py-4 text-center text-muted-foreground">尚无运行记录</td></tr>
              ) : runs.map((r) => (
                <tr key={r.id} className="border-b border-border/40 align-top">
                  <td className="py-1.5 pr-3">{r.started_at.toISOString().slice(0, 19).replace("T", " ")}</td>
                  <td className="py-1.5 pr-3">{r.task_type}</td>
                  <td className="py-1.5 pr-3">
                    {r.status}
                    {r.lease_conflict ? <span className="ml-1 text-muted-foreground">（租约冲突）</span> : null}
                  </td>
                  <td className="py-1.5 pr-3">{r.duration_ms ?? "-"}ms</td>
                  <td className="py-1.5 pr-3">{r.fetched}/{r.created}/{r.updated}/{r.reused}</td>
                  <td className="py-1.5 pr-3">{r.not_modified}</td>
                  <td className="py-1.5 pr-3">{r.rate_limited} / {r.server_error}</td>
                  <td className="py-1.5 pr-3">{r.provider_calls}</td>
                  <td className="py-1.5 pr-3">{r.qa_passed}/{r.qa_failed}</td>
                  <td className="py-1.5 pr-3">{r.revisions_created} / {r.queued_for_review}</td>
                  <td className={`py-1.5 pr-3 ${r.publications_created ? "font-semibold text-red-600" : ""}`}>
                    {r.publications_created}
                  </td>
                  <td className="py-1.5 pr-3 max-w-[280px] break-words">
                    {r.error_code ? <span className="text-red-600">[{r.error_code}] </span> : null}
                    {r.message ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
