/**
 * AI HOT 多语言内容的人工审核与受控发布。
 *
 *   npm run aihot:publish -- freeze --all              # 把合格草稿冻结成 revision
 *   npm run aihot:publish -- status                    # 家族/审核/发布总览
 *   npm run aihot:publish -- show --family 3           # 打印某个 family 的四语言内容供人工审核
 *   npm run aihot:publish -- topics                    # 热点发布门槛评估
 *   npm run aihot:publish -- review --family 3 --locale EN_US --decision APPROVED \
 *        --reviewer alice --issues NO_ISSUE --notes "..."
 *   npm run aihot:publish -- preflight --family 3      # 只读预检
 *   npm run aihot:publish -- publish --family 3 --master-only
 *   npm run aihot:publish -- publish --family 3
 *
 * **不自动发布**：每个内容单元都要显式传 family id。
 * 不调用生成 provider，不新增 cron，不做事实核查。
 */
import type { DraftLanguage, ReviewDecision, ReviewIssueCategory } from "@prisma/client";

import { assessAllHotTopics } from "@/lib/content/publishing/eligibility";
import { freezeUnit } from "@/lib/content/publishing/freeze";
import { preflight, publishFamily } from "@/lib/content/publishing/publish";
import { familyReviewState, issueTally, recordReview } from "@/lib/content/publishing/review";
import { ALL_CHECKS_PASS, LOCALES, REVIEW_CHECKLIST, type ChecklistResult } from "@/lib/content/publishing/types";
import { prisma } from "@/lib/prisma";

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("--")) ?? "status";
const has = (f: string) => argv.includes(f);
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = has("--dry-run");

async function cmdFreeze() {
  const only = val("--unit");
  const keys = only
    ? [only]
    : (await prisma.multilingualDraft.findMany({ select: { unit_key: true }, distinct: ["unit_key"] })).map((d) => d.unit_key);
  console.log(`冻结 ${keys.length} 个单元${DRY ? "（dry-run）" : ""}\n`);
  let ok = 0, skipped = 0, failed = 0;
  for (const k of keys) {
    const r = await freezeUnit(k, { dryRun: DRY });
    const mark = r.status === "OK" ? "✅" : r.status === "SKIPPED" ? "－" : "❌";
    console.log(`  ${mark} ${k}`);
    if (r.slug) console.log(`     slug=${r.slug} family=#${r.familyId ?? "-"}`);
    if (r.created.length) console.log(`     新建 revision: ${r.created.map((c) => `${c.locale}#${c.revisionNumber}`).join(" ")}`);
    if (r.unchanged.length) console.log(`     内容未变: ${r.unchanged.map((c) => `${c.locale}#${c.revisionNumber}`).join(" ")}`);
    if (r.message) console.log(`     ${r.message}`);
    if (r.status === "OK") ok++; else if (r.status === "SKIPPED") skipped++; else failed++;
  }
  console.log(`\n成功 ${ok} · 跳过 ${skipped} · 失败 ${failed}`);
}

async function cmdStatus() {
  const families = await prisma.articleFamily.findMany({
    include: { translations: { include: { publications: true } } },
    orderBy: { id: "asc" },
  });
  console.log(`家族 ${families.length}\n`);
  for (const f of families) {
    const pub = f.translations.filter((t) => t.publications.some((p) => p.status === "PUBLISHED")).length;
    const app = f.translations.filter((t) => t.approved_revision_id).length;
    console.log(`  #${f.id} [${f.content_form}] ${f.status}  已批准 ${app}/4 · 已发布 ${pub}/4`);
    console.log(`      ${f.unit_key}`);
    console.log(`      slug=${f.slug}${f.report_date ? ` date=${f.report_date}` : ""} · 栏目=${f.category_slug ?? "-"}`);
  }
  const [revs, reviews, pubs] = await Promise.all([
    prisma.articleRevision.count(), prisma.translationReview.count(),
    prisma.articlePublication.count({ where: { status: "PUBLISHED" } }),
  ]);
  console.log(`\nrevision ${revs} · 审核记录 ${reviews} · 已发布页面 ${pubs}`);
  const tally = await issueTally();
  if (Object.keys(tally).length) {
    console.log("审核问题分类：" + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(" · "));
  }
}

async function cmdShow() {
  const familyId = Number(val("--family"));
  const family = await prisma.articleFamily.findUnique({
    where: { id: familyId },
    include: { translations: { include: { revisions: { orderBy: { revision_number: "desc" }, take: 1 } } } },
  });
  if (!family) return console.log("family 不存在");
  console.log(`family #${family.id} [${family.content_form}] ${family.unit_key}`);
  console.log(`slug=${family.slug}${family.report_date ? ` date=${family.report_date}` : ""}`);
  console.log(`归因: ${family.attribution_name} ${family.attribution_url}`);
  console.log(`原始来源: ${family.original_source_name ?? "-"} ${family.original_source_url ?? "-"}`);
  console.log(`栏目: ${family.category_slug ?? "-"} · 来源指纹 ${family.source_snapshot_hash}`);
  for (const locale of LOCALES) {
    const t = family.translations.find((x) => x.locale === locale);
    const r = t?.revisions[0];
    console.log(`\n──── ${locale} · 译本 #${t?.id ?? "-"} · revision #${r?.revision_number ?? "-"} (id ${r?.id ?? "-"}) · ${t?.status} ────`);
    if (!r) { console.log("  （无 revision）"); continue; }
    console.log(`  标题: ${r.headline}`);
    console.log(`  摘要: ${r.summary}`);
    const secs = Array.isArray(r.sections_json) ? (r.sections_json as unknown as { label: string; body: string }[]) : null;
    if (secs?.length) {
      console.log(`  栏目 ${secs.length} 个:`);
      secs.forEach((s, i) => console.log(`    ${i + 1}. ${s.label}\n       ${s.body.slice(0, 400)}`));
    } else {
      console.log(`  正文 (${r.body.length} 字符):\n    ${r.body.replace(/\n/g, "\n    ")}`);
    }
    console.log(`  QA: ${r.qa_verdict} · 问题 ${Array.isArray(r.qa_issues_json) ? r.qa_issues_json.length : 0}`);
  }
}

async function cmdTopics() {
  const results = await assessAllHotTopics();
  console.log(`热点发布门槛评估（${results.length} 个）\n`);
  for (const r of results) {
    const e = r.evidence;
    console.log(`  ${r.publishable ? "✅ 可发布" : "❌ 不可发布"}  快照 #${e.snapshotId}  ${e.title}`);
    console.log(`     API 摘要=${e.hasApiSummary ? "有" : "无"} · source_count=${e.sourceCount} · signal_count=${e.signalCount} · 来源名 ${e.sourceNameCount} 个`);
    console.log(`     关联条目 ${e.relatedItemIds} 个，其中已入库精选 ${e.matchedSelectedItems} 个 · captured_at ${e.capturedAt.toISOString()}`);
    if (!r.publishable) console.log(`     ${r.reason}: ${r.missing.join("；")}`);
  }
  const blocked = results.filter((r) => !r.publishable).length;
  console.log(`\n可发布 ${results.length - blocked} · 不可发布 ${blocked}`);
}

async function cmdReview() {
  const familyId = Number(val("--family"));
  const locale = val("--locale") as DraftLanguage | undefined;
  const decision = (val("--decision") ?? "APPROVED") as ReviewDecision;
  const reviewer = val("--reviewer");
  const issues = (val("--issues") ?? "NO_ISSUE").split(",").map((s) => s.trim()).filter(Boolean) as ReviewIssueCategory[];
  const notes = val("--notes");
  const failKeys = (val("--failed-checks") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  if (!familyId || !locale || !reviewer) {
    console.error("用法: review --family <id> --locale <EN_US|ES_ES|PT_BR|JA_JP> --decision <APPROVED|REJECTED|NEEDS_REVISION> --reviewer <name> [--issues a,b] [--failed-checks k1,k2] [--notes ...]");
    process.exitCode = 1; return;
  }

  const t = await prisma.articleTranslation.findFirst({
    where: { family_id: familyId, locale },
    include: { revisions: { orderBy: { revision_number: "desc" }, take: 1 } },
  });
  if (!t?.revisions[0]) { console.error("找不到译本或 revision"); process.exitCode = 1; return; }

  const checklist: ChecklistResult = { ...ALL_CHECKS_PASS };
  for (const k of failKeys) {
    if (!(k in checklist)) { console.error(`未知检查项: ${k}（可选：${REVIEW_CHECKLIST.map((c) => c.key).join(", ")}）`); process.exitCode = 1; return; }
    (checklist as Record<string, boolean>)[k] = false;
  }

  const r = await recordReview({
    translationId: t.id, revisionId: t.revisions[0].id,
    reviewer, decision, checklist, issueCategories: issues, notes,
  });
  if (!r.ok) { console.error(`❌ ${r.reason}`); process.exitCode = 1; return; }
  console.log(`✅ ${locale} 审核已记录 #${r.reviewId} · ${decision} · 审核人 ${reviewer} · revision #${t.revisions[0].revision_number}`);

  const state = await familyReviewState(familyId);
  if (state) {
    console.log(`   family 批准进度: ${state.locales.filter((l) => l.status === "APPROVED" && l.approvedIsCurrent).length}/4${state.allApproved ? " —— 四种语言均已批准" : ""}`);
  }
}

async function cmdPreflight() {
  const familyId = Number(val("--family"));
  const pre = await preflight(familyId);
  if (!pre) return console.log("family 不存在");
  console.log(`预检 family #${pre.familyId} [${pre.contentForm}] ${pre.unitKey}\n`);
  console.log(`  结论: ${pre.ok ? "✅ 可发布" : "❌ 不可发布"}`);
  for (const t of pre.targets) console.log(`  · ${t.locale}  revision #${t.revisionId}  → ${t.path}`);
  for (const i of pre.issues) console.log(`  ✗ [${i.code}] ${i.detail}`);
  const c = pre.clusteringCounters;
  console.log(`  聚类计数（应保持不变）: run=${c.runs} edge=${c.edges} candidate=${c.candidates} member=${c.members}`);
}

async function cmdPublish() {
  const familyId = Number(val("--family"));
  if (!familyId) { console.error("必须显式指定 --family <id>：本流程不自动发布"); process.exitCode = 1; return; }
  const r = await publishFamily({ familyId, masterOnly: has("--master-only"), dryRun: DRY });
  console.log(`发布 family #${r.familyId} ${r.unitKey}${has("--master-only") ? "（仅英文）" : ""}${DRY ? "（dry-run）" : ""}\n`);
  for (const b of r.blocked) console.log(`  ⛔ [${b.code}] ${b.detail}`);
  for (const o of r.outcomes) {
    const mark = o.status === "PUBLISHED" ? "✅" : o.status === "ALREADY_PUBLISHED" ? "＝" : "❌";
    console.log(`  ${mark} ${o.locale}  ${o.status}  ${o.path ?? ""}${o.message ? `  — ${o.message}` : ""}`);
  }
  const published = await prisma.articlePublication.count({ where: { status: "PUBLISHED" } });
  console.log(`\n结果: ${r.ok ? "成功" : "未完成"} · 站点已发布页面总数 ${published}`);
  if (!r.ok) process.exitCode = 1;
}

const COMMANDS: Record<string, () => Promise<void>> = {
  freeze: cmdFreeze, status: cmdStatus, show: cmdShow, topics: cmdTopics,
  review: cmdReview, preflight: cmdPreflight, publish: cmdPublish,
};

async function main() {
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`未知命令 ${cmd}，可用: ${Object.keys(COMMANDS).join(" / ")}`);
    process.exitCode = 1; return;
  }
  await fn();
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
