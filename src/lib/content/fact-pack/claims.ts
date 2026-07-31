import crypto from "crypto";

import type { FactEvidenceOrigin } from "@prisma/client";

import { EVIDENCE_EXCERPT_MAX, type ClaimDraft, type EvidenceDraft, type PackInput } from "./types";

/**
 * 确定性断言生成。
 *
 * 只生成**我们直接观察到**的文档事实与来源身份事实，全部 certainty=OBSERVED。
 *
 * 明确不生成：「某公司发布了某模型」「产品增加了某功能」「性能提升 X%」
 * 「价格变化」「这是重大行业事件」，以及任何标题或正文里的自然语言断言。
 * 那些需要读懂语义，属于后续的 claim extraction —— 在这里生成它们，等于把
 * 一次字符串匹配伪装成一条已核实的事实。
 */

/** provenance 词汇 → 证据来源枚举。认不出的一律回落 PAGE，不猜 */
function originOfProvenance(source: string): FactEvidenceOrigin {
  switch (source) {
    case "FEED":
      return "FEED";
    case "JSON_LD":
      return "JSON_LD";
    case "OPEN_GRAPH":
      return "OPEN_GRAPH";
    case "META":
      return "META";
    case "HTML_TITLE":
      return "HTML_TITLE";
    default:
      return "PAGE";
  }
}

/** provenance 是 FEED 时，字段路径要指回订阅快照而不是页面 */
function fieldPathOfProvenance(source: string, pageField: string, feedField: string): string {
  return source === "FEED" ? feedField : pageField;
}

export function excerptHashOf(excerpt: string | null | undefined): string | null {
  if (!excerpt) return null;
  return crypto.createHash("sha256").update(excerpt).digest("hex").slice(0, 32);
}

function clip(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, EVIDENCE_EXCERPT_MAX);
}

export function buildClaims(input: PackInput): ClaimDraft[] {
  const subject = input.canonicalUrl ?? input.finalUrl ?? input.requestedUrl;
  const sourceSubject = input.sourceExternalKey ?? `source:${input.publisher}`;
  const claims: ClaimDraft[] = [];

  const ev = (
    origin: FactEvidenceOrigin,
    fieldPath: string,
    excerpt?: string | null
  ): EvidenceDraft => ({
    origin,
    fieldPath,
    excerpt: clip(excerpt),
    sourceUrl: input.finalUrl ?? input.requestedUrl,
  });

  // ── SOURCE 范围：来源身份来自配置，**永远不从落地域推断** ──────────────
  claims.push({
    claimKey: "source.publisher",
    claimScope: "SOURCE",
    claimType: "source_identity",
    subject: sourceSubject,
    predicate: "publisher",
    objectType: "TEXT",
    objectText: input.publisher,
    certainty: "OBSERVED",
    usage: "CITABLE",
    evidence: [ev("SOURCE_CONFIG", "ContentSource.publisher", input.publisher)],
  });
  if (input.sourceTier) {
    claims.push({
      claimKey: "source.tier",
      claimScope: "SOURCE",
      claimType: "source_identity",
      subject: sourceSubject,
      predicate: "source_tier",
      objectType: "TEXT",
      objectText: input.sourceTier,
      certainty: "OBSERVED",
      usage: "CONTEXT_ONLY",
      evidence: [ev("SOURCE_CONFIG", "ContentSource.source_tier", input.sourceTier)],
    });
  }
  if (input.sourceExternalKey) {
    claims.push({
      claimKey: "source.external_key",
      claimScope: "SOURCE",
      claimType: "source_identity",
      subject: sourceSubject,
      predicate: "external_key",
      objectType: "TEXT",
      objectText: input.sourceExternalKey,
      certainty: "OBSERVED",
      usage: "CONTEXT_ONLY",
      evidence: [ev("SOURCE_CONFIG", "ContentSource.external_key", input.sourceExternalKey)],
    });
  }

  // ── DOCUMENT 范围 ────────────────────────────────────────────────────
  // 标题是**文档的标题**，不是「已确认发生了什么」。usage 因此是 CONTEXT_ONLY：
  // 它可以用来指代这篇文档，但不能单独当作事件依据。
  if (input.documentTitle) {
    claims.push({
      claimKey: "document.title",
      claimScope: "DOCUMENT",
      claimType: "document_metadata",
      subject,
      predicate: "title",
      objectType: "TEXT",
      objectText: input.documentTitle,
      certainty: "OBSERVED",
      usage: "CONTEXT_ONLY",
      evidence: [
        ev(
          originOfProvenance(input.titleSource),
          fieldPathOfProvenance(input.titleSource, "SourceItemEnrichmentRun.page_title", "SourceItem.title"),
          input.documentTitle
        ),
      ],
    });
  }
  if (input.canonicalUrl) {
    claims.push({
      claimKey: "document.canonical_url",
      claimScope: "DOCUMENT",
      claimType: "document_identity",
      subject,
      predicate: "canonical_url",
      objectType: "URL",
      objectUrl: input.canonicalUrl,
      certainty: "OBSERVED",
      usage: "CITABLE",
      evidence: [ev("CANONICAL_LINK", "SourceItemEnrichmentRun.canonical_url", input.canonicalUrl)],
    });
  }
  if (input.finalUrl) {
    claims.push({
      claimKey: "document.final_url",
      claimScope: "DOCUMENT",
      claimType: "document_identity",
      subject,
      predicate: "final_url",
      objectType: "URL",
      objectUrl: input.finalUrl,
      certainty: "OBSERVED",
      usage: "CITABLE",
      evidence: [ev("PAGE", "SourceItemEnrichmentRun.final_url", input.finalUrl)],
    });
  }
  if (input.documentPublishedAt) {
    claims.push({
      claimKey: "document.published_at",
      claimScope: "DOCUMENT",
      claimType: "document_metadata",
      subject,
      predicate: "published_at",
      objectType: "DATETIME",
      objectDatetime: input.documentPublishedAt,
      certainty: "OBSERVED",
      // 订阅日期是订阅的说法，不是页面自己的声明 —— 分量低一档
      usage: input.publishedAtSource === "FEED" ? "CONTEXT_ONLY" : "CITABLE",
      evidence: [
        ev(
          originOfProvenance(input.publishedAtSource),
          fieldPathOfProvenance(
            input.publishedAtSource,
            "SourceItemEnrichmentRun.page_published_at",
            "SourceItem.published_at"
          ),
          input.documentPublishedAt.toISOString()
        ),
      ],
    });
  }
  // 没有作者就是没有 —— 不生成空壳 claim，更不拿 publisher 顶替
  if (input.documentAuthor) {
    claims.push({
      claimKey: "document.author",
      claimScope: "DOCUMENT",
      claimType: "document_metadata",
      subject,
      predicate: "author",
      objectType: "TEXT",
      objectText: input.documentAuthor,
      certainty: "OBSERVED",
      usage: input.authorSource === "FEED" ? "CONTEXT_ONLY" : "CITABLE",
      evidence: [
        ev(
          originOfProvenance(input.authorSource),
          fieldPathOfProvenance(input.authorSource, "SourceItemEnrichmentRun.author", "SourceItem.author"),
          input.documentAuthor
        ),
      ],
    });
  }
  if (input.language) {
    claims.push({
      claimKey: "document.language",
      claimScope: "DOCUMENT",
      claimType: "document_metadata",
      subject,
      predicate: "language",
      objectType: "TEXT",
      objectText: input.language,
      certainty: "OBSERVED",
      usage: "CONTEXT_ONLY",
      evidence: [ev("PAGE", "SourceItemEnrichmentRun.language", input.language)],
    });
  }
  claims.push({
    claimKey: "document.content_quality",
    claimScope: "DOCUMENT",
    claimType: "document_quality",
    subject,
    predicate: "content_quality",
    objectType: "TEXT",
    objectText: input.contentQuality,
    certainty: "OBSERVED",
    usage: "CONTEXT_ONLY",
    evidence: [ev("PAGE", "SourceItemEnrichmentRun.metadata_json.contentQuality", input.contentQuality)],
  });
  if (input.contentHash) {
    claims.push({
      claimKey: "document.content_hash",
      claimScope: "DOCUMENT",
      claimType: "document_identity",
      subject,
      predicate: "content_hash",
      objectType: "TEXT",
      objectText: input.contentHash,
      certainty: "OBSERVED",
      usage: "CONTEXT_ONLY",
      evidence: [ev("PAGE", "SourceItemEnrichmentRun.content_hash", input.contentHash)],
    });
  }
  claims.push({
    claimKey: "document.cross_domain_redirect",
    claimScope: "DOCUMENT",
    claimType: "document_acquisition",
    subject,
    predicate: "cross_domain_redirect",
    objectType: "BOOLEAN",
    objectBoolean: input.crossDomainRedirect,
    certainty: "OBSERVED",
    usage: "CONTEXT_ONLY",
    evidence: [
      ev(
        "PAGE",
        "SourceItemEnrichmentRun.metadata_json.crossDomainRedirect",
        `${input.requestedHost ?? "?"} → ${input.finalHost ?? "?"}`
      ),
    ],
  });
  if (input.visibleTextLength !== null) {
    claims.push({
      claimKey: "document.visible_text_length",
      claimScope: "DOCUMENT",
      claimType: "document_quality",
      subject,
      predicate: "visible_text_length",
      objectType: "NUMBER",
      objectNumber: input.visibleTextLength,
      certainty: "OBSERVED",
      usage: "CONTEXT_ONLY",
      evidence: [
        ev(
          "PAGE",
          "SourceItemEnrichmentRun.visible_text_length",
          String(input.visibleTextLength)
        ),
      ],
    });
  }
  claims.push({
    claimKey: "document.captured_at",
    claimScope: "DOCUMENT",
    claimType: "document_acquisition",
    subject,
    predicate: "captured_at",
    objectType: "DATETIME",
    objectDatetime: input.capturedAt,
    certainty: "OBSERVED",
    usage: "CITABLE",
    evidence: [
      ev("PAGE", "SourceItemEnrichmentRun.started_at", input.capturedAt.toISOString()),
    ],
  });

  return claims;
}

/** object 字段恰好一个有值。代码这一层先挡，数据库 CHECK 是最后一道闸 */
export function assertSingleObjectValue(claim: ClaimDraft): void {
  const present = [
    claim.objectText,
    claim.objectNumber,
    claim.objectBoolean,
    claim.objectDatetime,
    claim.objectUrl,
    claim.objectJson,
  ].filter((v) => v !== undefined && v !== null).length;
  if (present !== 1) {
    throw new Error(`claim ${claim.claimKey} 的 object 字段有 ${present} 个值，必须恰好 1 个`);
  }
}
