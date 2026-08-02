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
import {
  eventDiscoveryOf, formatCounters, loadProtectedBaseline, readEventDiscoveryCounters,
} from "@/lib/content/publishing/protected-baseline";
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
    select: {
      unit_key: true, language: true, status: true, qa_issues_json: true,
      hot_topic_mode: true, source_snapshot_hash: true,
    },
  });
  const families = await prisma.articleFamily.findMany({
    where: { unit_key: { in: unitKeys } },
    include: { translations: { include: { revisions: true, reviews: true, publications: true } } },
  });

  const signalBriefs = material.filter((m) => m.mode === "SIGNAL").length;
  const enrichedBriefs = material.length - signalBriefs;

  const codesOf = (raw: unknown) =>
    (Array.isArray(raw) ? (raw as { code?: string }[]) : []).map((i) => i.code ?? "");
  const issueCodes = drafts.flatMap((d) => codesOf(d.qa_issues_json));
  /*
   * 门槛只看**漏过 QA** 的问题。
   *
   * QA_FAILED 的草稿上带着问题码，说明确定性 QA 接住了它、内容没进发布链路 ——
   * 那是安全网在工作。把它算成失败，等于每接住一次就报一次警，
   * 而这种警报最终只会被无视。
   */
  const escapedCodes = drafts.filter((d) => d.status === "DRAFTED").flatMap((d) => codesOf(d.qa_issues_json));
  const tally = new Map<string, number>();
  for (const c of escapedCodes) tally.set(c, (tally.get(c) ?? 0) + 1);
  const blockedTally = new Map<string, number>();
  for (const c of issueCodes) blockedTally.set(c, (blockedTally.get(c) ?? 0) + 1);

  const qaPassed = drafts.filter((d) => d.status === "DRAFTED").length;
  const qaFailed = drafts.filter((d) => d.status === "QA_FAILED").length;
  const revisions = families.reduce((n, f) => n + f.translations.reduce((m, t) => m + t.revisions.length, 0), 0);
  const reviewed = families.reduce((n, f) => n + f.translations.filter((t) => t.reviews.length > 0).length, 0);
  const published = families.reduce(
    (n, f) => n + f.translations.filter((t) => t.publications.some((p) => p.status === "PUBLISHED")).length, 0);

  /*
   * 幂等探针：**同一份输入**非 force 重跑必须零 provider 调用。
   *
   * 前提有两条，缺一条这个探针就测不到幂等，还要白烧一轮 provider 调用：
   *   1. 该单元四语言都已成稿 —— 否则重跑测的是「失败会不会重试」；
   *   2. 当前快照指纹与草稿当时的指纹**一致** —— 源端已经变了的话，
   *      重新生成正是应有行为，把它算成「幂等破了」是冤枉的。
   */
  const probeable = new Set(
    [...new Set(drafts.map((d) => d.unit_key))].filter((k) => {
      const ds = drafts.filter((d) => d.unit_key === k);
      if (ds.length !== LOCALES.length || !ds.every((d) => d.status === "DRAFTED")) return false;
      const hashes = new Set(ds.map((d) => d.source_snapshot_hash));
      if (hashes.size !== 1) return false;
      const m = material.find((x) => hotTopicUnitKey(x.topicId) === k);
      return Boolean(m && m.snapshotHash === [...hashes][0]);
    })
  );
  let probeCalls = 0;
  const probeStatuses: string[] = [];
  let probeSkipped = 0;
  for (const m of material) {
    if (!probeable.has(hotTopicUnitKey(m.topicId))) { probeSkipped++; continue; }
    const r = await generateUnit({ kind: "HOT_TOPIC", id: m.snapshotId });
    probeCalls += r.providerCalls;
    probeStatuses.push(r.status);
  }

  /*
   * event discovery 计数**与动态基线比对**，不写死绝对值。
   *
   * 以前这里是 `runs === 1 && edges === 0 && candidates === 9 && members === 9`。
   * 那种断言只在写下它的那一天成立：event discovery 自己正常跑一轮，
   * 内容链路明明一行都没碰，这条门槛照样会红 —— 于是大家开始忽略它，
   * 真的越权写入反而看不见了。
   *
   * 受保护的是「本任务不该改动它们」，用基线表达就够了。
   */
  const clustering = await readEventDiscoveryCounters();
  const baseline = await loadProtectedBaseline();

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
  if (blockedTally.size) {
    console.log(`  问题分布（含已被 QA 拦下的）：${[...blockedTally].map(([c, n]) => `${c}=${n}`).join(" · ")}`);
  }
  if (tally.size) console.log(`  ⚠ 漏过 QA 的问题：${[...tally].map(([c, n]) => `${c}=${n}`).join(" · ")}`);
  if (probeSkipped) {
    console.log(`  幂等探针跳过 ${probeSkipped} 个单元（未成稿或源端已变，探它们测不出幂等）`);
  }

  console.log("\n硬门槛");

  /*
   * 规则是「素材少不能成为**不生成**的理由」，不是「生成出来的一律得放行」。
   *
   * 所以门槛判的是**有没有尝试过**（至少有一份母版草稿），
   * 而不是「四种语言是否齐全」：母版没过忠实度 QA 时按设计不翻译，
   * 拿语言齐不齐当门槛，会把「QA 正确拦下了一篇编造的稿子」判成违规 ——
   * 那等于要求安全网别工作。
   */
  const attempted = new Set(drafts.map((d) => d.unit_key));
  const neverAttempted = unitKeys.filter((k) => !attempted.has(k));
  gate("每个最新热点都已尝试生成简报（素材少也不跳过）", neverAttempted.length === 0,
    neverAttempted.slice(0, 4).join(", ") || `${material.length} 个热点全部已生成`);

  const complete = new Set([...attempted].filter((k) => {
    const ds = drafts.filter((d) => d.unit_key === k);
    return ds.length === LOCALES.length && ds.every((d) => d.status === "DRAFTED");
  }));
  const blockedByQa = unitKeys.filter((k) => attempted.has(k) && !complete.has(k));
  console.log(`  ℹ  四语言成稿 ${complete.size} · 生成后被 QA 拦下 ${blockedByQa.length}${blockedByQa.length ? `（${blockedByQa.slice(0, 3).join(", ")}）` : ""}`);

  const noSummary = material.filter((m) => !m.apiSummary);
  const noSummarySkipped = noSummary.filter((m) => !attempted.has(hotTopicUnitKey(m.topicId)));
  gate("因没有摘要而跳过生成：0", noSummarySkipped.length === 0,
    `无摘要热点 ${noSummary.length} 个，全部已尝试生成`);

  const noRelated = material.filter((m) => m.relatedItems.length === 0);
  const noRelatedSkipped = noRelated.filter((m) => !attempted.has(hotTopicUnitKey(m.topicId)));
  gate("因没有关联精选而跳过生成：0", noRelatedSkipped.length === 0,
    `无关联精选热点 ${noRelated.length} 个，全部已尝试生成`);

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
  gate("重跑全部返回 EXISTING",
    probeStatuses.length > 0 && probeStatuses.every((s) => s === "EXISTING"),
    probeStatuses.join(",") || "没有可探的成稿单元");

  gate("未出现已取消的门禁类结论",
    !issueCodes.some((c) => (HOT_TOPIC_FORBIDDEN_CODES as readonly string[]).includes(c)),
    [...new Set(issueCodes)].join(",") || "无问题码");

  const autoPublished = await prisma.articlePublication.count({
    where: { status: "PUBLISHED", translation: { family: { content_form: "HOT_TOPIC_BRIEF" } },
             created_at: { gt: new Date(Date.now() - 60_000) } },
  });
  gate("自动发布：0", autoPublished === 0, `近一分钟新增发布 ${autoPublished}`);

  gate("AIEvent 调用：0（该模型不存在）", !Object.keys(prisma).some((k) => /^ai[eE]vent$/.test(k)));
  if (!baseline) {
    gate("event clustering 数据未变（与基线比对）", false,
      "尚无基线，先运行 npm run aihot:verify -- --capture-baseline");
  } else {
    const base = eventDiscoveryOf(baseline);
    const changed = (Object.keys(base) as (keyof typeof base)[]).filter((k) => base[k] !== clustering[k]);
    gate("event clustering 数据未变（与基线比对）", changed.length === 0,
      changed.length
        ? changed.map((k) => `${k} ${base[k]}→${clustering[k]}`).join(" · ")
        : formatCounters(clustering));
  }

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
