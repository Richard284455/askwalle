/**
 * 生成 Source Fact Pack。
 *
 *   npm run factpacks:build -- --source-item-ids 1,2,3            # dry-run
 *   npm run factpacks:build -- --source-item-ids 1,2,3 --apply    # 写库
 *   npm run factpacks:build -- --latest-enriched 10               # 最近增强过的 N 条
 *
 * 默认 dry-run：只显示会选中哪些条目、各自是否够格、原因是什么，不写任何数据。
 *
 * 不发网络请求、不调 AI、不重跑 enrichment、不写 ResourceContent、
 * 不改 SourceItem 或 EnrichmentRun。全部输入来自库里已有的记录。
 */
import { prisma } from "@/lib/prisma";

import { buildSourceFactPack } from "@/lib/content/fact-pack/builder";
import { evaluateSourceFactPackEligibility } from "@/lib/content/fact-pack/eligibility";
import { selectRunForEligibilityReport } from "@/lib/content/fact-pack/latest-run";
import { EXTRACTOR_VERSION } from "@/lib/content/fact-pack/types";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");

function flag(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
}

/** 只接受明确的 id 列表或明确的条数，不做无上限全表构建 */
async function resolveTargets(): Promise<{ ids: number[]; how: string } | { error: string }> {
  const explicit = flag("--source-item-ids");
  if (explicit) {
    const ids = explicit
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return { error: "--source-item-ids 没有解析出有效 id" };
    return { ids: [...new Set(ids)], how: "显式 id 列表" };
  }
  const latest = flag("--latest-enriched");
  if (latest) {
    const n = Number(latest);
    if (!Number.isInteger(n) || n <= 0 || n > 200) return { error: "--latest-enriched 必须是 1–200 的整数" };
    const runs = await prisma.sourceItemEnrichmentRun.findMany({
      where: { outcome: "OK" },
      orderBy: [{ started_at: "desc" }, { id: "desc" }],
      take: n * 3,
      select: { source_item_id: true },
    });
    const ids: number[] = [];
    for (const r of runs) {
      if (!ids.includes(r.source_item_id)) ids.push(r.source_item_id);
      if (ids.length >= n) break;
    }
    if (!ids.length) return { error: "没有找到已完成正文提取的条目" };
    return { ids, how: `最近增强的 ${ids.length} 条` };
  }
  return { error: "必须指定 --source-item-ids <a,b,c> 或 --latest-enriched <n>" };
}

async function main() {
  const target = await resolveTargets();
  if ("error" in target) {
    console.error(target.error);
    process.exitCode = 1;
    return;
  }
  console.log(`模式: ${APPLY ? "APPLY（写库）" : "dry-run（只报告）"}`);
  console.log(`提取器: ${EXTRACTOR_VERSION}`);
  console.log(`目标: ${target.how} · ${target.ids.length} 条\n`);

  const tally: Record<string, number> = {};
  const bump = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);

  for (const id of target.ids) {
    const item = await prisma.sourceItem.findUnique({ where: { id }, include: { source: true } });
    if (!item) {
      console.log(`  条目 #${id}  ✗ 不存在`);
      bump("NOT_FOUND");
      continue;
    }
    const run = await selectRunForEligibilityReport(id, item.source.enabled);
    const verdict = evaluateSourceFactPackEligibility({
      sourceItemId: id,
      sourceEnabled: item.source.enabled,
      run,
    });

    if (!APPLY) {
      const label = verdict.eligible ? `✓ 合格（${verdict.basis}）` : `✗ ${verdict.reason}`;
      console.log(
        `  条目 #${id}  ${label}\n` +
          `      run=${run?.id ?? "-"}  正文=${run?.visible_text_length ?? "-"}  ${item.title.slice(0, 60)}` +
          (verdict.eligible ? "" : `\n      ${verdict.detail}`)
      );
      bump(verdict.eligible ? "ELIGIBLE" : verdict.reason);
      continue;
    }

    const built = await buildSourceFactPack({ sourceItemId: id });
    bump(built.status);
    console.log(
      `  条目 #${id}  ${built.status}` +
        (built.factPackId ? `  pack=#${built.factPackId}` : "") +
        `  run=${built.enrichmentRunId ?? "-"}` +
        (built.status === "BUILT" || built.status === "EXISTING"
          ? `  claims=${built.claimCount} evidence=${built.evidenceCount}`
          : `  ${built.ineligibleReason ?? ""} ${built.message ?? ""}`)
    );
  }

  console.log(`\n汇总: ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  if (!APPLY) console.log("\n[dry-run] 加 --apply 才写库");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
