/**
 * 自动审核与自动发布。
 *
 *   npm run aihot:auto -- preview                    # 全部待处理家族，只算不写（不留记录）
 *   npm run aihot:auto -- preview --family 235       # 只看一个
 *   npm run aihot:auto -- preview --no-llm           # 只跑确定性闸门，不花 provider 的钱
 *   npm run aihot:auto -- run                        # 审核 + 通过则发布（真的写库、真的上线）
 *   npm run aihot:auto -- run --limit 5              # 先跑几个看看
 *   npm run aihot:auto -- run --no-publish           # 只审核、留记录，不发布
 *   npm run aihot:auto -- withdraw --family 235 --reviewer 张三 --reason "..."
 *   npm run aihot:auto -- withdrawn                  # 列出已撤下的
 *
 * `preview` 是默认命令 —— 会真的上线的操作不该是默认值。
 */
import { autoReviewFamily } from "@/lib/content/publishing/auto-review";
import { publishFamily } from "@/lib/content/publishing/publish";
import { loadQueue, tabOf, type QueueRow } from "@/lib/content/publishing/queue";
import { listWithdrawn, withdrawFamily } from "@/lib/content/publishing/withdraw";
import { prisma } from "@/lib/prisma";

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("--")) ?? "preview";
const has = (f: string) => argv.includes(f);
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

const LLM = !has("--no-llm");
const LIMIT = Number(val("--limit") ?? "0") || Infinity;

/** 还没上线、值得跑一次自动审核的家族 */
async function pendingRows(): Promise<QueueRow[]> {
  const { rows } = await loadQueue({ tab: "ALL", limit: 1000 });
  return rows.filter((r) => {
    const tab = tabOf(r);
    // 已发布、已撤下、已被人工拒绝的都不再自动处理 ——
    // 撤下是人的决定，自动链路不该把它推翻
    return tab === "NEEDS_REVIEW" || tab === "QA_FAILED" || tab === "APPROVED";
  });
}

function fmtFailures(locales: { locale: string; failures: { key: string; detail: string }[] }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of locales) {
    for (const f of l.failures) {
      const k = `${f.key}|${f.detail}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(`       ${l.locale} ${f.key}：${f.detail}`);
    }
  }
  return out.slice(0, 8);
}

async function cmdReview(opts: { dryRun: boolean; publish: boolean }) {
  const only = val("--family");
  const rows = only
    ? (await loadQueue({ tab: "ALL", limit: 1000 })).rows.filter((r) => r.familyId === Number(only))
    : await pendingRows();
  const targets = rows.slice(0, LIMIT);

  console.log(
    `${opts.dryRun ? "预演" : "执行"}：${targets.length} 个家族` +
    `｜模型复看 ${LLM ? "开" : "关"}｜通过后${opts.publish ? "发布" : "不发布"}\n`
  );

  let approved = 0, blocked = 0, published = 0, providerCalls = 0, vetoed = 0;
  const blockReasons = new Map<string, number>();

  for (const row of targets) {
    const r = await autoReviewFamily(row.familyId, { dryRun: opts.dryRun, llm: LLM });
    providerCalls += r.providerCalls;
    if (r.llm.verdict === "BLOCK") vetoed++;

    const head = `#${row.familyId} ${row.contentKind} ${(row.masterHeadline ?? row.unitKey).slice(0, 64)}`;
    if (r.status === "APPROVED") {
      approved++;
      console.log(`  ✅ ${head}`);
      if (r.llm.verdict === "UNAVAILABLE") console.log(`       （模型复看未跑成：${r.llm.message ?? ""}）`);
      if (opts.publish && !opts.dryRun) {
        const p = await publishFamily({ familyId: row.familyId });
        const n = p.outcomes.filter((o) => o.status === "PUBLISHED").length;
        published += n;
        if (p.ok) console.log(`       已上线 ${n} 条：${p.outcomes.map((o) => o.path).filter(Boolean)[0] ?? ""}`);
        else console.log(`       ⚠️ 预检拦下：${p.blocked.map((b) => b.code).join("、")}`);
      }
    } else {
      blocked++;
      console.log(`  ⛔ ${head}`);
      if (r.status !== "BLOCKED") console.log(`       ${r.status}：${r.message ?? ""}`);
      for (const line of fmtFailures(r.locales)) console.log(line);
      for (const l of r.locales) {
        for (const f of l.failures) blockReasons.set(f.key, (blockReasons.get(f.key) ?? 0) + 1);
      }
    }
  }

  console.log(`\n通过 ${approved} · 拦下 ${blocked} · 模型否决 ${vetoed} · provider 调用 ${providerCalls}`);
  if (opts.publish && !opts.dryRun) console.log(`新上线页面 ${published} 条`);
  if (blockReasons.size) {
    console.log("\n拦下原因分布：");
    for (const [k, n] of [...blockReasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
}

async function cmdWithdraw() {
  const familyId = Number(val("--family"));
  const reviewer = val("--reviewer");
  const reason = val("--reason");
  if (!Number.isInteger(familyId) || !reviewer || !reason) {
    console.error("用法：withdraw --family <id> --reviewer <姓名> --reason <理由>");
    process.exitCode = 1;
    return;
  }
  const r = await withdrawFamily({
    familyId, reason,
    reviewer: { type: "HUMAN", id: `cli:${reviewer}`, name: reviewer },
    dryRun: has("--dry-run"),
  });
  if (!r.ok) { console.error(`❌ ${r.reason}`); process.exitCode = 1; return; }
  console.log(`✅ ${r.unitKey} 已撤下 ${r.withdrawn.length} 条${r.dryRun ? "（dry-run）" : ""}`);
  for (const w of r.withdrawn) console.log(`   ${w.locale} ${w.path}`);
  if (r.reviewErrors.length) console.log(`   ⚠️ 复核记录写入失败：${r.reviewErrors.join("；")}`);
}

async function cmdWithdrawn() {
  const rows = await listWithdrawn();
  if (!rows.length) { console.log("没有已撤下的页面"); return; }
  console.log(`已撤下 ${rows.length} 条\n`);
  for (const r of rows) {
    console.log(`  ${r.path}`);
    console.log(`     family #${r.translation.family_id} ${r.translation.family.unit_key}`);
    console.log(`     ${r.published_at.toISOString().slice(0, 16)} 上线 → ${r.unpublished_at?.toISOString().slice(0, 16) ?? "?"} 撤下`);
    console.log(`     ${r.withdrawn_by ?? "?"}：${r.withdrawn_reason ?? ""}`);
  }
}

async function main() {
  if (cmd === "preview") await cmdReview({ dryRun: true, publish: false });
  else if (cmd === "run") await cmdReview({ dryRun: false, publish: !has("--no-publish") });
  else if (cmd === "withdraw") await cmdWithdraw();
  else if (cmd === "withdrawn") await cmdWithdrawn();
  else console.error(`未知命令：${cmd}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
