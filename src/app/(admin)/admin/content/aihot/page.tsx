import { prisma } from "@/lib/prisma";
import { resolveAttributionMode } from "@/lib/content/publishing/attribution";
import { httpUrlOrNull } from "@/lib/content/aihot/types";
import { LOCALES } from "@/lib/content/publishing/types";

/**
 * 后台的 AI HOT 来源元数据视图。
 *
 * 公开页已经不再展示实际信源，但这些信息**没有被删除或匿名化** ——
 * 生成、忠实度 QA、审计与追溯都依赖它，只是不对外呈现。
 * 这一页就是它唯一的查看入口。
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = { title: "AI HOT 来源元数据", robots: { index: false, follow: false } };

export default async function AihotSourcePage() {
  const mode = await resolveAttributionMode();
  const families = await prisma.articleFamily.findMany({
    orderBy: { id: "asc" },
    include: {
      translations: {
        include: { publications: { where: { status: "PUBLISHED" }, select: { locale: true, path: true } } },
      },
    },
  });
  const snapshots = await prisma.aihotHotTopicSnapshot.findMany({
    select: { id: true, topic_id: true, source_name: true, source_names_json: true },
  });
  const snapById = new Map(snapshots.map((s) => [s.id, s]));

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">AI HOT 来源元数据</h1>
      <p className="mt-2 rounded-md border border-amber-400/60 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        Internal source metadata — not displayed publicly
      </p>

      <div className="mt-4 rounded-md border border-border/70 p-3 text-sm">
        <div>公开归因模式：<strong>{mode.mode}</strong>（请求值 {mode.requested}）</div>
        {mode.deniedForMissingAuthorization ? (
          <div className="mt-1 text-red-600">
            已请求 AIHOT_ONLY，但**未登记书面授权**，已 fail closed 回落到默认模式。
          </div>
        ) : null}
        <div className="mt-1 text-muted-foreground">
          授权记录：{mode.authorizationReference ?? "（无）"}
        </div>
      </div>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[1100px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border/70 text-left">
              <th className="py-2 pr-3">#</th>
              <th className="py-2 pr-3">体裁 / 单元</th>
              <th className="py-2 pr-3">实际来源名称</th>
              <th className="py-2 pr-3">原始来源地址</th>
              <th className="py-2 pr-3">AI HOT 地址</th>
              <th className="py-2 pr-3">来源发布时间</th>
              <th className="py-2 pr-3">来源指纹</th>
              <th className="py-2 pr-3">归因校验</th>
              <th className="py-2 pr-3">已发布</th>
            </tr>
          </thead>
          <tbody>
            {families.map((f) => {
              const snap = f.hot_topic_snapshot_id ? snapById.get(f.hot_topic_snapshot_id) : null;
              const names = Array.isArray(snap?.source_names_json) ? (snap!.source_names_json as string[]) : [];
              const published = f.translations.flatMap((t) => t.publications.map((p) => p.locale));
              const attrOk = Boolean(httpUrlOrNull(f.attribution_url));
              const srcOk = f.original_source_url === null || Boolean(httpUrlOrNull(f.original_source_url));
              return (
                <tr key={f.id} className="border-b border-border/40 align-top">
                  <td className="py-2 pr-3">{f.id}</td>
                  <td className="py-2 pr-3">
                    <div className="font-medium">{f.content_form}</div>
                    <div className="text-xs text-muted-foreground">{f.unit_key}</div>
                    {f.hot_topic_mode ? <div className="text-xs">模式 {f.hot_topic_mode}</div> : null}
                  </td>
                  <td className="py-2 pr-3">
                    <div>{f.original_source_name ?? "—"}</div>
                    {names.length ? (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          榜单来源名单（{names.length}）
                        </summary>
                        <div className="mt-1 text-xs">{names.join(" · ")}</div>
                      </details>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 break-all text-xs">{f.original_source_url ?? "—"}</td>
                  <td className="py-2 pr-3 break-all text-xs">{f.attribution_url}</td>
                  <td className="py-2 pr-3 text-xs">
                    {f.source_published_at ? f.source_published_at.toISOString() : "—"}
                  </td>
                  <td className="py-2 pr-3 break-all text-xs">{f.source_snapshot_hash.slice(0, 20)}</td>
                  <td className="py-2 pr-3 text-xs">
                    <div>{attrOk ? "AI HOT ✅" : "AI HOT ❌"}</div>
                    <div>{srcOk ? "原文 ✅" : "原文 ❌"}</div>
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    {published.length ? `${published.length}/${LOCALES.length}` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
