import { prisma } from "@/lib/prisma";

import { httpUrlOrNull } from "../aihot/types";

/**
 * 热点的发布门槛。
 *
 * 热点公开页必须真的说得清「这个热点是什么」。
 * AI HOT 的 `/api/v1/hot-topics` **不返回热点摘要** —— 只有标题、
 * 来源计数与来源名单。素材只够写一句标题加计数时，唯一诚实的做法是不发布：
 * 让模型去补技术、商业或事件细节，等于用编造去填公开页。
 *
 * 这条判定写成代码而不是靠人临场拍板 —— 它必须可复现、可回归。
 */

export const HOT_TOPIC_INSUFFICIENT = "HOT_TOPIC_INSUFFICIENT_FOR_PUBLICATION";

export type HotTopicEligibility =
  | { publishable: true; reason: null; evidence: HotTopicEvidence }
  | { publishable: false; reason: typeof HOT_TOPIC_INSUFFICIENT; missing: string[]; evidence: HotTopicEvidence };

export type HotTopicEvidence = {
  snapshotId: number;
  topicId: string;
  title: string;
  hasApiSummary: boolean;
  sourceCount: number | null;
  signalCount: number | null;
  sourceNameCount: number;
  relatedItemIds: number;
  /** 关联条目里**已入库**的精选数量 —— 这是唯一能带来真实内容的补充素材 */
  matchedSelectedItems: number;
  capturedAt: Date;
  attributionUrlValid: boolean;
};

/**
 * 「足以说明热点内容」的判定标准。
 *
 * 标题 + 计数 + 来源名单**不算**足够 —— 那正是任务里点名要拦下的情形。
 * 要放行，必须有真正描述性的素材：AI HOT 自己给的热点摘要，
 * 或者至少一条按**精确条目 ID** 关联上的精选（带标题与摘要）。
 * 按来源名去猜哪些精选属于这个热点是推断，不是信源给的事实，这里不做。
 */
export async function assessHotTopic(snapshotId: number): Promise<HotTopicEligibility> {
  const s = await prisma.aihotHotTopicSnapshot.findUnique({ where: { id: snapshotId } });
  if (!s) {
    return {
      publishable: false, reason: HOT_TOPIC_INSUFFICIENT,
      missing: [`热点快照 #${snapshotId} 不存在`],
      evidence: {
        snapshotId, topicId: "", title: "", hasApiSummary: false, sourceCount: null, signalCount: null,
        sourceNameCount: 0, relatedItemIds: 0, matchedSelectedItems: 0,
        capturedAt: new Date(0), attributionUrlValid: false,
      },
    };
  }

  const names = Array.isArray(s.source_names_json) ? (s.source_names_json as string[]) : [];
  const related = Array.isArray(s.related_item_ids_json) ? (s.related_item_ids_json as string[]) : [];
  const matched = related.length
    ? await prisma.aihotSelectedItem.count({ where: { provider_item_id: { in: related } } })
    : 0;
  const hasApiSummary = Boolean(s.summary && s.summary.trim().length >= 40);

  const evidence: HotTopicEvidence = {
    snapshotId: s.id, topicId: s.topic_id, title: s.title, hasApiSummary,
    sourceCount: s.source_count, signalCount: s.signal_count, sourceNameCount: names.length,
    relatedItemIds: related.length, matchedSelectedItems: matched,
    capturedAt: s.captured_at, attributionUrlValid: Boolean(httpUrlOrNull(s.aihot_url)),
  };

  const missing: string[] = [];
  if (!s.title?.trim()) missing.push("缺少明确标题");
  if (s.source_count === null) missing.push("缺少 source count");
  if (!names.length) missing.push("缺少 source names");
  if (!evidence.attributionUrlValid) missing.push("AI HOT attribution URL 非法");
  if (!hasApiSummary && matched === 0) {
    missing.push("素材只有标题与来源计数：API 未提供热点摘要，也没有按条目 ID 关联上的精选");
  }

  if (missing.length) return { publishable: false, reason: HOT_TOPIC_INSUFFICIENT, missing, evidence };
  return { publishable: true, reason: null, evidence };
}

/** 批量评估，供 pilot 选材与报告使用 */
export async function assessAllHotTopics(): Promise<HotTopicEligibility[]> {
  const all = await prisma.aihotHotTopicSnapshot.findMany({
    orderBy: [{ captured_at: "desc" }, { id: "desc" }],
    select: { id: true, topic_id: true },
  });
  const latest = new Map<string, number>();
  for (const s of all) if (!latest.has(s.topic_id)) latest.set(s.topic_id, s.id);
  return Promise.all([...latest.values()].map(assessHotTopic));
}
