/**
 * AI HOT 首轮 canary 的硬验收核对。
 *
 *   npm run aihot:verify
 *
 * 只读库并核对，不发请求、不调 provider、不写库、不发布。
 */
import { httpUrlOrNull } from "@/lib/content/aihot/types";
import { NEVER_BLOCKING_CODES } from "@/lib/content/multilingual/types";
import { prisma } from "@/lib/prisma";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++; else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); }
  console.log(`  ${ok ? "✅" : "❌"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const DRIFT_BY_CODE = (issues: unknown): string[] =>
  Array.isArray(issues) ? issues.map((i) => (i as { code?: string }).code ?? "") : [];

async function main() {
  console.log("AI HOT 首轮 Canary 硬验收\n");

  // ── 入库 ──
  console.log("一、三类内容入库");
  const selected = await prisma.aihotSelectedItem.count();
  check("精选导入 10/10", selected === 10, `实际 ${selected}`);
  const topics = await prisma.aihotHotTopicSnapshot.count();
  const topicIds = (await prisma.aihotHotTopicSnapshot.findMany({ select: { topic_id: true }, distinct: ["topic_id"] })).length;
  check("热点快照导入成功", topics >= 1, `${topics} 份快照 / ${topicIds} 个热点`);
  const dailies = await prisma.aihotDailyReport.count();
  check("最新日报导入成功", dailies >= 1, `${dailies} 期`);

  // ── 草稿 ──
  console.log("\n二、多语言草稿");
  const drafts = await prisma.multilingualDraft.findMany({
    select: {
      id: true, unit_key: true, language: true, status: true, content_form: true,
      qa_issues_json: true, provider_attribution_url: true, original_source_url: true,
      category_slug: true, is_master: true, master_draft_id: true, headline: true, body: true,
    },
  });
  console.log(`  草稿总数 ${drafts.length}`);
  const byUnit = new Map<string, typeof drafts>();
  for (const d of drafts) byUnit.set(d.unit_key, [...(byUnit.get(d.unit_key) ?? []), d]);

  const LANGS = ["EN_US", "ES_ES", "PT_BR", "JA_JP"];
  const missing: string[] = [];
  for (const [unit, ds] of byUnit) {
    const have = new Set(ds.map((d) => d.language));
    for (const l of LANGS) if (!have.has(l as never)) missing.push(`${unit}/${l}`);
  }
  check("缺失语言 0", missing.length === 0, missing.slice(0, 5).join(", "));

  const byForm = new Map<string, number>();
  for (const [, ds] of byUnit) byForm.set(ds[0].content_form, (byForm.get(ds[0].content_form) ?? 0) + 1);
  console.log(`  内容单元 ${byUnit.size}：` + [...byForm].map(([f, n]) => `${f}=${n}`).join(" · "));

  // ── 漂移 ──
  console.log("\n三、事实漂移");
  const codes = drafts.flatMap((d) => DRIFT_BY_CODE(d.qa_issues_json));
  const tally = new Map<string, number>();
  for (const c of codes) tally.set(c, (tally.get(c) ?? 0) + 1);
  check("数字漂移 0", !tally.get("NUMBER_MISMATCH"), String(tally.get("NUMBER_MISMATCH") ?? 0));
  check("日期漂移 0", !tally.get("DATE_MISMATCH"), String(tally.get("DATE_MISMATCH") ?? 0));
  check("模型版本漂移 0", !tally.get("MODEL_MISMATCH"), String(tally.get("MODEL_MISMATCH") ?? 0));
  check("新增事实 0（ENTITY / UNSUPPORTED_DETAIL）",
    !tally.get("ENTITY_MISMATCH") && !tally.get("UNSUPPORTED_DETAIL"),
    `entity=${tally.get("ENTITY_MISMATCH") ?? 0} unsupported=${tally.get("UNSUPPORTED_DETAIL") ?? 0}`);
  check("翻译事实漂移 0", !tally.get("TRANSLATION_FACT_DRIFT"), String(tally.get("TRANSLATION_FACT_DRIFT") ?? 0));
  check("情态升级 0", !tally.get("MODALITY_UPGRADE"), String(tally.get("MODALITY_UPGRADE") ?? 0));
  if (tally.size) console.log("  问题分布：" + [...tally].map(([c, n]) => `${c}=${n}`).join(" · "));

  // ── 归因 ──
  console.log("\n四、归因");
  const badAttr = drafts.filter((d) => !httpUrlOrNull(d.provider_attribution_url));
  check("无效 attribution URL 0", badAttr.length === 0, badAttr.slice(0, 3).map((d) => d.unit_key).join(", "));
  const badOrig = drafts.filter((d) => d.original_source_url !== null && !httpUrlOrNull(d.original_source_url));
  check("无效原始来源 URL 0", badOrig.length === 0, badOrig.slice(0, 3).map((d) => d.unit_key).join(", "));
  const noCat = drafts.filter((d) => !d.category_slug);
  check("草稿均有板块归属", noCat.length === 0, `缺失 ${noCat.length}`);
  const cats = new Map<string, number>();
  for (const d of drafts) cats.set(d.category_slug ?? "(无)", (cats.get(d.category_slug ?? "(无)") ?? 0) + 1);
  console.log("  板块分布：" + [...cats].map(([c, n]) => `${c}=${n}`).join(" · "));

  // ── 母版关系 ──
  console.log("\n五、母版与译文关系");
  const masters = drafts.filter((d) => d.is_master);
  check("每个单元恰有一个 en-US 母版", masters.length === byUnit.size, `${masters.length}/${byUnit.size}`);
  const orphan = drafts.filter((d) => !d.is_master && d.master_draft_id === null);
  check("译文均挂在母版下（非各自独立扩写）", orphan.length === 0, `游离 ${orphan.length}`);

  // ── 产品边界 ──
  console.log("\n六、产品边界");
  check("重复事件被拒绝 0（QA 从不产出这类结论）",
    !codes.some((c) => (NEVER_BLOCKING_CODES as readonly string[]).includes(c)));
  const published = await prisma.multilingualDraft.count({ where: { status: "PUBLISHED" } });
  check("发布数量 0", published === 0, String(published));
  const rc = await prisma.resourceContent.count();
  check("ResourceContent 未新增（27）", rc === 27, String(rc));
  check("未创建 AIEvent（该模型不存在，链路上也没有）",
    !Object.keys(prisma).some((k) => /^ai[eE]vent$/.test(k)));

  const [ecr, ese, ecc, ecm] = await Promise.all([
    prisma.eventClusteringRun.count(), prisma.eventSimilarityEdge.count(),
    prisma.eventClusterCandidate.count(), prisma.eventClusterCandidateMember.count(),
  ]);
  check("event clustering 调用 0（run/edge/candidate/member 未变）",
    ecr === 1 && ese === 0 && ecc === 9 && ecm === 9, `run=${ecr} edge=${ese} cand=${ecc} member=${ecm}`);

  const [fp, fc, fe] = await Promise.all([
    prisma.sourceFactPack.count(), prisma.sourceFactClaim.count(), prisma.sourceFactEvidence.count(),
  ]);
  check("SourceFactPack 数据未被改动（17/233/233）",
    fp === 17 && fc === 233 && fe === 233, `pack=${fp} claim=${fc} evidence=${fe}`);
  const [si, cs] = await Promise.all([prisma.sourceItem.count(), prisma.contentSource.count()]);
  check("未写入 SourceItem / ContentSource（218/7）", si === 218 && cs === 7, `item=${si} source=${cs}`);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) { console.log("\n未通过："); for (const f of failures) console.log(`  - ${f}`); }
  await prisma.$disconnect();
  if (fail) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
