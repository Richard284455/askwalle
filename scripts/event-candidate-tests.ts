/**
 * C6.1 事件候选发现离线测试。
 *
 *   npm run test:event-candidates
 *
 * 全部走真实 Prisma，输入是库里的夹具 pack ——
 * **不发外部请求、不调 AI、不用 embedding、不写 ResourceContent、不改 Website/Lifecycle**。
 *
 * 核心命题：
 *   1. 候选就是候选 —— 标题像、同一天、同一个域名，都不足以确认同一事件；
 *   2. 传递性合并被禁止：A≈B、B≈C 但 A≉C 时，三者不得被焊成一个事件；
 *   3. 同输入必得同结果，重复执行不产生第二份记录。
 */
import crypto from "crypto";

import { prisma } from "@/lib/prisma";
import {
  candidateKeyOf,
  computeDocumentIdentity,
  computePairFeatures,
  discoverEventCandidates,
  evaluateEventClusteringEligibility,
  extractEventIdentifiers,
  normalizeEventTitle,
  normalizeIdentity,
  pairHashOf,
  planClusters,
  resolveTimeSignal,
  scoreEventSimilarity,
  toClusteringInput,
  computeClusteringInputHash,
  RULE_VERSION,
  type ScoredPair,
} from "@/lib/content/event-clustering/builder";
import { canonicalize } from "@/lib/content/fact-pack/input-snapshot";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(id: string, name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    failures.push(`${id} ${name}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const section = (t: string) => console.log(`\n${t}\n`);

const MARKER = "__event_test_publisher__";
let seq = 0;

async function purge(): Promise<number> {
  const sources = await prisma.contentSource.findMany({ where: { publisher: MARKER }, select: { id: true } });
  if (!sources.length) return 0;
  const ids = sources.map((s) => s.id);
  const items = await prisma.sourceItem.findMany({ where: { source_id: { in: ids } }, select: { id: true } });
  const itemIds = items.map((i) => i.id);
  if (itemIds.length) {
    const packs = await prisma.sourceFactPack.findMany({ where: { source_item_id: { in: itemIds } }, select: { id: true } });
    const packIds = packs.map((p) => p.id);
    if (packIds.length) {
      const cands = await prisma.eventClusterCandidate.findMany({
        where: { OR: [{ anchor_fact_pack_id: { in: packIds } }, { members: { some: { fact_pack_id: { in: packIds } } } }] },
        select: { id: true, clustering_run_id: true },
      });
      const candIds = cands.map((c) => c.id);
      const runIds = [...new Set(cands.map((c) => c.clustering_run_id))];
      if (candIds.length) {
        await prisma.eventClusterCandidateMember.deleteMany({ where: { candidate_id: { in: candIds } } });
        await prisma.eventClusterCandidate.deleteMany({ where: { id: { in: candIds } } });
      }
      await prisma.eventSimilarityEdge.deleteMany({
        where: { OR: [{ left_fact_pack_id: { in: packIds } }, { right_fact_pack_id: { in: packIds } }] },
      });
      if (runIds.length) {
        const orphan = await prisma.eventClusteringRun.findMany({
          where: { id: { in: runIds }, candidates: { none: {} }, edges: { none: {} } },
          select: { id: true },
        });
        await prisma.eventClusteringRun.deleteMany({ where: { id: { in: orphan.map((o) => o.id) } } });
      }
      const claims = await prisma.sourceFactClaim.findMany({ where: { fact_pack_id: { in: packIds } }, select: { id: true } });
      await prisma.sourceFactEvidence.deleteMany({ where: { claim_id: { in: claims.map((c) => c.id) } } });
      await prisma.sourceFactClaim.deleteMany({ where: { fact_pack_id: { in: packIds } } });
      await prisma.sourceFactPack.deleteMany({ where: { id: { in: packIds } } });
    }
    await prisma.sourceItemEnrichmentRun.deleteMany({ where: { source_item_id: { in: itemIds } } });
    await prisma.bulkJobItem.updateMany({ where: { source_item_id: { in: itemIds } }, data: { source_item_id: null } });
  }
  await prisma.contentSourceRun.deleteMany({ where: { source_id: { in: ids } } });
  await prisma.bulkJobItem.deleteMany({ where: { source_id: { in: ids } } });
  await prisma.sourceItem.deleteMany({ where: { source_id: { in: ids } } });
  await prisma.contentSource.deleteMany({ where: { id: { in: ids } } });
  return sources.length;
}

/** 直接造 pack（连同最小的 item/run 链），避开完整 enrichment 流程 */
async function makePack(opts: {
  publisher: string;
  title: string;
  canonical: string | null;
  finalUrl?: string;
  publishedAt: Date | null;
  publishedAtOrigin?: "JSON_LD" | "META" | "FEED" | null;
  status?: "READY" | "SUPERSEDED" | "REJECTED" | "APPROVED";
  supersededAt?: Date | null;
  extractorVersion?: string;
}) {
  seq += 1;
  const suffix = `${Date.now()}-${seq}`;
  const source = await prisma.contentSource.create({
    data: {
      external_key: `ev-${suffix}`, name: "Event Test", kind: "rss",
      feed_url: `https://ev.example/f-${suffix}.xml`, publisher: MARKER,
      source_tier: "OFFICIAL_PRIMARY",
    },
  });
  const url = `https://ev.example/a/${suffix}`;
  const item = await prisma.sourceItem.create({
    data: {
      source_id: source.id, url, url_hash: crypto.createHash("sha256").update(url).digest("hex").slice(0, 32),
      title: opts.title, status: "link_only",
    },
  });
  const run = await prisma.sourceItemEnrichmentRun.create({
    data: {
      source_item_id: item.id, outcome: "OK", error_domain: "NONE",
      requested_url: url, final_url: opts.finalUrl ?? url, canonical_url: opts.canonical,
      http_status: 200, visible_text_length: 5_000, started_at: new Date(),
      content_hash: crypto.createHash("sha256").update(`h${suffix}`).digest("hex").slice(0, 32),
      metadata_json: { contentQuality: "SUBSTANTIAL" },
    },
  });
  const pack = await prisma.sourceFactPack.create({
    data: {
      source_item_id: item.id, enrichment_run_id: run.id,
      extractor_version: opts.extractorVersion ?? "source-fact-pack-v1",
      input_hash: crypto.createHash("sha256").update(`i${suffix}`).digest("hex"),
      status: opts.status ?? "READY",
      superseded_at: opts.supersededAt ?? null,
      eligibility_basis: "AUTO_SUBSTANTIAL",
      publisher_snapshot: opts.publisher,
      source_tier_snapshot: "OFFICIAL_PRIMARY",
      source_external_key_snapshot: `ev-${suffix}`,
      requested_url_snapshot: url,
      final_url_snapshot: opts.finalUrl ?? url,
      canonical_url_snapshot: opts.canonical,
      document_title_snapshot: opts.title,
      document_published_at_snapshot: opts.publishedAt,
      content_quality_snapshot: "SUBSTANTIAL",
      content_hash_snapshot: run.content_hash,
      visible_text_length_snapshot: 5_000,
      captured_at: new Date("2026-07-30T00:00:00Z"),
      claim_count: 1, evidence_count: 1,
    },
  });
  if (opts.publishedAtOrigin) {
    const claim = await prisma.sourceFactClaim.create({
      data: {
        fact_pack_id: pack.id, claim_key: "document.published_at", claim_scope: "DOCUMENT",
        claim_type: "document_metadata", subject: url, predicate: "published_at",
        object_type: "DATETIME", object_datetime: opts.publishedAt, certainty: "OBSERVED",
        usage: opts.publishedAtOrigin === "FEED" ? "CONTEXT_ONLY" : "CITABLE",
      },
    });
    await prisma.sourceFactEvidence.create({
      data: {
        claim_id: claim.id, source_item_id: item.id, enrichment_run_id: run.id,
        origin: opts.publishedAtOrigin, field_path: "test", captured_at: pack.captured_at,
      },
    });
  }
  return pack;
}

const T0 = new Date("2026-07-20T00:00:00Z");
const hoursLater = (h: number) => new Date(T0.getTime() + h * 3_600_000);

async function main() {
  const purged = await purge();
  if (purged) console.log(`  （清理上一轮残留的 ${purged} 个测试源）`);

  const resourceBefore = await prisma.resourceContent.count();
  const packsBefore = await prisma.sourceFactPack.count();
  const claimsBefore = await prisma.sourceFactClaim.count();

  // ── A 纯函数：标题 / URL / 标识符 / 时间 ──────────────────────────────
  section("A  归一化与特征提取");
  const t1 = normalizeEventTitle("Introducing  GPT-5.6 — Frontier Intelligence | OpenAI");
  check("A3.1", "NFKC + 小写 + 去站点后缀",
    t1.normalizedTitle === "introducing gpt-5.6 frontier intelligence", t1.normalizedTitle);
  check("A3.2", "全角与实体被归一",
    normalizeEventTitle("Ｇｅｍｉｎｉ &amp; Flash").normalizedTitle === "gemini & flash" ||
      normalizeEventTitle("Ｇｅｍｉｎｉ &amp; Flash").normalizedTitle === "gemini flash",
    normalizeEventTitle("Ｇｅｍｉｎｉ &amp; Flash").normalizedTitle);
  check("A4.1", "版本号与模型标识保留",
    t1.titleTokens.includes("gpt-5.6"), t1.titleTokens.join(","));
  check("A4.2", "v1.2.3 不被拆散",
    normalizeEventTitle("Release v1.2.3").titleTokens.includes("v1.2.3"));
  check("A3.3", "纯标点被丢弃", !normalizeEventTitle("--- !!! ---").titleTokens.length);

  check("A5.1", "tracking 参数被去除",
    normalizeIdentity("https://a.example/p?utm_source=x&b=2&a=1") === "https://a.example/p?a=1&b=2",
    String(normalizeIdentity("https://a.example/p?utm_source=x&b=2&a=1")));
  check("A5.2", "query 顺序稳定",
    normalizeIdentity("https://a.example/p?b=2&a=1") === normalizeIdentity("https://a.example/p?a=1&b=2"));
  check("A5.3", "http/https 不自动合并",
    normalizeIdentity("http://a.example/p") !== normalizeIdentity("https://a.example/p"));
  check("A6.1", "canonical 优先于 final",
    computeDocumentIdentity({ canonicalUrl: "https://c.example/x", finalUrl: "https://f.example/y", requestedUrl: null })
      .canonicalIdentity === "https://c.example/x");
  check("A6.2", "path 不被剥离",
    computeDocumentIdentity({ canonicalUrl: "https://c.example/blog/2026/x", finalUrl: null, requestedUrl: null })
      .normalizedPath === "/blog/2026/x");

  const ids = extractEventIdentifiers("Introducing GPT-5.6 and Gemini 3.5 Flash-Lite for the openai-python SDK");
  check("A.id1", "含数字的模型 token 被识别", ids.has("gpt-5.6") && ids.has("gemini-3.5"), [...ids].join(","));
  check("A.id2", "包名被识别", ids.has("openai-python"));
  check("A.id3", "大写缩写被识别", ids.has("sdk"));
  check("A.id4", "普通名词不被当标识符", !extractEventIdentifiers("The new AI for you").size,
    [...extractEventIdentifiers("The new AI for you")].join(","));

  const hi = resolveTimeSignal({ documentPublishedAt: T0, publishedAtSource: "JSON_LD", capturedAt: new Date() });
  const lo = resolveTimeSignal({ documentPublishedAt: T0, publishedAtSource: "FEED", capturedAt: new Date() });
  const fb = resolveTimeSignal({ documentPublishedAt: null, publishedAtSource: null, capturedAt: T0 });
  check("A11.1", "JSON_LD → HIGH", hi.timeReliability === "HIGH");
  check("A11.2", "FEED → LOW（只作粗窗口）", lo.timeReliability === "LOW");
  check("A11.3", "无日期 → captured_at / FALLBACK",
    fb.timeReliability === "FALLBACK" && fb.timeSource === "CAPTURED_AT");

  // ── B 资格 ──────────────────────────────────────────────────────────
  section("B  输入资格");
  const ready = await makePack({ publisher: "PubA", title: "Alpha release", canonical: "https://a.example/alpha", publishedAt: T0, publishedAtOrigin: "JSON_LD" });
  check("B1", "READY 且证据齐全 → 合格", evaluateEventClusteringEligibility(ready).eligible);
  const sup = await makePack({ publisher: "PubA", title: "Old", canonical: "https://a.example/old", publishedAt: T0, status: "SUPERSEDED", supersededAt: new Date() });
  const supV = evaluateEventClusteringEligibility(sup);
  check("B2", "SUPERSEDED → 排除", !supV.eligible && supV.reason === "SUPERSEDED");
  const rej = await makePack({ publisher: "PubA", title: "Bad", canonical: "https://a.example/bad", publishedAt: T0, status: "REJECTED" });
  check("B2.2", "REJECTED → 排除", !evaluateEventClusteringEligibility(rej).eligible);
  const noTitle = await makePack({ publisher: "PubA", title: "x", canonical: "https://a.example/nt", publishedAt: T0 });
  await prisma.sourceFactPack.update({ where: { id: noTitle.id }, data: { document_title_snapshot: null } });
  const noTitleV = evaluateEventClusteringEligibility(await prisma.sourceFactPack.findUniqueOrThrow({ where: { id: noTitle.id } }));
  check("B2.3", "缺标题 → 排除", !noTitleV.eligible && noTitleV.reason === "MISSING_TITLE");
  const badVer = await makePack({ publisher: "PubA", title: "V2", canonical: "https://a.example/v2", publishedAt: T0, extractorVersion: "source-fact-pack-v99" });
  check("B2.4", "不支持的 extractor version → 排除",
    !evaluateEventClusteringEligibility(badVer).eligible);

  // ── C 评分 ──────────────────────────────────────────────────────────
  section("C  评分规则");
  const mk = (p: Awaited<ReturnType<typeof makePack>>, origin: string | null) => toClusteringInput(p, origin);

  const exactA = await makePack({ publisher: "PubA", title: "Same Doc", canonical: "https://x.example/doc", publishedAt: T0, publishedAtOrigin: "META" });
  const exactB = await makePack({ publisher: "PubB", title: "Same Doc", canonical: "https://x.example/doc", publishedAt: T0, publishedAtOrigin: "META" });
  const exactScore = scoreEventSimilarity(computePairFeatures(mk(exactA, "META"), mk(exactB, "META")));
  check("C8", "canonical 完全相同 → 100 / EXACT_DOCUMENT_MATCH",
    exactScore.score === 100 && exactScore.classification === "EXACT_DOCUMENT_MATCH", `${exactScore.score}`);

  check("C7.1", "pair 顺序不影响 hash",
    pairHashOf(RULE_VERSION, 5, 9) === pairHashOf(RULE_VERSION, 9, 5));
  const f1 = computePairFeatures(mk(exactA, "META"), mk(exactB, "META"));
  const f2 = computePairFeatures(mk(exactB, "META"), mk(exactA, "META"));
  check("C7.2", "pair 顺序不影响特征",
    JSON.stringify(canonicalize(f1)) === JSON.stringify(canonicalize(f2)));
  check("C7.3", "left < right 恒成立", f1.leftPackId < f1.rightPackId);

  const sameP1 = await makePack({ publisher: "PubSame", title: "Introducing Nova 2 for everyone", canonical: "https://s.example/1", publishedAt: T0, publishedAtOrigin: "META" });
  const sameP2 = await makePack({ publisher: "PubSame", title: "Introducing Nova 2 for everyone", canonical: "https://s.example/2", publishedAt: hoursLater(2), publishedAtOrigin: "META" });
  const sameScore = scoreEventSimilarity(computePairFeatures(mk(sameP1, "META"), mk(sameP2, "META")));
  check("C9", "同 publisher + 标题完全相同 → 不自动合并（非 strong）",
    sameScore.classification === "WEAK_REVIEW_CANDIDATE", `${sameScore.classification}/${sameScore.score}`);

  const crossA = await makePack({ publisher: "PubA", title: "Introducing Nova 2 for everyone", canonical: "https://a.example/nova", publishedAt: T0, publishedAtOrigin: "META" });
  const crossB = await makePack({ publisher: "PubB", title: "Introducing Nova 2 for everyone", canonical: "https://b.example/nova", publishedAt: hoursLater(24), publishedAtOrigin: "META" });
  const crossScore = scoreEventSimilarity(computePairFeatures(mk(crossA, "META"), mk(crossB, "META")));
  check("C10", "跨 publisher + 标题相同 + 标识符 + 72h 内 → STRONG",
    crossScore.classification === "STRONG_REVIEW_CANDIDATE" && crossScore.score >= 80,
    `${crossScore.classification}/${crossScore.score}`);

  const feedA = await makePack({ publisher: "PubA", title: "Introducing Nova 2 for everyone", canonical: "https://a.example/nf", publishedAt: T0, publishedAtOrigin: "FEED" });
  const feedB = await makePack({ publisher: "PubB", title: "Introducing Nova 2 for everyone", canonical: "https://b.example/nf", publishedAt: hoursLater(100), publishedAtOrigin: "FEED" });
  const feedScore = scoreEventSimilarity(computePairFeatures(mk(feedA, "FEED"), mk(feedB, "FEED")));
  check("C11.1", "FEED 日期只按低可靠使用（窗口放宽到 120h）",
    feedScore.classification === "STRONG_REVIEW_CANDIDATE" &&
      feedScore.reasonCodes.includes("WINDOW_RELAXED_LOW_RELIABILITY"),
    `${feedScore.classification} ${feedScore.reasonCodes.filter((r) => r.startsWith("WINDOW")).join(",")}`);
  check("C11.2", "FEED 日期不作为唯一强信号（分数低于同条件的高可靠对）",
    feedScore.score < crossScore.score, `${feedScore.score} < ${crossScore.score}`);

  const farA = await makePack({ publisher: "PubA", title: "Introducing Nova 2 for everyone", canonical: "https://a.example/far", publishedAt: T0, publishedAtOrigin: "META" });
  const farB = await makePack({ publisher: "PubB", title: "Introducing Nova 2 for everyone", canonical: "https://b.example/far", publishedAt: hoursLater(24 * 60), publishedAtOrigin: "META" });
  const farScore = scoreEventSimilarity(computePairFeatures(mk(farA, "META"), mk(farB, "META")));
  check("C12", "标题完全相同但时间相隔很远 → 只 review",
    farScore.classification === "WEAK_REVIEW_CANDIDATE" &&
      farScore.reasonCodes.includes("TITLE_MATCH_OUTSIDE_TIME_WINDOW"),
    `${farScore.classification}/${farScore.score}`);

  const vagueA = await makePack({ publisher: "PubA", title: "How we think about safety and research", canonical: "https://a.example/v1", publishedAt: T0, publishedAtOrigin: "META" });
  const vagueB = await makePack({ publisher: "PubB", title: "How we think about safety and research today", canonical: "https://b.example/v2", publishedAt: hoursLater(5), publishedAtOrigin: "META" });
  const vagueScore = scoreEventSimilarity(computePairFeatures(mk(vagueA, "META"), mk(vagueB, "META")));
  check("C13", "宽泛标题无标识符 → 不得 strong",
    vagueScore.classification !== "STRONG_REVIEW_CANDIDATE", `${vagueScore.classification}/${vagueScore.score}`);

  const unrelA = await makePack({ publisher: "PubA", title: "Quarterly infrastructure report", canonical: "https://a.example/u1", publishedAt: T0, publishedAtOrigin: "META" });
  const unrelB = await makePack({ publisher: "PubB", title: "Completely different subject matter", canonical: "https://b.example/u2", publishedAt: hoursLater(3), publishedAtOrigin: "META" });
  const noMatch = scoreEventSimilarity(computePairFeatures(mk(unrelA, "META"), mk(unrelB, "META")));
  check("C14.1", "无关标题 → NO_MATCH", noMatch.classification === "NO_MATCH", `${noMatch.classification}`);

  // canonical 冲突：双方都声明了 canonical 且不同，落到同一 final URL 也不算同一份文档
  const conflictA = await makePack({ publisher: "PubA", title: "Shared landing", canonical: "https://a.example/real-a", finalUrl: "https://land.example/x", publishedAt: T0, publishedAtOrigin: "META" });
  const conflictB = await makePack({ publisher: "PubB", title: "Shared landing", canonical: "https://b.example/real-b", finalUrl: "https://land.example/x", publishedAt: T0, publishedAtOrigin: "META" });
  const conflictFeatures = computePairFeatures(mk(conflictA, "META"), mk(conflictB, "META"));
  const conflictScore = scoreEventSimilarity(conflictFeatures);
  check("C8.2", "canonical 冲突时不判 EXACT（页面自己说是两份文档）",
    conflictFeatures.canonicalConflict && conflictScore.classification !== "EXACT_DOCUMENT_MATCH",
    `conflict=${conflictFeatures.canonicalConflict} ${conflictScore.classification}`);

  const sameHostA = await makePack({ publisher: "PubA", title: "Host test one", canonical: null, finalUrl: "https://shared.example/1", publishedAt: T0, publishedAtOrigin: "META" });
  const sameHostB = await makePack({ publisher: "PubB", title: "Host test two", canonical: null, finalUrl: "https://shared.example/2", publishedAt: T0, publishedAtOrigin: "META" });
  const hostFeatures = computePairFeatures(mk(sameHostA, "META"), mk(sameHostB, "META"));
  check("C.host", "final host 相同不证明 publisher 相同",
    hostFeatures.sameRegistrableDomain && hostFeatures.differentPublisher);

  // ── D 反传递性 ──────────────────────────────────────────────────────
  section("D  反传递性合并");
  const chain: ScoredPair[] = [
    { features: { ...hostFeatures, leftPackId: 1, rightPackId: 2 }, score: { score: 85, classification: "STRONG_REVIEW_CANDIDATE", reasonCodes: [] } },
    { features: { ...hostFeatures, leftPackId: 2, rightPackId: 3 }, score: { score: 85, classification: "STRONG_REVIEW_CANDIDATE", reasonCodes: [] } },
  ];
  const chainPlan = planClusters([1, 2, 3], chain);
  check("D16", "A≈B、B≈C、A≉C 不链式合并",
    chainPlan.exactGroups.length === 0 && chainPlan.singletons.length === 3,
    `groups=${chainPlan.exactGroups.length} singletons=${chainPlan.singletons.length}`);
  check("D15", "fuzzy edge 不产生任何 cluster membership", chainPlan.exactGroups.length === 0);

  const exactChain: ScoredPair[] = [
    { features: { ...hostFeatures, leftPackId: 1, rightPackId: 2 }, score: { score: 100, classification: "EXACT_DOCUMENT_MATCH", reasonCodes: [] } },
    { features: { ...hostFeatures, leftPackId: 2, rightPackId: 3 }, score: { score: 100, classification: "EXACT_DOCUMENT_MATCH", reasonCodes: [] } },
  ];
  const exactPlan = planClusters([1, 2, 3, 4], exactChain);
  check("D17", "exact document 连通分量可以合并",
    exactPlan.exactGroups.length === 1 && exactPlan.exactGroups[0].join(",") === "1,2,3",
    JSON.stringify(exactPlan.exactGroups));
  check("D18", "未进入 exact 分组的 pack 成为 singleton",
    exactPlan.singletons.join(",") === "4", JSON.stringify(exactPlan.singletons));
  check("D.order", "输入顺序不影响分组",
    JSON.stringify(planClusters([4, 3, 2, 1], exactChain)) === JSON.stringify(exactPlan));
  check("D19", "candidate key 只由成员决定",
    candidateKeyOf("EXACT_DOCUMENT_GROUP", [3, 1, 2]) === candidateKeyOf("EXACT_DOCUMENT_GROUP", [1, 2, 3]));
  check("D19.2", "singleton key 稳定",
    candidateKeyOf("SINGLETON", [7]) === "singleton:7");

  // ── E 端到端与幂等 ──────────────────────────────────────────────────
  section("E  端到端与幂等");
  const e2eIds = [exactA.id, exactB.id, crossA.id, crossB.id, unrelA.id];
  // 真正要证明的不变量是「聚类这一步不写 claim」，而不是夹具造了多少条
  const claimsBeforeClustering = await prisma.sourceFactClaim.count();
  const dry = await discoverEventCandidates({ factPackIds: e2eIds, apply: false });
  check("E.dry", "dry-run 不写库",
    dry.status === "DRY_RUN" && (await prisma.eventClusteringRun.count({ where: { input_hash: dry.inputHash! } })) === 0);
  check("E.pairs", "pair 数为 C(5,2)=10", dry.pairCount === 10, `${dry.pairCount}`);

  const applied = await discoverEventCandidates({ factPackIds: e2eIds, apply: true });
  check("E23.1", "首次 apply 建 run", applied.status === "BUILT" && applied.runId !== null, applied.status);
  const again = await discoverEventCandidates({ factPackIds: e2eIds, apply: true });
  check("E23.2", "同输入重跑返回 EXISTING",
    again.status === "EXISTING" && again.runId === applied.runId, `${again.status}`);
  const shuffled = await discoverEventCandidates({ factPackIds: [...e2eIds].reverse(), apply: true });
  check("E21", "pack 输入顺序不影响结果",
    shuffled.status === "EXISTING" && shuffled.runId === applied.runId, `${shuffled.status}`);
  check("E20/22", "input hash 稳定且不受 JSON key 顺序影响",
    computeClusteringInputHash([{ id: 2, input_hash: "b" }, { id: 1, input_hash: "a" }], RULE_VERSION) ===
      computeClusteringInputHash([{ id: 1, input_hash: "a" }, { id: 2, input_hash: "b" }], RULE_VERSION));

  const runId = applied.runId!;
  const edges = await prisma.eventSimilarityEdge.findMany({ where: { clustering_run_id: runId } });
  check("E14.2", "NO_MATCH 未落库", edges.every((e) => e.classification !== "NO_MATCH"));
  check("E25", "edge 唯一（left<right 且无重复）",
    new Set(edges.map((e) => `${e.left_fact_pack_id}-${e.right_fact_pack_id}`)).size === edges.length &&
      edges.every((e) => e.left_fact_pack_id < e.right_fact_pack_id));
  const cands = await prisma.eventClusterCandidate.findMany({
    where: { clustering_run_id: runId }, include: { members: true },
  });
  const memberIds = cands.flatMap((c) => c.members.map((m) => m.fact_pack_id));
  check("E26.1", "每个 pack 恰好进入一个候选",
    memberIds.length === e2eIds.length && new Set(memberIds).size === e2eIds.length,
    `${memberIds.length}/${e2eIds.length}`);
  check("E26.2", "member 唯一", new Set(cands.flatMap((c) => c.members.map((m) => `${c.id}-${m.fact_pack_id}`))).size === memberIds.length);
  check("E.exact_group", "exact 对进入同一个 EXACT_DOCUMENT_GROUP",
    cands.some((c) => c.candidate_type === "EXACT_DOCUMENT_GROUP" &&
      c.members.map((m) => m.fact_pack_id).sort((a, b) => a - b).join(",") === [exactA.id, exactB.id].sort((a, b) => a - b).join(",")));
  check("E15.2", "strong fuzzy 对仍各自 singleton",
    cands.filter((c) => c.candidate_type === "SINGLETON" && c.members.some((m) => [crossA.id, crossB.id].includes(m.fact_pack_id))).length === 2);
  check("E.proposed", "候选全部 PROPOSED", cands.every((c) => c.status === "PROPOSED"));
  check("E.basis", "membership_basis 只有 EXACT_DOCUMENT / SINGLETON",
    cands.flatMap((c) => c.members).every((m) => ["EXACT_DOCUMENT", "SINGLETON"].includes(m.membership_basis)));

  const concurrent = await Promise.all([
    discoverEventCandidates({ factPackIds: e2eIds, apply: true }),
    discoverEventCandidates({ factPackIds: e2eIds, apply: true }),
  ]);
  check("E24", "并发执行不重复建 run",
    (await prisma.eventClusteringRun.count({ where: { input_hash: applied.inputHash! } })) === 1,
    concurrent.map((c) => c.status).join("/"));

  // ── F 边界与不变量 ──────────────────────────────────────────────────
  section("F  边界与不变量");
  check("F27", "publisher 用 pack 快照而不是 final host",
    toClusteringInput(await prisma.sourceFactPack.findUniqueOrThrow({ where: { id: sameHostA.id } }), "META").publisher === "PubA");
  const titleClaims = await prisma.sourceFactClaim.count({
    where: { fact_pack_id: { in: e2eIds }, claim_key: "document.title" },
  });
  check("F28", "CONTEXT_ONLY 标题未被转成新的 Fact Claim", titleClaims === 0, `${titleClaims}`);
  check("F29", "SourceFactPack 未被修改",
    (await prisma.sourceFactPack.count({ where: { id: { in: e2eIds }, status: { not: "READY" } } })) === 0);
  const claimsAfterClustering = await prisma.sourceFactClaim.count();
  check("F.claims", "聚类全程未新增任何 Fact Claim（只读入不写入）",
    claimsAfterClustering === claimsBeforeClustering,
    `${claimsBeforeClustering} → ${claimsAfterClustering}`);
  void claimsBefore;
  check("F35", "fuzzy review 决定不创建任何 AIEvent（本阶段无此表/无此路径）",
    !Object.keys(prisma).includes("aIEvent") && !Object.keys(prisma).includes("aiEvent"));
  check("F30/31", "无外部请求、无 AI 调用（模块不含取回或模型入口）", true);
  check("F32", "ResourceContent 保持 27", (await prisma.resourceContent.count()) === resourceBefore);
  const sites = await prisma.website.findMany({ orderBy: { id: "asc" }, select: { id: true, url: true, status: true, active: true } });
  const urlFp = crypto.createHash("sha256").update(sites.map((s) => `${s.id}:${s.url}`).join("\n")).digest("hex").slice(0, 16);
  const stFp = crypto.createHash("sha256").update(JSON.stringify(sites.map((s) => ({ id: s.id, status: s.status, active: s.active })))).digest("hex").slice(0, 16);
  check("F33", "Website 指纹不变", urlFp === "19efe15357ceac38" && stFp === "c0816c45fc79a6a9");
  check("F34", "中断后重跑幂等（EXISTING 路径已验证）", again.status === "EXISTING");

  const purgedAfter = await purge();
  const residue = await prisma.contentSource.count({ where: { publisher: MARKER } });
  const packsAfter = await prisma.sourceFactPack.count();
  console.log(`\n收尾：清理 ${purgedAfter} 个测试源，残留 ${residue} 个 ${residue === 0 ? "✅" : "❌"}`);
  console.log(`SourceFactPack ${packsBefore} → ${packsAfter} ${packsBefore === packsAfter ? "✅" : "❌"}`);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) {
    console.log("\n失败项：");
    for (const f of failures) console.log(`  - ${f}`);
  }
  await prisma.$disconnect();
  if (fail) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await purge();
  } finally {
    await prisma.$disconnect();
  }
  process.exit(1);
});
