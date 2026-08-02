import { createHash } from "crypto";

import { prisma } from "@/lib/prisma";

/**
 * 受保护状态的**动态**基线。
 *
 * 写死绝对数量的核对活不过一个阶段：下一次正常增长就会让它假报失败，
 * 然后所有人开始忽略它。受保护的是「本任务**不该**碰的东西」，
 * 不是「数字必须永远是那个数」——所以基线在任务开始时读取并保存，
 * 任务结束时与同一份基线比对。
 *
 * 刻意不含 MultilingualDraft / ArticleFamily / Publication / AI HOT 三张来源表：
 * 那些正是本链路该增长的地方，锁死它们等于禁止工作本身。
 */

export const PROTECTED_BASELINE_KEY = "aihot:protected-baseline";

export type ProtectedState = {
  websiteUrlFingerprint: string;
  websiteStatusFingerprint: string;
  factPacks: number;
  factClaims: number;
  factEvidence: number;
  clusteringRuns: number;
  clusteringEdges: number;
  clusterCandidates: number;
  clusterMembers: number;
  lifecycle: number;
  resourceContent: number;
  sourceItems: number;
  contentSources: number;
  generatedArticles: number;
};

export async function readProtectedState(): Promise<ProtectedState> {
  const ws = await prisma.website.findMany({
    select: { id: true, url: true, status: true, active: true },
    orderBy: { id: "asc" },
  });
  /*
   * 逐个查，不并发十几路。
   * 连接池是共享的（本地还开着 dev server），一次打满会直接拿到 P1001，
   * 而那个报错看起来像「数据库挂了」，其实只是我们自己把池占满了。
   */
  const factPacks = await prisma.sourceFactPack.count();
  const factClaims = await prisma.sourceFactClaim.count();
  const factEvidence = await prisma.sourceFactEvidence.count();
  const clusteringRuns = await prisma.eventClusteringRun.count();
  const clusteringEdges = await prisma.eventSimilarityEdge.count();
  const clusterCandidates = await prisma.eventClusterCandidate.count();
  const clusterMembers = await prisma.eventClusterCandidateMember.count();
  const lifecycle = await prisma.toolLifecycleState.count();
  const resourceContent = await prisma.resourceContent.count();
  const sourceItems = await prisma.sourceItem.count();
  const contentSources = await prisma.contentSource.count();
  const generatedArticles = await prisma.generatedArticle.count();

  return {
    websiteUrlFingerprint: createHash("sha256")
      .update(ws.map((w) => `${w.id}|${w.url}`).join("\n")).digest("hex").slice(0, 16),
    websiteStatusFingerprint: createHash("sha256")
      .update(JSON.stringify(ws.map((w) => ({ id: w.id, status: w.status, active: w.active }))))
      .digest("hex").slice(0, 16),
    factPacks, factClaims, factEvidence,
    clusteringRuns, clusteringEdges, clusterCandidates, clusterMembers,
    lifecycle, resourceContent, sourceItems, contentSources, generatedArticles,
  };
}

export async function captureProtectedBaseline(): Promise<ProtectedState> {
  const now = await readProtectedState();
  await prisma.setting.upsert({
    where: { key: PROTECTED_BASELINE_KEY },
    create: { key: PROTECTED_BASELINE_KEY, value: JSON.stringify(now) },
    update: { value: JSON.stringify(now) },
  });
  return now;
}

export async function loadProtectedBaseline(): Promise<ProtectedState | null> {
  const row = await prisma.setting.findUnique({ where: { key: PROTECTED_BASELINE_KEY } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as ProtectedState;
  } catch {
    return null;
  }
}

export type BaselineDiff = { key: keyof ProtectedState; baseline: string | number; current: string | number };

export function diffProtectedState(baseline: ProtectedState, current: ProtectedState): BaselineDiff[] {
  const out: BaselineDiff[] = [];
  for (const key of Object.keys(current) as (keyof ProtectedState)[]) {
    if (baseline[key] !== current[key]) out.push({ key, baseline: baseline[key], current: current[key] });
  }
  return out;
}

/** event discovery 四张表的子集 —— 内容链路一行都不该动它们 */
export const EVENT_DISCOVERY_KEYS = [
  "clusteringRuns", "clusteringEdges", "clusterCandidates", "clusterMembers",
] as const satisfies readonly (keyof ProtectedState)[];

export type EventDiscoveryCounters = Pick<ProtectedState, (typeof EVENT_DISCOVERY_KEYS)[number]>;

export function eventDiscoveryOf(state: ProtectedState): EventDiscoveryCounters {
  return {
    clusteringRuns: state.clusteringRuns,
    clusteringEdges: state.clusteringEdges,
    clusterCandidates: state.clusterCandidates,
    clusterMembers: state.clusterMembers,
  };
}

export async function readEventDiscoveryCounters(): Promise<EventDiscoveryCounters> {
  return {
    clusteringRuns: await prisma.eventClusteringRun.count(),
    clusteringEdges: await prisma.eventSimilarityEdge.count(),
    clusterCandidates: await prisma.eventClusterCandidate.count(),
    clusterMembers: await prisma.eventClusterCandidateMember.count(),
  };
}

export function formatCounters(c: EventDiscoveryCounters): string {
  return `run=${c.clusteringRuns} edge=${c.clusteringEdges} cand=${c.clusterCandidates} member=${c.clusterMembers}`;
}
