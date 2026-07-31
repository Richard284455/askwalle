import { prisma } from "@/lib/prisma";
import type { SourceItemEnrichmentRun } from "@prisma/client";

import { evaluateSourceFactPackEligibility } from "./eligibility";

/**
 * 选出该条目**最新的可用**提取记录。
 *
 * 关键取舍：后来一次失败的提取**不作废**先前那次成功的结果。源站临时 403 或
 * 改版一次，不该让已经取到的完整正文凭空消失；我们回退到最近一条仍然可用的
 * 成功记录，并在 pack 里如实记下用的是哪一条、什么时候取的。
 *
 * 排序固定 started_at DESC, id DESC —— 必须确定性可复现。
 *
 * builder、CLI 与 BulkJob 共用这一个入口。各写一套查询迟早会漂移，
 * 而「pack 的全部字段来自同一次提取」是这套证据链的根本前提。
 */
export async function selectLatestUsableEnrichmentRun(
  sourceItemId: number,
  sourceEnabled = true
): Promise<SourceItemEnrichmentRun | null> {
  const runs = await prisma.sourceItemEnrichmentRun.findMany({
    where: { source_item_id: sourceItemId },
    orderBy: [{ started_at: "desc" }, { id: "desc" }],
    take: 50,
  });
  for (const run of runs) {
    if (evaluateSourceFactPackEligibility({ sourceItemId, sourceEnabled, run }).eligible) return run;
  }
  return null;
}

/**
 * 判资格时该看哪一条记录。
 *
 * 优先返回可用的那条；一条都不可用时退回**最近那一条**，只是为了给出真实的原因 ——
 * 否则一条 894 字的 THIN 记录会被报成「没有提取记录」，把人支去找一条根本不缺的 run。
 * 真的一条都没有时才返回 null。
 *
 * builder 与 CLI 共用这一个入口：各写一套查询迟早漂移，而「为什么不合格」
 * 正是操作者唯一会看的东西。
 */
export async function selectRunForEligibilityReport(
  sourceItemId: number,
  sourceEnabled = true
): Promise<SourceItemEnrichmentRun | null> {
  const usable = await selectLatestUsableEnrichmentRun(sourceItemId, sourceEnabled);
  if (usable) return usable;
  return prisma.sourceItemEnrichmentRun.findFirst({
    where: { source_item_id: sourceItemId },
    orderBy: [{ started_at: "desc" }, { id: "desc" }],
  });
}

/**
 * 候选提取记录是否比当前 pack 用的那条更新。
 * 同一条或更旧的一律返回 false —— 重复调用不该改变当前 pack。
 */
export function isNewerFactPackInput(
  candidate: { id: number; started_at: Date },
  current: { enrichment_run_id: number; captured_at: Date } | null
): boolean {
  if (!current) return true;
  if (candidate.id === current.enrichment_run_id) return false;
  const delta = candidate.started_at.getTime() - current.captured_at.getTime();
  if (delta !== 0) return delta > 0;
  // 时间戳相同时用 id 兜底，保证全序
  return candidate.id > current.enrichment_run_id;
}
