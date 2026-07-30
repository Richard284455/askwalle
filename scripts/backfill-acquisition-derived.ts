/**
 * 修正既有 run 的**派生字段**。
 *
 *   npm run backfill:acquisition            # dry-run，只报告
 *   npm run backfill:acquisition -- --apply # 落库
 *
 * 修两件事：
 *   1. redirect_count —— 旧口径把请求链长度当跳数，零跳转记成 1、一跳记成 2。
 *      从 evidence_json 的完整链重算，链缺失或不可信时**跳过而不是猜**。
 *   2. metadata_json 里的 content_quality / extraction_method —— 用已有的
 *      visible_text_length 与 truncated 推导，**不发任何外部请求**。
 *
 * 只改派生字段：原始 evidence_json 的 redirectChain 一个字节都不动，
 * SourceItem 的订阅快照也不动。幂等 —— 重跑一次应当 0 变化。
 */
import { prisma } from "@/lib/prisma";

import { gradeContent, type ContentQuality, type ExtractionMethod } from "@/lib/content/html-extract";
import { redirectCountOf } from "@/lib/content/ingest";

const APPLY = process.argv.includes("--apply");

type Change = { table: string; id: number; field: string; from: unknown; to: unknown };
const changes: Change[] = [];
const skipped: string[] = [];

/** 从 evidence 里取请求链；结构不对就返回 null（不猜） */
function chainOf(evidence: unknown): { hop: number }[] | null {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  const chain = (evidence as { redirectChain?: unknown }).redirectChain;
  if (!Array.isArray(chain) || chain.length === 0) return null;
  if (!chain.every((h) => h && typeof h === "object" && typeof (h as { hop?: unknown }).hop === "number")) {
    return null;
  }
  return chain as { hop: number }[];
}

async function fixFeedRuns() {
  const runs = await prisma.contentSourceRun.findMany({
    orderBy: { id: "asc" },
    select: { id: true, source_id: true, redirect_count: true, evidence_json: true },
  });
  for (const run of runs) {
    const chain = chainOf(run.evidence_json);
    if (!chain) {
      skipped.push(`ContentSourceRun#${run.id} 无可信请求链，保持 redirect_count=${run.redirect_count}`);
      continue;
    }
    const correct = redirectCountOf(chain);
    if (correct === null || correct === run.redirect_count) continue;
    changes.push({ table: "ContentSourceRun", id: run.id, field: "redirect_count", from: run.redirect_count, to: correct });
    if (APPLY) {
      await prisma.contentSourceRun.update({ where: { id: run.id }, data: { redirect_count: correct } });
    }
  }
}

async function fixEnrichmentRuns() {
  const runs = await prisma.sourceItemEnrichmentRun.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true, source_item_id: true, redirect_count: true, evidence_json: true,
      metadata_json: true, visible_text_length: true, truncated: true, outcome: true,
      content_type: true,
    },
  });
  for (const run of runs) {
    const chain = chainOf(run.evidence_json);
    if (chain) {
      const correct = redirectCountOf(chain);
      if (correct !== null && correct !== run.redirect_count) {
        changes.push({ table: "SourceItemEnrichmentRun", id: run.id, field: "redirect_count", from: run.redirect_count, to: correct });
        if (APPLY) {
          await prisma.sourceItemEnrichmentRun.update({ where: { id: run.id }, data: { redirect_count: correct } });
        }
      }
    } else {
      skipped.push(`SourceItemEnrichmentRun#${run.id} 无可信请求链，保持 redirect_count=${run.redirect_count}`);
    }

    // 质量分级：只用已有数据推导，不重新抓页面
    const meta =
      run.metadata_json && typeof run.metadata_json === "object" && !Array.isArray(run.metadata_json)
        ? { ...(run.metadata_json as Record<string, unknown>) }
        : {};
    const quality: ContentQuality =
      run.outcome === "UNSUPPORTED"
        ? "UNSUPPORTED"
        : run.truncated
          ? "TRUNCATED"
          : gradeContent(run.visible_text_length ?? 0);
    const method: ExtractionMethod =
      typeof meta.container === "string" && ["article", "main", "body"].includes(meta.container)
        ? (meta.container.toUpperCase() as ExtractionMethod)
        : (run.visible_text_length ?? 0) > 0
          ? "BODY"
          : "NONE";

    const wantedQuality = meta.contentQuality !== quality;
    const wantedMethod = meta.extractionMethod !== method;
    if (!wantedQuality && !wantedMethod) continue;
    if (wantedQuality) {
      changes.push({ table: "SourceItemEnrichmentRun", id: run.id, field: "metadata.contentQuality", from: meta.contentQuality ?? null, to: quality });
    }
    if (wantedMethod) {
      changes.push({ table: "SourceItemEnrichmentRun", id: run.id, field: "metadata.extractionMethod", from: meta.extractionMethod ?? null, to: method });
    }
    if (APPLY) {
      await prisma.sourceItemEnrichmentRun.update({
        where: { id: run.id },
        data: { metadata_json: { ...meta, contentQuality: quality, extractionMethod: method } },
      });
    }
  }
}

async function main() {
  console.log(`模式: ${APPLY ? "APPLY（写库）" : "dry-run（只报告）"}\n`);
  const before = {
    resourceContent: await prisma.resourceContent.count(),
    sourceItem: await prisma.sourceItem.count(),
  };

  await fixFeedRuns();
  await fixEnrichmentRuns();

  if (!changes.length) console.log("无需要修正的派生字段 ✅（幂等）");
  for (const c of changes) {
    console.log(`  ${c.table}#${c.id}  ${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
  }
  if (skipped.length) {
    console.log(`\n跳过（不猜）：`);
    for (const s of skipped) console.log(`  ${s}`);
  }

  const after = {
    resourceContent: await prisma.resourceContent.count(),
    sourceItem: await prisma.sourceItem.count(),
  };
  console.log(`\n合计 ${changes.length} 处${APPLY ? "已修正" : "待修正"} · 跳过 ${skipped.length}`);
  console.log(`ResourceContent ${before.resourceContent} → ${after.resourceContent} · SourceItem ${before.sourceItem} → ${after.sourceItem}`);
  if (!APPLY && changes.length) console.log("\n[dry-run] 加 --apply 才写库");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
