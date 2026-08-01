/**
 * AI HOT 内容的多语言草稿生成。
 *
 *   npm run aihot:generate -- --dry-run                    # 只组装，不调用 provider
 *   npm run aihot:generate -- --selected 10                # 最近 10 条精选
 *   npm run aihot:generate -- --hot-topics 5 --daily 1     # 热点 5 + 最新日报
 *
 * en-US 母版 → 母版忠实度 QA → es-ES / pt-BR / ja-JP 译文 → 译文漂移 QA。
 * **只生成草稿，不发布。**
 */
import { generateUnit, type GenerateUnitResult } from "@/lib/content/multilingual/generate";
import { prisma } from "@/lib/prisma";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const num = (f: string, d: number) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? Number(argv[i + 1]) : d; };

const DRY = has("--dry-run");
const FORCE = has("--force");

function report(r: GenerateUnitResult) {
  const mark = r.status === "OK" ? "✅" : r.status === "EXISTING" ? "＝" : "❌";
  console.log(`  ${mark} ${r.unitKey}  [${r.contentForm ?? "-"}]  ${r.status}  provider 调用 ${r.providerCalls}`);
  if (r.message) console.log(`     ${r.message}`);
  for (const l of r.languages) {
    const lm = l.status === "DRAFTED" ? "·" : "✗";
    console.log(`     ${lm} ${l.language.padEnd(6)} ${l.status.padEnd(18)} 问题 ${l.issueCount}${l.headline ? `  ${l.headline.slice(0, 62)}` : ""}`);
    for (const i of l.issues.slice(0, 6)) console.log(`         [${i.code}] ${i.detail.slice(0, 110)}`);
  }
}

/**
 * 只重跑「还没全部成稿」的单元。
 *
 * QA 规则修好之后，用它把受影响的单元补齐，而不是把整批重新烧一遍 ——
 * 已经零问题成稿的单元不受放宽类改动影响，重跑它们只是白花 provider 调用。
 */
async function repair(): Promise<GenerateUnitResult[]> {
  const drafts = await prisma.multilingualDraft.findMany({
    select: { unit_key: true, status: true, content_kind: true,
              selected_item_id: true, hot_topic_snapshot_id: true, daily_report_id: true },
  });
  const byUnit = new Map<string, typeof drafts>();
  for (const d of drafts) byUnit.set(d.unit_key, [...(byUnit.get(d.unit_key) ?? []), d]);

  const targets: { kind: "SELECTED" | "HOT_TOPIC" | "DAILY"; id: number; unitKey: string; why: string }[] = [];
  for (const [unitKey, ds] of byUnit) {
    const bad = ds.filter((d) => d.status !== "DRAFTED").length;
    const incomplete = ds.length < 4;
    // 日报无条件重跑：分栏并入正文后，被检查的文本比上一轮多得多
    const isDaily = ds[0].content_kind === "DAILY";
    if (!bad && !incomplete && !isDaily) continue;
    const d = ds[0];
    const id = d.selected_item_id ?? d.hot_topic_snapshot_id ?? d.daily_report_id;
    if (!id) continue;
    targets.push({
      kind: d.content_kind as "SELECTED" | "HOT_TOPIC" | "DAILY", id, unitKey,
      why: isDaily && !bad && !incomplete ? "日报：正文口径变更" : `未成稿 ${bad} · 语言 ${ds.length}/4`,
    });
  }

  console.log(`── 修复重跑 ${targets.length} 个单元 ──`);
  const out: GenerateUnitResult[] = [];
  for (const t of targets) {
    console.log(`  → ${t.unitKey}  (${t.why})`);
    const r = await generateUnit({ kind: t.kind, id: t.id, dryRun: DRY, force: true });
    report(r); out.push(r);
  }
  return out;
}

async function main() {
  console.log(`AI HOT 多语言草稿生成${DRY ? "（dry-run）" : ""}\n`);
  const results: GenerateUnitResult[] = [];

  if (has("--repair")) {
    results.push(...(await repair()));
    await summarize(results);
    return;
  }

  const selectedN = num("--selected", has("--selected") ? 10 : 0);
  if (selectedN > 0) {
    const rows = await prisma.aihotSelectedItem.findMany({
      orderBy: [{ published_at: "desc" }, { id: "desc" }], take: selectedN, select: { id: true },
    });
    console.log(`── 精选资讯 ${rows.length} 条 ──`);
    for (const row of rows) {
      const r = await generateUnit({ kind: "SELECTED", id: row.id, dryRun: DRY, force: FORCE });
      report(r); results.push(r);
    }
  }

  const topicN = num("--hot-topics", has("--hot-topics") ? 5 : 0);
  if (topicN > 0) {
    // 每个热点只取**最新**那份快照。热点会持续变化，旧快照留着是为了可追溯，
    // 不是为了拿去生成 —— 给一个已经过时的版本写简报没有意义
    const all = await prisma.aihotHotTopicSnapshot.findMany({
      orderBy: [{ captured_at: "desc" }, { id: "desc" }],
      select: { id: true, topic_id: true, rank: true },
    });
    const latestPerTopic = new Map<string, { id: number; rank: number | null }>();
    for (const s of all) if (!latestPerTopic.has(s.topic_id)) latestPerTopic.set(s.topic_id, { id: s.id, rank: s.rank });
    const rows = [...latestPerTopic.values()]
      .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
      .slice(0, topicN);
    console.log(`\n── 当前热点 ${rows.length} 条（共 ${all.length} 份快照，每个热点取最新）──`);
    for (const row of rows) {
      const r = await generateUnit({ kind: "HOT_TOPIC", id: row.id, dryRun: DRY, force: FORCE });
      report(r); results.push(r);
    }
  }

  const dailyN = num("--daily", has("--daily") ? 1 : 0);
  if (dailyN > 0) {
    const rows = await prisma.aihotDailyReport.findMany({
      orderBy: { report_date: "desc" }, take: dailyN, select: { id: true },
    });
    console.log(`\n── AI 日报 ${rows.length} 期 ──`);
    for (const row of rows) {
      const r = await generateUnit({ kind: "DAILY", id: row.id, dryRun: DRY, force: FORCE });
      report(r); results.push(r);
    }
  }

  await summarize(results);
}

async function summarize(results: GenerateUnitResult[]) {
  const langRows = results.flatMap((r) => r.languages);
  const drafted = langRows.filter((l) => l.status === "DRAFTED").length;
  const qaFailed = langRows.filter((l) => l.status === "QA_FAILED").length;
  const genFailed = langRows.filter((l) => l.status === "GENERATION_FAILED").length;
  const calls = results.reduce((n, r) => n + r.providerCalls, 0);

  console.log(`\n═══ 汇总 ═══`);
  console.log(`内容单元 ${results.length} · provider 调用 ${calls}`);
  console.log(`语言草稿 ${langRows.length}：成稿 ${drafted} · QA 未过 ${qaFailed} · 生成失败 ${genFailed}`);

  const byCode = new Map<string, number>();
  for (const l of langRows) for (const i of l.issues) byCode.set(i.code, (byCode.get(i.code) ?? 0) + 1);
  if (byCode.size) {
    console.log("问题分布：" + [...byCode].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join(" · "));
  }

  if (!DRY) {
    const total = await prisma.multilingualDraft.count();
    const published = await prisma.multilingualDraft.count({ where: { status: "PUBLISHED" } });
    console.log(`库中草稿 ${total} · 已发布 ${published}（本阶段必须为 0）`);
  }
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
