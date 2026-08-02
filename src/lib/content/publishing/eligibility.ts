import type { HotTopicBriefMode } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { httpUrlOrNull } from "../aihot/types";

/**
 * 热点简报的模式判定。
 *
 * **不再有「信息不足就不生成」这道门禁。** 每个最新热点快照都要出四语言简报。
 *
 * 素材少不是不生成的理由，但它决定**写法**：
 *   - SIGNAL   只有标题、排名、来源计数与名单 → 如实写成「榜单信号简报」，
 *              明确交代信息边界，不补任何事件细节；
 *   - ENRICHED 另有 API 摘要或能按条目 ID 精确关联的已入库精选 → 可以用这些材料。
 *
 * 判定只看**素材是否存在**，不看热点重不重要、是不是真的 ——
 * 那两件事都不在这条链路的职责里。
 */

export type HotTopicMaterial = {
  snapshotId: number;
  topicId: string;
  title: string;
  rank: number | null;
  sourceCount: number | null;
  signalCount: number | null;
  sourceNames: string[];
  capturedAt: Date;
  latestAt: Date | null;
  aihotUrl: string;
  originalUrl: string | null;
  representativeSourceName: string | null;
  /** API 给出的热点摘要；多数情况下没有 */
  apiSummary: string | null;
  /** story 的 AI 摘要（GET /api/v1/stories/{publicId}）。有它就够写一篇有内容的简报 */
  storyDigest: string | null;
  /** story 的报道时间线，只含 AI HOT 自己给出的标题/摘要字段 */
  storyReports: { title: string; summary: string | null; sourceName: string | null; publishedAt: string | null }[];
  /** 按**精确条目 ID** 关联上的已入库精选。不按来源名猜 */
  relatedItems: { title: string; summary: string | null; sourceName: string | null; aihotUrl: string | null }[];
  mode: HotTopicBriefMode;
  attributionUrlValid: boolean;
  /** 入库时算出的内容指纹。preflight 用它确认「冻结那一版对应的来源没变」 */
  snapshotHash: string;
};

const MIN_SUMMARY_CHARS = 40;

export async function loadHotTopicMaterial(snapshotId: number): Promise<HotTopicMaterial | null> {
  const s = await prisma.aihotHotTopicSnapshot.findUnique({ where: { id: snapshotId } });
  if (!s) return null;

  const names = Array.isArray(s.source_names_json) ? (s.source_names_json as string[]) : [];
  const relatedIds = Array.isArray(s.related_item_ids_json) ? (s.related_item_ids_json as string[]) : [];
  const related = relatedIds.length
    ? await prisma.aihotSelectedItem.findMany({
        where: { provider_item_id: { in: relatedIds } },
        select: { title: true, summary: true, source_name: true, aihot_url: true },
      })
    : [];

  const apiSummary = s.summary && s.summary.trim().length >= MIN_SUMMARY_CHARS ? s.summary.trim() : null;
  const storyDigest = s.story_digest && s.story_digest.trim().length >= MIN_SUMMARY_CHARS
    ? s.story_digest.trim() : null;
  const storyReports = (Array.isArray(s.story_reports_json) ? s.story_reports_json : []) as unknown as
    { title: string; summary: string | null; sourceName: string | null; publishedAt: string | null }[];
  /*
   * story 的 digest 是真正的事件摘要 —— 有它就不再是「只有标题的榜单信号」。
   * 素材丰富度决定写法，这一条与 apiSummary、关联精选同级。
   */
  const mode: HotTopicBriefMode = apiSummary || storyDigest || related.length ? "ENRICHED" : "SIGNAL";

  return {
    snapshotId: s.id, topicId: s.topic_id, title: s.title, rank: s.rank,
    sourceCount: s.source_count, signalCount: s.signal_count, sourceNames: names,
    capturedAt: s.captured_at, latestAt: s.latest_at,
    aihotUrl: s.aihot_url, originalUrl: httpUrlOrNull(s.original_url),
    representativeSourceName: s.source_name,
    apiSummary,
    storyDigest,
    storyReports,
    relatedItems: related.map((r) => ({
      title: r.title, summary: r.summary, sourceName: r.source_name, aihotUrl: httpUrlOrNull(r.aihot_url),
    })),
    mode,
    attributionUrlValid: Boolean(httpUrlOrNull(s.aihot_url)),
    snapshotHash: s.source_snapshot_hash,
  };
}

/** 每个 topic 的最新快照。榜单与简报都以它为准 */
export async function latestSnapshotIds(): Promise<number[]> {
  const all = await prisma.aihotHotTopicSnapshot.findMany({
    orderBy: [{ captured_at: "desc" }, { id: "desc" }],
    select: { id: true, topic_id: true },
  });
  const latest = new Map<string, number>();
  for (const s of all) if (!latest.has(s.topic_id)) latest.set(s.topic_id, s.id);
  return [...latest.values()];
}

export async function loadAllLatestMaterial(): Promise<HotTopicMaterial[]> {
  const ids = await latestSnapshotIds();
  const out: HotTopicMaterial[] = [];
  for (const id of ids) {
    const m = await loadHotTopicMaterial(id);
    if (m) out.push(m);
  }
  return out.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
}

/**
 * 热点内容单元的业务身份键。
 *
 * **按 topic 而不是按快照。** 热点会持续变化，若把快照指纹编进 key，
 * 每次变化都会造出一个新 family，同一个热点散成一堆互不相干的条目，
 * 「这个热点的简报」就再也指不到唯一一篇。
 * 内容变化通过新 revision 表达，不是通过新 family。
 */
export function hotTopicUnitKey(topicId: string): string {
  return `topic:${topicId}`;
}

/**
 * 会影响文章事实的输入字段。
 *
 * **刻意不含排名。** 排名天天变，而简报正文并不逐字复述名次；
 * 把它算进来会让每次榜单抖动都触发一次重写，白烧 provider 调用。
 * 排名的变化由实时卡片承载。
 *
 * 入库指纹（snapshotHash）已经覆盖标题、来源计数、信号数、来源名单与摘要，
 * 这里只是把「哪些字段算数」写成可测的一份清单，并补上关联精选 ——
 * 后者取决于本站已入库了什么，AI HOT 的指纹不会反映它。
 */
export function hotTopicFactFingerprint(m: HotTopicMaterial): string {
  return [
    m.title,
    m.sourceCount ?? "",
    m.signalCount ?? "",
    m.sourceNames.join("|"),
    m.apiSummary ?? "",
    // digest 会随事件被重写，是事实字段，必须进指纹
    m.storyDigest ?? "",
    m.relatedItems.map((r) => r.title).join("|"),
  ].join("§");
}
