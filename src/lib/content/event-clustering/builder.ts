import crypto from "crypto";

import { Prisma, type SourceFactPack } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { canonicalize } from "@/lib/content/fact-pack/input-snapshot";

import { candidateKeyOf, planClusters, timeRangeOf, type ScoredPair } from "./cluster";
import { evaluateEventClusteringEligibility } from "./eligibility";
import { extractEventIdentifiers } from "./identifier-extract";
import { computePairFeatures, pairHashOf } from "./pair-features";
import { scoreEventSimilarity } from "./score";
import { normalizeEventTitle } from "./title-normalize";
import { resolveTimeSignal } from "./time-window";
import { computeDocumentIdentity } from "./url-identity";
import { MIN_PERSISTED_SCORE, RULE_VERSION, type ClusteringInput } from "./types";

/**
 * 事件候选发现。
 *
 * 不调 AI、不用 embedding、不发网络请求、不写 ResourceContent、
 * 不修改 SourceFactPack / Claim / Evidence。全部输入来自库里已有的 pack 快照。
 */

export type DiscoverResult = {
  status: "BUILT" | "EXISTING" | "DRY_RUN" | "NO_ELIGIBLE_INPUT" | "INFRA_ERROR";
  runId: number | null;
  ruleVersion: string;
  inputHash: string | null;
  inputPackCount: number;
  eligiblePackCount: number;
  pairCount: number;
  persistedEdgeCount: number;
  exactGroupCount: number;
  singletonCount: number;
  edgesByClassification: Record<string, number>;
  ineligible: { factPackId: number; reason: string }[];
  message: string | null;
};

/** pack → 聚类输入。全部字段取自 pack 快照，不回读 SourceItem/EnrichmentRun */
export function toClusteringInput(pack: SourceFactPack, publishedAtSource: string | null): ClusteringInput {
  const title = normalizeEventTitle(pack.document_title_snapshot);
  const identity = computeDocumentIdentity({
    canonicalUrl: pack.canonical_url_snapshot,
    finalUrl: pack.final_url_snapshot,
    requestedUrl: pack.requested_url_snapshot,
  });
  const time = resolveTimeSignal({
    documentPublishedAt: pack.document_published_at_snapshot,
    publishedAtSource,
    capturedAt: pack.captured_at,
  });
  return {
    factPackId: pack.id,
    publisher: pack.publisher_snapshot,
    sourceTier: pack.source_tier_snapshot,
    rawTitle: pack.document_title_snapshot ?? "",
    normalizedTitle: title.normalizedTitle,
    titleTokens: title.titleTokens,
    titleTokenSet: title.titleTokenSet,
    titleShingles: title.titleShingles,
    identifiers: extractEventIdentifiers(pack.document_title_snapshot),
    canonicalIdentity: identity.canonicalIdentity,
    finalIdentity: identity.finalIdentity,
    registrableDomain: identity.registrableDomain,
    normalizedPath: identity.normalizedPath,
    timeValue: time.timeValue,
    timeSource: time.timeSource,
    timeReliability: time.timeReliability,
  };
}

/**
 * 输入指纹。
 *
 * 只由「哪些 pack、各自的输入指纹、规则版本」决定 ——
 * pack 的传入顺序、JSON 键顺序都不得改变结果，否则同一批输入会反复建新 run。
 */
export function computeClusteringInputHash(
  packs: { id: number; input_hash: string }[],
  ruleVersion: string
): string {
  const payload = {
    ruleVersion,
    packs: [...packs]
      .sort((a, b) => a.id - b.id)
      .map((p) => ({ id: p.id, inputHash: p.input_hash })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
}

/** 每个 pack 的 published_at 溯源：从 claim 的 evidence origin 读，读不到按 NONE 处理 */
async function publishedAtSourcesOf(packIds: number[]): Promise<Map<number, string | null>> {
  const claims = await prisma.sourceFactClaim.findMany({
    where: { fact_pack_id: { in: packIds }, claim_key: "document.published_at" },
    select: { fact_pack_id: true, evidence: { select: { origin: true }, take: 1 } },
  });
  const out = new Map<number, string | null>();
  for (const id of packIds) out.set(id, null);
  for (const c of claims) out.set(c.fact_pack_id, c.evidence[0]?.origin ?? null);
  return out;
}

export async function discoverEventCandidates(args: {
  factPackIds: number[];
  ruleVersion?: string;
  apply?: boolean;
}): Promise<DiscoverResult> {
  const ruleVersion = args.ruleVersion ?? RULE_VERSION;
  const base: DiscoverResult = {
    status: "DRY_RUN", runId: null, ruleVersion, inputHash: null,
    inputPackCount: args.factPackIds.length, eligiblePackCount: 0, pairCount: 0,
    persistedEdgeCount: 0, exactGroupCount: 0, singletonCount: 0,
    edgesByClassification: {}, ineligible: [], message: null,
  };

  try {
    const packs = await prisma.sourceFactPack.findMany({
      where: { id: { in: args.factPackIds } },
      orderBy: { id: "asc" },
    });

    const eligible: SourceFactPack[] = [];
    for (const pack of packs) {
      const verdict = evaluateEventClusteringEligibility(pack);
      if (verdict.eligible) eligible.push(pack);
      else base.ineligible.push({ factPackId: pack.id, reason: verdict.reason });
    }
    base.eligiblePackCount = eligible.length;
    if (eligible.length < 1) {
      return { ...base, status: "NO_ELIGIBLE_INPUT", message: "没有符合资格的 Fact Pack" };
    }

    const inputHash = computeClusteringInputHash(eligible, ruleVersion);
    base.inputHash = inputHash;

    // 同一批输入 + 同一套规则 → 返回已有 run，不重复计算也不重复落库
    const existing = await prisma.eventClusteringRun.findUnique({
      where: { rule_version_input_hash: { rule_version: ruleVersion, input_hash: inputHash } },
    });
    if (existing && args.apply) {
      return {
        ...base, status: "EXISTING", runId: existing.id,
        pairCount: existing.pair_count, persistedEdgeCount: existing.persisted_edge_count,
        exactGroupCount: existing.exact_group_count, singletonCount: existing.singleton_count,
        message: `已有同输入的 run #${existing.id}`,
      };
    }
    // dry-run 仍照常算一遍（让人看到会得到什么），但要说清「加 --apply 不会产生新记录」
    if (existing) {
      base.runId = existing.id;
      base.message = `已有同输入的 run #${existing.id}；--apply 将返回它而不是新建`;
    }

    const sources = await publishedAtSourcesOf(eligible.map((p) => p.id));
    const inputs = eligible.map((p) => toClusteringInput(p, sources.get(p.id) ?? null));
    const byId = new Map(inputs.map((i) => [i.factPackId, i]));

    // 两两计算。顺序恒定：i < j 且 id 升序
    const scored: ScoredPair[] = [];
    for (let i = 0; i < inputs.length; i += 1) {
      for (let j = i + 1; j < inputs.length; j += 1) {
        const features = computePairFeatures(inputs[i], inputs[j]);
        scored.push({ features, score: scoreEventSimilarity(features) });
      }
    }
    base.pairCount = scored.length;

    const persisted = scored.filter(
      (p) => p.score.classification !== "NO_MATCH" && p.score.score >= MIN_PERSISTED_SCORE
    );
    base.persistedEdgeCount = persisted.length;
    for (const p of scored) {
      base.edgesByClassification[p.score.classification] =
        (base.edgesByClassification[p.score.classification] ?? 0) + 1;
    }

    const plan = planClusters(inputs.map((i) => i.factPackId), scored);
    base.exactGroupCount = plan.exactGroups.length;
    base.singletonCount = plan.singletons.length;

    if (!args.apply) return base;

    const runId = await prisma.$transaction(
      async (tx) => {
        const run = await tx.eventClusteringRun.create({
          data: {
            rule_version: ruleVersion,
            input_hash: inputHash,
            status: "COMPLETED",
            input_pack_count: args.factPackIds.length,
            eligible_pack_count: eligible.length,
            pair_count: scored.length,
            persisted_edge_count: persisted.length,
            exact_group_count: plan.exactGroups.length,
            singleton_count: plan.singletons.length,
            finished_at: new Date(),
            result_json: {
              edgesByClassification: base.edgesByClassification,
              ineligible: base.ineligible,
            } as Prisma.InputJsonValue,
          },
        });

        if (persisted.length) {
          await tx.eventSimilarityEdge.createMany({
            data: persisted.map((p) => ({
              clustering_run_id: run.id,
              left_fact_pack_id: p.features.leftPackId,
              right_fact_pack_id: p.features.rightPackId,
              rule_version: ruleVersion,
              pair_hash: pairHashOf(ruleVersion, p.features.leftPackId, p.features.rightPackId),
              score: p.score.score,
              classification: p.score.classification,
              reason_codes_json: p.score.reasonCodes as unknown as Prisma.InputJsonValue,
              features_json: canonicalize({
                ...p.features,
                sharedIdentifiers: p.features.sharedIdentifiers,
              }) as Prisma.InputJsonValue,
            })),
            skipDuplicates: true,
          });
        }

        // exact 分组与 singleton 各自建候选。fuzzy 边**不**产生成员。
        const groups: { type: "EXACT_DOCUMENT_GROUP" | "SINGLETON"; members: number[] }[] = [
          ...plan.exactGroups.map((m) => ({ type: "EXACT_DOCUMENT_GROUP" as const, members: m })),
          ...plan.singletons.map((m) => ({ type: "SINGLETON" as const, members: [m] })),
        ];

        for (const group of groups) {
          const members = group.members.map((id) => byId.get(id)!).filter(Boolean);
          const anchor = group.members[0];
          const range = timeRangeOf(members);
          const candidate = await tx.eventClusterCandidate.create({
            data: {
              clustering_run_id: run.id,
              candidate_key: candidateKeyOf(group.type, group.members),
              candidate_type: group.type,
              status: "PROPOSED",
              anchor_fact_pack_id: anchor,
              display_title_snapshot: byId.get(anchor)?.rawTitle?.slice(0, 500) ?? null,
              event_time_start: range.start,
              event_time_end: range.end,
              pack_count: group.members.length,
              publisher_count: new Set(members.map((m) => m.publisher)).size,
              rule_version: ruleVersion,
              reason_codes_json: [
                group.type === "SINGLETON" ? "NO_EXACT_DOCUMENT_PEER" : "EXACT_DOCUMENT_COMPONENT",
              ] as unknown as Prisma.InputJsonValue,
            },
          });
          await tx.eventClusterCandidateMember.createMany({
            data: group.members.map((id) => ({
              candidate_id: candidate.id,
              fact_pack_id: id,
              is_anchor: id === anchor,
              membership_basis: group.type === "SINGLETON" ? "SINGLETON" : "EXACT_DOCUMENT",
              membership_score: group.type === "SINGLETON" ? null : 100,
            })),
            skipDuplicates: true,
          });
        }
        return run.id;
      },
      { maxWait: 15_000, timeout: 120_000 }
    );

    return { ...base, status: "BUILT", runId };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("Unique constraint")) {
      const raced = await prisma.eventClusteringRun
        .findUnique({
          where: { rule_version_input_hash: { rule_version: ruleVersion, input_hash: base.inputHash ?? "" } },
        })
        .catch(() => null);
      if (raced) {
        return {
          ...base, status: "EXISTING", runId: raced.id,
          pairCount: raced.pair_count, persistedEdgeCount: raced.persisted_edge_count,
          exactGroupCount: raced.exact_group_count, singletonCount: raced.singleton_count,
          message: "并发执行，返回已存在的 run",
        };
      }
    }
    return { ...base, status: "INFRA_ERROR", message: message.slice(0, 300) };
  }
}

export { evaluateEventClusteringEligibility } from "./eligibility";
export { normalizeEventTitle, jaccard } from "./title-normalize";
export { computeDocumentIdentity, normalizeIdentity, registrableDomainOf } from "./url-identity";
export { extractEventIdentifiers } from "./identifier-extract";
export { resolveTimeSignal, hoursBetween } from "./time-window";
export { computePairFeatures, pairHashOf } from "./pair-features";
export { scoreEventSimilarity } from "./score";
export { planClusters, candidateKeyOf, timeRangeOf, type ScoredPair, type ClusterPlan } from "./cluster";
export * from "./types";
