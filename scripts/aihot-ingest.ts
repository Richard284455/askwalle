/**
 * AI HOT 三类内容的入库。
 *
 *   npm run aihot:ingest -- --dry-run                  # 只取不写
 *   npm run aihot:ingest -- --selected --limit 10      # 只入精选
 *   npm run aihot:ingest -- --all --ignore-etag        # 三类全入，忽略条件请求
 *
 * 只走 AI HOT API v1，不抓网页。
 * 不写 SourceItem / ContentSource，不建 fact pack，不聚类、不去重。
 */
import { ingestDaily, ingestHotTopics, ingestSelected, type IngestResult } from "@/lib/content/aihot/ingest";
import { prisma } from "@/lib/prisma";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

const DRY = has("--dry-run");
const IGNORE_ETAG = has("--ignore-etag");
const ALL = has("--all") || (!has("--selected") && !has("--hot-topics") && !has("--daily"));

function report(r: IngestResult) {
  const mark = r.status === "OK" ? "✅" : r.status === "NOT_MODIFIED" ? "＝" : "❌";
  console.log(`  ${mark} ${r.endpoint}`);
  console.log(`     状态 ${r.status} · 取回 ${r.fetched} · 新建 ${r.created} · 更新 ${r.updated} · 未变 ${r.unchanged}`);
  if (r.message) console.log(`     ${r.message}`);
  for (const s of r.skipped) console.log(`     ⚠ 跳过 ${s.ref}: ${s.reason}`);
}

async function main() {
  console.log(`AI HOT 入库${DRY ? "（dry-run）" : ""}${IGNORE_ETAG ? " · 忽略 ETag" : ""}\n`);
  const opts = { dryRun: DRY, ignoreEtag: IGNORE_ETAG };
  const results: IngestResult[] = [];

  if (ALL || has("--selected")) {
    console.log("── 精选资讯 ──");
    const r = await ingestSelected({
      window: val("--window") ?? "24h",
      limit: Number(val("--limit") ?? 100),
      ...opts,
    });
    report(r); results.push(r);
  }
  if (ALL || has("--hot-topics")) {
    console.log("── 当前热点 ──");
    const r = await ingestHotTopics({ limit: val("--topic-limit") ? Number(val("--topic-limit")) : undefined, ...opts });
    report(r); results.push(r);
  }
  if (ALL || has("--daily")) {
    console.log("── AI 日报 ──");
    const r = await ingestDaily({ date: val("--date"), ...opts });
    report(r); results.push(r);
  }

  const failed = results.filter((r) => r.status === "FAILED");
  console.log(`\n合计：成功 ${results.filter((r) => r.status === "OK").length} · 未变化 ${results.filter((r) => r.status === "NOT_MODIFIED").length} · 失败 ${failed.length}`);

  if (!DRY) {
    const [s, t, d] = await Promise.all([
      prisma.aihotSelectedItem.count(), prisma.aihotHotTopicSnapshot.count(), prisma.aihotDailyReport.count(),
    ]);
    console.log(`库中：精选 ${s} · 热点快照 ${t} · 日报 ${d}`);
  }
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
