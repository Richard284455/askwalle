import crypto from "crypto";

import { prisma } from "@/lib/prisma";

import { MIN_SOURCE_CHARS, type SourceArticleInput } from "./types";

/**
 * 组装生成所需的来源输入。
 *
 * 两种模式的判定只看「有没有成功提取到文章正文」，不看事件、不看重复、
 * 不看有没有第二来源 —— 那些判断已经从这条链路上移除。
 */

/**
 * 只接受真正的 http/https 地址。
 *
 * SourceItem.canonical_url 存的是页面自称的 canonical **或订阅里的 guid** ——
 * 而 guid 常常是哈希（AWS 就是）。直接拿它当署名链接，发出去就是坏链接。
 */
function httpUrlOrNull(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export type AssembleResult =
  | { ok: true; input: SourceArticleInput }
  | { ok: false; reason: "SOURCE_ITEM_NOT_FOUND" | "SOURCE_INSUFFICIENT"; detail: string };

export async function assembleSourceInput(sourceItemId: number): Promise<AssembleResult> {
  const item = await prisma.sourceItem.findUnique({
    where: { id: sourceItemId },
    include: { source: true },
  });
  if (!item) return { ok: false, reason: "SOURCE_ITEM_NOT_FOUND", detail: `条目 #${sourceItemId} 不存在` };

  // 优先用已有的 fact pack（说明正文提取成功且分量足够）
  const pack = await prisma.sourceFactPack.findFirst({
    where: { source_item_id: sourceItemId, status: { in: ["READY", "APPROVED"] } },
    orderBy: [{ captured_at: "desc" }, { id: "desc" }],
    include: { claims: { orderBy: { id: "asc" } } },
  });

  if (pack) {
    const run = await prisma.sourceItemEnrichmentRun.findUnique({ where: { id: pack.enrichment_run_id } });
    const text = (run?.excerpt ?? "").trim();
    if (text.length >= MIN_SOURCE_CHARS) {
      return {
        ok: true,
        input: {
          sourceItemId, factPackId: pack.id, mode: "FULL_SOURCE", evidenceMode: "ARTICLE_PAGE",
          publisher: pack.publisher_snapshot,
          sourceUrl: httpUrlOrNull(pack.canonical_url_snapshot)
            ?? httpUrlOrNull(pack.final_url_snapshot) ?? pack.requested_url_snapshot,
          canonicalUrl: httpUrlOrNull(pack.canonical_url_snapshot),
          title: pack.document_title_snapshot ?? item.title,
          author: pack.document_author_snapshot,
          publishedAt: pack.document_published_at_snapshot,
          capturedAt: pack.captured_at,
          sourceText: text,
          claims: pack.claims.map((c) => ({
            key: c.claim_key, predicate: c.predicate,
            value: c.object_text ?? c.object_url ?? c.object_datetime?.toISOString()
              ?? (c.object_number !== null ? String(c.object_number) : "")
              ?? (c.object_boolean !== null ? String(c.object_boolean) : ""),
          })),
          language: pack.language_snapshot,
        },
      };
    }
  }

  // 退到订阅字段。**不**把它包装成 SUBSTANTIAL 的 fact pack
  const feedText = [item.raw_excerpt, item.raw_content].filter(Boolean).join("\n").trim();
  const available = `${item.title}\n${feedText}`.trim();
  if (available.length < MIN_SOURCE_CHARS) {
    return {
      ok: false, reason: "SOURCE_INSUFFICIENT",
      detail: `可用信息仅 ${available.length} 字符，不足以写出忠实的短讯`,
    };
  }
  return {
    ok: true,
    input: {
      sourceItemId, factPackId: null, mode: "FEED_ONLY_BRIEF", evidenceMode: "FEED",
      publisher: item.source.publisher,
      sourceUrl: httpUrlOrNull(item.canonical_url) ?? httpUrlOrNull(item.final_url) ?? item.url,
      canonicalUrl: httpUrlOrNull(item.canonical_url),
      title: item.title,
      author: item.author,
      publishedAt: item.published_at,
      capturedAt: item.fetched_at,
      sourceText: feedText,
      claims: [],
      language: item.lang,
    },
  };
}

/** 同一份来源输入 + 同一生成版本 → 同一指纹，重试不重复生成 */
export function computeSourceInputHash(input: SourceArticleInput, generationVersion: string): string {
  const payload = {
    generationVersion,
    sourceItemId: input.sourceItemId,
    mode: input.mode,
    publisher: input.publisher,
    sourceUrl: input.sourceUrl,
    title: input.title,
    author: input.author ?? null,
    publishedAt: input.publishedAt?.toISOString() ?? null,
    sourceText: input.sourceText,
    claims: [...input.claims].sort((a, b) => a.key.localeCompare(b.key)),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
