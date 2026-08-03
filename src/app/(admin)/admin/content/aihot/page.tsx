import Link from "next/link";

import { redirect } from "next/navigation";

import { isAdminRequest } from "@/lib/auth/admin-auth";
import { AihotQueueClient } from "@/components/admin/aihot-queue-client";
import { resolveAttributionMode } from "@/lib/content/publishing/attribution";
import { loadQueue } from "@/lib/content/publishing/queue";
import { recentRuns } from "@/lib/content/aihot/scheduler";
import { residualLeases } from "@/lib/content/aihot/lease";
import { resolveNewsroomModel } from "@/lib/content/multilingual/model-settings";

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
  /*
   * **在取数之前先验身份。**
   *
   * 布局里的 redirect 挡不住这件事：App Router 会**并行**渲染 layout 与 page，
   * 页面的数据加载在 redirect 落地之前就已经发出去了。
   * 于是每一个未登录请求照样跑三趟深层查询 —— 连接池就是这么被打满的，
   * 报出来却是 P1001「数据库连不上」，看着像数据库的问题。
   *
   * 顺带也是一层纵深防御：未登录的调用方不该让服务器去算内部数据。
   */
  if (!(await isAdminRequest())) redirect("/login");

  /*
   * **逐个查，不并发。**
   *
   * 连接池是共享的（定时任务也在用），四路深层嵌套查询同时打出去会直接
   * 拿到 P1001 —— 而那个报错长得像「数据库挂了」，其实是我们自己把池占满了。
   * 这一页不是热路径，串行多花的几十毫秒没人察觉，打满连接池却会让整页报错。
   */
  const mode = await resolveAttributionMode();
  const model = await resolveNewsroomModel();
  const { rows, counts } = await loadQueue({ tab: "NEEDS_REVIEW" });
  const runs = await recentRuns(undefined, 12);
  const residual = await residualLeases();

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
        <div className="mb-6 rounded-md border border-border/70 p-3 text-sm">
          改写 / 翻译 / 摘要使用的模型：
          <strong>{model.provider}{model.model ? ` · ${model.model}` : "（服务商默认模型）"}</strong>
          {model.available ? null : (
            <span className="ml-2 text-red-600">不可用：{model.unavailableReason}</span>
          )}
          <Link href="/admin/settings/newsroom-model" className="ml-2 underline">修改</Link>
        </div>

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
