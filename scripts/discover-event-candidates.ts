/**
 * 事件候选发现。
 *
 *   npm run events:candidates -- --fact-pack-ids 30,31,32          # dry-run
 *   npm run events:candidates -- --fact-pack-ids 30,31,32 --apply  # 写库
 *   npm run events:candidates -- --latest-ready 100                # 最近的 READY pack
 *
 * 默认 dry-run：报告资格、pair 数、边分布、exact 分组与 singleton，不写任何数据。
 *
 * 不调 AI、不用 embedding、不发网络请求、不写 ResourceContent、
 * 不修改 SourceFactPack / Claim / Evidence。
 */
import { prisma } from "@/lib/prisma";

import { discoverEventCandidates } from "@/lib/content/event-clustering/builder";
import { RULE_VERSION } from "@/lib/content/event-clustering/types";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
/** 默认 fail closed：请求里有库中不存在的 pack 就停，不静默缩小输入集 */
const ALLOW_MISSING = argv.includes("--allow-missing");
const MAX_PACKS = 200;

function flag(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
}

/** 只接受显式 id 列表或明确条数。不做无上限全表运行 —— pair 数是 N² */
async function resolveTargets(): Promise<{ ids: number[]; how: string } | { error: string }> {
  const explicit = flag("--fact-pack-ids");
  if (explicit) {
    const ids = explicit.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return { error: "--fact-pack-ids 没有解析出有效 id" };
    const unique = [...new Set(ids)];
    if (unique.length > MAX_PACKS) return { error: `单次最多 ${MAX_PACKS} 个 pack` };
    return { ids: unique, how: "显式 id 列表" };
  }
  const latest = flag("--latest-ready");
  if (latest) {
    const n = Number(latest);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_PACKS) {
      return { error: `--latest-ready 必须是 1–${MAX_PACKS} 的整数` };
    }
    const packs = await prisma.sourceFactPack.findMany({
      where: { status: "READY", superseded_at: null },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      take: n,
      select: { id: true },
    });
    if (!packs.length) return { error: "没有找到 READY 状态的 Fact Pack" };
    return { ids: packs.map((p) => p.id).sort((a, b) => a - b), how: `最近 ${packs.length} 个 READY pack` };
  }
  return { error: `必须指定 --fact-pack-ids <a,b,c> 或 --latest-ready <n>（上限 ${MAX_PACKS}）` };
}

async function main() {
  const target = await resolveTargets();
  if ("error" in target) {
    console.error(target.error);
    process.exitCode = 1;
    return;
  }
  console.log(`模式: ${APPLY ? "APPLY（写库）" : "dry-run（只报告）"}`);
  console.log(`规则版本: ${RULE_VERSION}`);
  console.log(`目标: ${target.how} · ${target.ids.length} 个 pack\n`);

  const result = await discoverEventCandidates({
    factPackIds: target.ids,
    apply: APPLY,
    allowMissing: ALLOW_MISSING,
  });

  console.log(`状态          ${result.status}${result.runId ? `  run #${result.runId}` : ""}`);
  console.log(`input_hash    ${result.inputHash?.slice(0, 32) ?? "-"}…`);
  console.log(`输入 pack     ${result.inputPackCount}`);
  console.log(`合格 pack     ${result.eligiblePackCount}`);
  console.log(`pair 数       ${result.pairCount}`);
  console.log(`落库 edge     ${result.persistedEdgeCount}`);
  console.log(`exact 分组    ${result.exactGroupCount}`);
  console.log(`singleton     ${result.singletonCount}`);
  console.log(`边分布        ${Object.entries(result.edgesByClassification).map(([k, v]) => `${k}=${v}`).join(" · ") || "无"}`);
  if (result.ineligible.length) {
    console.log(`不合格        ${result.ineligible.map((i) => `#${i.factPackId}:${i.reason}`).join(" · ")}`);
  }
  if (result.message) console.log(`说明          ${result.message}`);

  if (!APPLY) {
    console.log("\n[dry-run] 加 --apply 才写库");
    console.log("注意：0 个跨来源候选也是有效结果 —— 当前来源之间本来就可能没有重叠报道。");
  }
  await prisma.$disconnect();
  if (result.status === "INFRA_ERROR" || result.status === "MISSING_INPUT") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
