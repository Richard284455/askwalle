import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { assertSingleObjectValue, buildClaims, excerptHashOf } from "./claims";
import { evaluateSourceFactPackEligibility } from "./eligibility";
import { buildPackInput, computeInputHash } from "./input-snapshot";
import { isNewerFactPackInput, selectRunForEligibilityReport } from "./latest-run";
import { EXTRACTOR_VERSION, type BuildResult, type IneligibleReason } from "./types";

/**
 * 从一条已完成正文提取的 SourceItem 生成 Source Fact Pack。
 *
 * 不发网络请求、不调 AI、不改 SourceItem、不改 EnrichmentRun、
 * 不写 ResourceContent、不碰 Website/Lifecycle。全部输入来自库里已有的记录。
 */

function infraResult(sourceItemId: number, message: string): BuildResult {
  return {
    sourceItemId, enrichmentRunId: null, factPackId: null, status: "INFRA_ERROR",
    ineligibleReason: null, claimCount: 0, evidenceCount: 0, inputHash: null, message,
  };
}

function ineligible(sourceItemId: number, runId: number | null, reason: IneligibleReason, message: string): BuildResult {
  return {
    sourceItemId, enrichmentRunId: runId, factPackId: null, status: "INELIGIBLE",
    ineligibleReason: reason, claimCount: 0, evidenceCount: 0, inputHash: null, message,
  };
}

export async function buildSourceFactPack(args: {
  sourceItemId: number;
  /** 指定某一次提取；不给就自动选最新可用的那条 */
  enrichmentRunId?: number;
  extractorVersion?: string;
}): Promise<BuildResult> {
  const extractorVersion = args.extractorVersion ?? EXTRACTOR_VERSION;

  let item;
  try {
    item = await prisma.sourceItem.findUnique({
      where: { id: args.sourceItemId },
      include: { source: true },
    });
  } catch (e) {
    return infraResult(args.sourceItemId, `读取条目失败: ${e instanceof Error ? e.message : "unknown"}`);
  }
  if (!item) {
    return ineligible(args.sourceItemId, null, "SOURCE_ITEM_NOT_FOUND", "条目不存在");
  }

  try {
    // ── 选定提取记录。指定了就用指定的，仍要逐条判资格 ──────────────────
    const run = args.enrichmentRunId
      ? await prisma.sourceItemEnrichmentRun.findUnique({ where: { id: args.enrichmentRunId } })
      : await selectRunForEligibilityReport(item.id, item.source.enabled);

    const verdict = evaluateSourceFactPackEligibility({
      sourceItemId: item.id,
      sourceEnabled: item.source.enabled,
      run,
    });
    if (!verdict.eligible) {
      return ineligible(item.id, run?.id ?? null, verdict.reason, verdict.detail);
    }
    const usableRun = run!;

    // ── 已有 pack？──────────────────────────────────────────────────────
    const existing = await prisma.sourceFactPack.findUnique({
      where: {
        enrichment_run_id_extractor_version: {
          enrichment_run_id: usableRun.id,
          extractor_version: extractorVersion,
        },
      },
    });
    if (existing) {
      return {
        sourceItemId: item.id, enrichmentRunId: usableRun.id, factPackId: existing.id,
        status: "EXISTING", ineligibleReason: null,
        claimCount: existing.claim_count, evidenceCount: existing.evidence_count,
        inputHash: existing.input_hash, message: null,
      };
    }

    // 当前有效 pack（用于判定新旧与 supersede）
    const current = await prisma.sourceFactPack.findFirst({
      where: {
        source_item_id: item.id,
        extractor_version: extractorVersion,
        status: { in: ["READY", "APPROVED"] },
      },
      orderBy: [{ captured_at: "desc" }, { id: "desc" }],
    });
    if (current && !isNewerFactPackInput(usableRun, current)) {
      return {
        sourceItemId: item.id, enrichmentRunId: usableRun.id, factPackId: current.id,
        status: "OLDER_THAN_CURRENT", ineligibleReason: null,
        claimCount: current.claim_count, evidenceCount: current.evidence_count,
        inputHash: current.input_hash,
        message: `当前 pack #${current.id} 用的是更新的提取记录 #${current.enrichment_run_id}`,
      };
    }

    const input = buildPackInput({ item, source: item.source, run: usableRun, extractorVersion });
    const inputHash = computeInputHash(input);
    const claims = buildClaims(input);
    for (const c of claims) assertSingleObjectValue(c);
    const evidenceCount = claims.reduce((n, c) => n + c.evidence.length, 0);
    // 每条断言都必须有证据 —— 没有证据的「事实」不是事实
    const orphan = claims.find((c) => c.evidence.length === 0);
    if (orphan) throw new Error(`claim ${orphan.claimKey} 没有证据`);

    // ── 一个事务里完成：建 pack、写 claims/evidence、旧 pack 置 SUPERSEDED ──
    const packId = await prisma.$transaction(async (tx) => {
      const pack = await tx.sourceFactPack.create({
        data: {
          source_item_id: item.id,
          enrichment_run_id: usableRun.id,
          extractor_version: extractorVersion,
          input_hash: inputHash,
          status: "READY",
          eligibility_basis: verdict.basis,
          publisher_snapshot: input.publisher,
          source_tier_snapshot: input.sourceTier,
          source_external_key_snapshot: input.sourceExternalKey,
          source_origin_role_snapshot: input.sourceOriginRole,
          requested_url_snapshot: input.requestedUrl,
          final_url_snapshot: input.finalUrl,
          canonical_url_snapshot: input.canonicalUrl,
          document_title_snapshot: input.documentTitle,
          document_author_snapshot: input.documentAuthor,
          document_published_at_snapshot: input.documentPublishedAt,
          language_snapshot: input.language,
          content_quality_snapshot: input.contentQuality,
          content_hash_snapshot: input.contentHash,
          visible_text_length_snapshot: input.visibleTextLength,
          captured_at: input.capturedAt,
          claim_count: claims.length,
          evidence_count: evidenceCount,
        },
      });

      // 批量写入而不是逐条：每条 claim 一次往返时，十几条断言就会撑爆
      // 事务默认超时（Supabase 单次往返可达 1 秒以上）。
      await tx.sourceFactClaim.createMany({
        data: claims.map((draft) => ({
          fact_pack_id: pack.id,
          claim_key: draft.claimKey,
          claim_scope: draft.claimScope,
          claim_type: draft.claimType,
          subject: draft.subject,
          predicate: draft.predicate,
          object_type: draft.objectType,
          object_text: draft.objectText ?? null,
          object_number: draft.objectNumber ?? null,
          object_boolean: draft.objectBoolean ?? null,
          object_datetime: draft.objectDatetime ?? null,
          object_url: draft.objectUrl ?? null,
          object_json: draft.objectJson ?? Prisma.DbNull,
          certainty: draft.certainty,
          usage: draft.usage,
          confidence: draft.confidence ?? null,
          is_vendor_claim: draft.isVendorClaim ?? false,
        })),
      });
      const written = await tx.sourceFactClaim.findMany({
        where: { fact_pack_id: pack.id },
        select: { id: true, claim_key: true },
      });
      const idByKey = new Map(written.map((c) => [c.claim_key, c.id]));
      await tx.sourceFactEvidence.createMany({
        data: claims.flatMap((draft) =>
          draft.evidence.map((e) => ({
            claim_id: idByKey.get(draft.claimKey)!,
            source_item_id: item.id,
            enrichment_run_id: usableRun.id,
            origin: e.origin,
            field_path: e.fieldPath,
            excerpt: e.excerpt ?? null,
            excerpt_hash: excerptHashOf(e.excerpt),
            source_url: e.sourceUrl ?? null,
            captured_at: input.capturedAt,
          }))
        ),
        skipDuplicates: true,
      });

      // 旧 pack 不删，只标记被取代 —— 历史证据链必须留着
      if (current) {
        await tx.sourceFactPack.update({
          where: { id: current.id },
          data: { status: "SUPERSEDED", superseded_at: new Date() },
        });
      }
      return pack.id;
    }, {
      // Supabase 往返偶尔到秒级，默认 5 秒的事务窗口不够。
      // 这里放宽的是等待时间，不是任何一致性保证。
      maxWait: 15_000,
      timeout: 60_000,
    });

    return {
      sourceItemId: item.id, enrichmentRunId: usableRun.id, factPackId: packId,
      status: "BUILT", ineligibleReason: null,
      claimCount: claims.length, evidenceCount, inputHash, message: null,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // 唯一约束撞车 = 另一个 builder 已经建好了同一个 pack，返回它而不是报错
    if (message.includes("Unique constraint")) {
      const raced = await prisma.sourceFactPack
        .findUnique({
          where: {
            enrichment_run_id_extractor_version: {
              enrichment_run_id: args.enrichmentRunId ?? -1,
              extractor_version: extractorVersion,
            },
          },
        })
        .catch(() => null);
      const fallback =
        raced ??
        (await prisma.sourceFactPack
          .findFirst({
            where: { source_item_id: args.sourceItemId, extractor_version: extractorVersion },
            orderBy: { id: "desc" },
          })
          .catch(() => null));
      if (fallback) {
        return {
          sourceItemId: args.sourceItemId, enrichmentRunId: fallback.enrichment_run_id,
          factPackId: fallback.id, status: "EXISTING", ineligibleReason: null,
          claimCount: fallback.claim_count, evidenceCount: fallback.evidence_count,
          inputHash: fallback.input_hash, message: "并发生成，返回已存在的 pack",
        };
      }
    }
    return infraResult(args.sourceItemId, message.slice(0, 300));
  }
}

export { evaluateSourceFactPackEligibility } from "./eligibility";
export {
  selectLatestUsableEnrichmentRun,
  selectRunForEligibilityReport,
  isNewerFactPackInput,
} from "./latest-run";
export { buildPackInput, computeInputHash, canonicalize } from "./input-snapshot";
export { buildClaims, assertSingleObjectValue, excerptHashOf } from "./claims";
export * from "./types";
