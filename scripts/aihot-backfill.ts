/**
 * AI HOT 全量回填与增量同步。
 *
 *   npm run aihot:backfill                     # 精选全量 + 日报全量
 *   npm run aihot:backfill -- --dry-run        # 只取不写
 *   npm run aihot:backfill -- --selected       # 只做精选全量快照
 *   npm run aihot:backfill -- --dailies        # 只补日报
 *   npm run aihot:backfill -- --incremental    # 只走增量（水位失效会自动回落全量）
 *   npm run aihot:backfill -- --status         # 看当前水位与库存
 *
 * 只走 API v1，不抓网页。**只写来源表，不生成内容、不发布。**
 */
import { loadSelectedCursor } from "@/lib/content/aihot/client";
import { backfillDailies, backfillSelected, syncSelected } from "@/lib/content/aihot/sync";
import { prisma } from "@/lib/prisma";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

const DRY = has("--dry-run");

async function stock() {
  const selected = await prisma.aihotSelectedItem.count();
  const active = await prisma.aihotSelectedItem.count({ where: { selected: true } });
  const dailies = await prisma.aihotDailyReport.count();
  const topics = await prisma.aihotHotTopicSnapshot.count();
  const cursor = await loadSelectedCursor();
  console.log(`库存：精选 ${selected}（在选 ${active} · 已取消 ${selected - active}） · 日报 ${dailies} · 热点快照 ${topics}`);
  console.log(`同步水位：${cursor ? `${cursor.slice(0, 24)}…（长度 ${cursor.length}）` : "（无，下次会做全量）"}`);
}

async function main() {
  if (has("--status")) { await stock(); return; }

  const wantSelected = has("--selected") || (!has("--dailies") && !has("--incremental"));
  const wantDailies = has("--dailies") || (!has("--selected") && !has("--incremental"));

  console.log(`AI HOT 回填${DRY ? "（dry-run）" : ""}\n`);
  await stock();
  console.log("");

  if (has("--incremental")) {
    console.log("── 精选增量 ──");
    const { result: r, bootstrapped } = await syncSelected({ dryRun: DRY });
    if (bootstrapped) console.log("  ⚠ 水位不可用，已自动回落到全量快照");
    console.log(`  ${r.status === "OK" ? "✅" : "❌"} ${r.mode} ${r.status} · ${r.pages} 页 · 取回 ${r.fetched}`);
    console.log(`     新建 ${r.created} · 更新 ${r.updated} · 未变 ${r.unchanged} · 取消精选 ${r.removed} · 跳过 ${r.skipped}`);
    if (r.message) console.log(`     ${r.message}`);
    if (r.status === "FAILED") process.exitCode = 1;
  }

  if (wantSelected) {
    console.log("── 精选全量快照 ──");
    const r = await backfillSelected({ dryRun: DRY });
    console.log(`  ${r.status === "OK" ? "✅" : "❌"} ${r.status} · ${r.pages} 页 · 取回 ${r.fetched}`);
    console.log(`     新建 ${r.created} · 更新 ${r.updated} · 未变 ${r.unchanged} · 跳过 ${r.skipped}`);
    console.log(`     水位 ${r.cursor ? "已保存" : "未取到"}`);
    if (r.message) console.log(`     ${r.message}`);
    if (r.status === "FAILED") process.exitCode = 1;
  }

  if (wantDailies) {
    console.log("── 日报全量 ──");
    const r = await backfillDailies({ dryRun: DRY, days: val("--days") ? Number(val("--days")) : undefined, force: has("--force") });
    console.log(`  ${r.status === "OK" ? "✅" : "❌"} ${r.status} · 索引 ${r.indexed} 天`);
    console.log(`     新建 ${r.created} · 更新 ${r.updated} · 已有跳过 ${r.unchanged} · 失败 ${r.failed}`);
    if (r.message) console.log(`     ${r.message}`);
    if (r.status === "FAILED") process.exitCode = 1;
  }

  console.log("");
  await stock();
  const drafts = await prisma.multilingualDraft.count();
  const pubs = await prisma.articlePublication.count({ where: { status: "PUBLISHED" } });
  console.log(`（本次未生成内容、未发布：草稿 ${drafts} · 已发布 ${pubs}）`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
