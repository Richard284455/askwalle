/**
 * 热点链路的每日 canary 指标与硬门槛核对。
 *
 *   npm run hot:canary              # 记录一天的指标并核对硬门槛
 *   npm run hot:canary -- --no-record   # 只核对，不写入指标历史
 *
 * 默认会做一次**幂等探针**：对每个热点以非 force 方式再调一次生成，
 * 期望返回 EXISTING 且 provider 调用为 0。探针不写内容、不发布。
 */
import { generateUnit } from "@/lib/content/multilingual/generate";
import { HOT_TOPIC_FORBIDDEN_CODES } from "@/lib/content/multilingual/types";
import { loadAllLatestMaterial, hotTopicUnitKey } from "@/lib/content/publishing/eligibility";
import { LOCALES } from "@/lib/content/publishing/types";
import { prisma } from "@/lib/prisma";

const METRICS_KEY = "aihot:hot-topic-canary-metrics";
const RECORD = !process.argv.includes("--no-record");

let pass = 0, fail = 0;
const failures: string[] = [];
function gate(name: string, ok: boolean, detail = "") {
  if (ok) pass++; else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); }
  console.log(`  ${ok ? "✅" : "❌"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const material = await loadAllLatestMaterial();
  const unitKeys = material.map((m) => hotTopicUnitKey(m.topicId));

  const snapshots = await prisma.aihotHotTopicSnapshot.count();
  const drafts = await prisma.multilingualDraft.findMany({
    where: { unit_key: { in: unitKeys } },
    select: { unit_key: true, language: true, status: true, qa_issues_json: true, hot_topic_mode: true },
  });
  const families = await prisma.articleFamily.findMany({
    where: { unit_key: { in: unitKeys } },
    include: { translations: { include: { revisions: true, reviews: true, publications: true } } },
  });

  const signalBriefs = material.filter((m) => m.mode === "SIGNAL").length;
  const enrichedBriefs = material.length - signalBriefs;

  const issueCodes = drafts.flatMap((d) =>
    (Array.isArray(d.qa_issues_json) ? (d.qa_issues_json as { code?: string }[]) : []).map((i) => i.code ?? ""));
  const tally = new Map<string, number>();
  for (const c of issueCodes) tally.set(c, (tally.get(c) ?? 0) + 1);

  const qaPassed = drafts.filter((d) => d.status === "DRAFTED").length;
  const qaFailed = drafts.filter((d) => d.status === "QA_FAILED").length;
  const revisions = families.reduce((n, f) => n + f.translations.reduce((m, t) => m + t.revisions.length, 0), 0);
  const reviewed = families.reduce((n, f) => n + f.translations.filter((t) => t.reviews.length > 0).length, 0);
  const published = families.reduce(
    (n, f) => n + f.translations.filter((t) => t.publications.some((p) => p.status === "PUBLISHED")).length, 0);

  // ── 幂等探针：非 force 重跑必须零 provider 调用 ──
  let probeCalls = 0;
  const probeStatuses: string[] = [];
  for (const m of material) {
    const r = await generateUnit({ kind: "HOT_TOPIC", id: m.snapshotId });
    probeCalls += r.providerCalls;
    probeStatuses.push(r.status);
  }

  const [runs, edges, candidates, members] = [
    await prisma.eventClusteringRun.count(), await prisma.eventSimilarityEdge.count(),
    await prisma.eventClusterCandidate.count(), await prisma.eventClusterCandidateMember.count(),
  ];

  const metrics = {
    date: new Date().toISOString().slice(0, 10),
    snapshots,
    currentTopics: material.length,
    signalBriefs,
    enrichedBriefs,
    multilingualDrafts: drafts.length,
    snapshotsNoRegenNeeded: probeStatuses.filter((s) => s === "EXISTING").length,
    revisions,
    providerCalls: probeCalls,
    qaPassed,
    qaFailed,
    unsupportedDetail: (tally.get("HOT_TOPIC_UNSUPPORTED_DETAIL") ?? 0) + (tally.get("UNSUPPORTED_DETAIL") ?? 0),
    reviewed,
    published,
  };

  console.log("热点 canary 指标\n");
  for (const [k, v] of Object.entries(metrics)) console.log(`  ${k.padEnd(24)} ${v}`);
  if (tally.size) console.log(`  问题分布：${[...tally].map(([c, n]) => `${c}=${n}`).join(" · ")}`);

  console.log("\n硬门槛");

  const missing: string[] = [];
  for (const key of unitKeys) {
    const have = new Set(drafts.filter((d) => d.unit_key === key).map((d) => d.language));
    for (const l of LOCALES) if (!have.has(l)) missing.push(`${key}/${l}`);
  }
  gate("每个最新热点都有四语言简报草稿", missing.length === 0,
    missing.slice(0, 4).join(", ") || `${material.length} 个热点 × 4`);

  const noSummary = material.filter((m) => !m.apiSummary);
  const noSummarySkipped = noSummary.filter((m) =>
    drafts.filter((d) => d.unit_key === hotTopicUnitKey(m.topicId)).length < LOCALES.length);
  gate("因没有摘要而跳过生成：0", noSummarySkipped.length === 0,
    `无摘要热点 ${noSummary.length} 个，全部已生成`);

  const noRelated = material.filter((m) => m.relatedItems.length === 0);
  const noRelatedSkipped = noRelated.filter((m) =>
    drafts.filter((d) => d.unit_key === hotTopicUnitKey(m.topicId)).length < LOCALES.length);
  gate("因没有关联精选而跳过生成：0", noRelatedSkipped.length === 0,
    `无关联精选热点 ${noRelated.length} 个，全部已生成`);

  gate("API 外新增事实：0", !tally.get("HOT_TOPIC_UNSUPPORTED_DETAIL") && !tally.get("UNSUPPORTED_DETAIL"),
    `${metrics.unsupportedDetail}`);
  gate("source count 漂移：0", !tally.get("HOT_TOPIC_SOURCE_COUNT_MISMATCH"),
    String(tally.get("HOT_TOPIC_SOURCE_COUNT_MISMATCH") ?? 0));
  gate("source name 漂移：0", !tally.get("HOT_TOPIC_SOURCE_NAME_MISMATCH"),
    String(tally.get("HOT_TOPIC_SOURCE_NAME_MISMATCH") ?? 0));
  gate("排名漂移：0", !tally.get("HOT_TOPIC_RANK_MISMATCH"), String(tally.get("HOT_TOPIC_RANK_MISMATCH") ?? 0));
  gate("时间语义失真：0", !tally.get("HOT_TOPIC_TIME_MISREPRESENTED"),
    String(tally.get("HOT_TOPIC_TIME_MISREPRESENTED") ?? 0));
  gate("翻译事实漂移：0", !tally.get("TRANSLATION_FACT_DRIFT"), String(tally.get("TRANSLATION_FACT_DRIFT") ?? 0));

  gate("provider 幂等重复调用：0", probeCalls === 0, `探针调用 ${probeCalls} 次`);
  gate("重跑全部返回 EXISTING", probeStatuses.every((s) => s === "EXISTING"), probeStatuses.join(","));

  gate("未出现已取消的门禁类结论",
    !issueCodes.some((c) => (HOT_TOPIC_FORBIDDEN_CODES as readonly string[]).includes(c)),
    [...new Set(issueCodes)].join(",") || "无问题码");

  const autoPublished = await prisma.articlePublication.count({
    where: { status: "PUBLISHED", translation: { family: { content_form: "HOT_TOPIC_BRIEF" } },
             created_at: { gt: new Date(Date.now() - 60_000) } },
  });
  gate("自动发布：0", autoPublished === 0, `近一分钟新增发布 ${autoPublished}`);

  gate("AIEvent 调用：0（该模型不存在）", !Object.keys(prisma).some((k) => /^ai[eE]vent$/.test(k)));
  gate("event clustering 调用：0", runs === 1 && edges === 0 && candidates === 9 && members === 9,
    `run=${runs} edge=${edges} cand=${candidates} member=${members}`);

  if (RECORD) {
    const row = await prisma.setting.findUnique({ where: { key: METRICS_KEY } });
    const history = row ? (JSON.parse(row.value) as unknown[]) : [];
    history.push(metrics);
    // 只留最近 30 天，指标历史不该无限膨胀
    const trimmed = history.slice(-30);
    await prisma.setting.upsert({
      where: { key: METRICS_KEY },
      create: { key: METRICS_KEY, value: JSON.stringify(trimmed) },
      update: { value: JSON.stringify(trimmed) },
    });
    console.log(`\n已记录第 ${trimmed.length} 天指标（保留最近 30 天）`);
  }

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) { console.log("\n未通过："); for (const f of failures) console.log(`  - ${f}`); }
  await prisma.$disconnect();
  if (fail) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
