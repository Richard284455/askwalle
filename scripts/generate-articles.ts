/**
 * 生成来源忠实的原创资讯。
 *
 *   npm run articles:generate -- --source-item-ids 1,2,3            # dry-run
 *   npm run articles:generate -- --source-item-ids 1,2,3 --apply    # 调用 provider 生成草稿
 *
 * 默认 dry-run：只报告来源输入的组装结果与模式判定，不调用 provider、不写库。
 *
 * **只生成草稿，从不发布。** 不做事实核查、不找第二来源、不查重、不聚类。
 */
import { prisma } from "@/lib/prisma";

import { generateArticle } from "@/lib/content/article-gen/generate";
import { GENERATION_VERSION } from "@/lib/content/article-gen/types";
import type { ProviderKey } from "@/lib/website/ai-provider-config";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const MAX = 20;

function flag(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
}

async function main() {
  const raw = flag("--source-item-ids");
  if (!raw) { console.error("必须指定 --source-item-ids <a,b,c>"); process.exitCode = 1; return; }
  const ids = [...new Set(raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length || ids.length > MAX) { console.error(`id 数量必须在 1–${MAX} 之间`); process.exitCode = 1; return; }

  const provider = (flag("--provider") ?? "deepseek") as ProviderKey;
  console.log(`模式: ${APPLY ? "APPLY（调用 provider 生成草稿）" : "dry-run（只组装，不调用）"}`);
  console.log(`生成版本: ${GENERATION_VERSION} · provider: ${provider}`);
  console.log(`目标: ${ids.length} 条来源\n`);

  const tally: Record<string, number> = {};
  for (const id of ids) {
    const r = await generateArticle({ sourceItemId: id, provider, dryRun: !APPLY });
    tally[r.status] = (tally[r.status] ?? 0) + 1;
    console.log(`  条目 #${id}  ${r.status}  ${r.mode ?? "-"}${r.articleId ? `  article=#${r.articleId}` : ""}`);
    if (r.headline) console.log(`      标题  ${r.headline}`);
    if (r.verdict) console.log(`      QA    ${r.verdict}${r.issueCount ? ` · ${r.issueCount} 个问题` : ""}`);
    for (const i of r.issues.slice(0, 6)) console.log(`        · ${i.code}: ${i.detail}`);
    if (r.message) console.log(`      说明  ${r.message}`);
  }
  console.log(`\n汇总: ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  if (!APPLY) console.log("\n[dry-run] 加 --apply 才调用 provider 并写库；**任何模式下都不发布**");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
