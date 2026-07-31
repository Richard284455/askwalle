import { Prisma, type ArticleGenerationMode } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { resolveProviderRuntime, type ProviderKey } from "@/lib/website/ai-provider-config";

import { checkFaithfulness } from "./faithfulness";
import { assembleSourceInput, computeSourceInputHash } from "./source-input";
import {
  BRIEF_MAX_CHARS, DEFAULT_VARIANT, FULL_MAX_CHARS, GENERATION_VERSION,
  type GeneratedDraft, type SourceArticleInput,
} from "./types";

/**
 * 生成一篇忠实于来源的原创资讯。
 *
 * 不做事实核查、不找第二来源、不查重、不聚类。内容与历史文章重复**不是**
 * 拒绝理由 —— 那是产品有意的选择，不是疏漏。
 */

const TIMEOUT_MS = 120_000;

export type GenerateResult = {
  sourceItemId: number;
  articleId: number | null;
  status: "DRAFTED" | "EXISTING" | "SOURCE_INSUFFICIENT" | "GENERATION_FAILED" | "FAITHFULNESS_FAILED";
  mode: ArticleGenerationMode | null;
  verdict: "PASSED" | "NEEDS_REWRITE" | "BLOCKED_SOURCE_INSUFFICIENT" | null;
  issueCount: number;
  issues: { code: string; detail: string }[];
  headline: string | null;
  message: string | null;
};

/**
 * 生成提示词。
 *
 * 三条最容易被违反、后果也最重的约束放在最前面：不改数字、不加事实、不改归属。
 * 「把预测写成结果」单独点名 —— 那是最隐蔽的失真，读者会以为事情已经发生了。
 */
export function buildPrompt(input: SourceArticleInput): string {
  const limit = input.mode === "FEED_ONLY_BRIEF" ? BRIEF_MAX_CHARS : FULL_MAX_CHARS;
  const claimLines = input.claims.length
    ? input.claims.map((c) => `- ${c.predicate}: ${c.value}`).join("\n")
    : "（无结构化断言）";

  return `你是一名资讯编辑。请**仅依据下面这一份来源材料**，用你自己的语言写一篇中文原创资讯。

═══ 硬性约束（违反任何一条即为不合格）═══
1. 不得引入来源材料中没有的任何事实、数字、日期、人名、机构名、产品名或结论。
2. 数字、百分比、金额、日期、型号与版本号必须与来源**逐字一致**，不得换算、取整或改写。
3. 来源的观点、预测、声明必须保留归属（例如「${input.publisher} 表示」「据该公告」）。
   **不得把计划或预期写成已经完成的事实。**
4. 不得逐字照搬来源的长段落；要重新组织结构与表达。
5. 不得推断来源未声明的因果关系，不得为凑篇幅编造细节。
6. 正文必须提及发布者「${input.publisher}」。
7. 正文长度不超过 ${limit} 字符。${input.mode === "FEED_ONLY_BRIEF" ? "本条只有订阅摘要，可用信息很少，写成简讯即可，宁短勿编。" : ""}

═══ 来源材料 ═══
发布者：${input.publisher}
标题：${input.title}
${input.author ? `作者：${input.author}\n` : ""}${input.publishedAt ? `发布时间：${input.publishedAt.toISOString().slice(0, 10)}\n` : ""}地址：${input.sourceUrl}

正文材料：
${input.sourceText}

来源结构化断言：
${claimLines}

═══ 输出格式 ═══
只输出 JSON，不要额外说明：
{
  "headline": "改写后的标题",
  "shortSummary": "一到两句话的摘要",
  "body": "正文",
  "factMapping": [{ "fact": "文章中的某条事实", "sourceEvidence": "来源中对应的原话或字段" }]
}`;
}

function parseDraft(raw: unknown): GeneratedDraft | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { obj = JSON.parse(m[0]); } catch { return null; }
  }
  if (!obj || typeof obj !== "object") return null;
  const r = obj as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const headline = str(r.headline);
  const shortSummary = str(r.shortSummary);
  const body = str(r.body);
  if (!headline || !shortSummary || !body) return null;
  const mapping = Array.isArray(r.factMapping)
    ? r.factMapping.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
        .map((x) => ({ fact: str(x.fact), sourceEvidence: str(x.sourceEvidence) }))
        .filter((x) => x.fact)
    : [];
  return { headline, shortSummary, body, factMapping: mapping };
}

async function callProvider(
  providerKey: ProviderKey, model: string | undefined, prompt: string
): Promise<{ ok: true; content: string; model: string } | { ok: false; message: string }> {
  const runtime = await resolveProviderRuntime(providerKey, model);
  if (!runtime.ok) return { ok: false, message: runtime.message };
  try {
    const res = await fetch(`${runtime.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${runtime.apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: runtime.model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    const body = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return { ok: false, message: "provider 未返回内容" };
    return { ok: true, content, model: runtime.model };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 200) : "请求失败" };
  }
}

export async function generateArticle(args: {
  sourceItemId: number;
  provider?: ProviderKey;
  model?: string;
  variant?: string;
  generationVersion?: string;
  /** 只组装与检查，不调用 provider、不写库 */
  dryRun?: boolean;
}): Promise<GenerateResult> {
  const version = args.generationVersion ?? GENERATION_VERSION;
  const variant = args.variant ?? DEFAULT_VARIANT;
  const base: GenerateResult = {
    sourceItemId: args.sourceItemId, articleId: null, status: "GENERATION_FAILED",
    mode: null, verdict: null, issueCount: 0, issues: [], headline: null, message: null,
  };

  const assembled = await assembleSourceInput(args.sourceItemId);
  if (!assembled.ok) {
    if (args.dryRun) {
      return { ...base, status: "SOURCE_INSUFFICIENT", verdict: "BLOCKED_SOURCE_INSUFFICIENT", message: assembled.detail };
    }
    const row = await prisma.generatedArticle.upsert({
      where: { source_item_id_generation_version_article_variant: {
        source_item_id: args.sourceItemId, generation_version: version, article_variant: variant } },
      create: {
        source_item_id: args.sourceItemId, generation_version: version, article_variant: variant,
        mode: "FEED_ONLY_BRIEF", status: "SOURCE_INSUFFICIENT",
        source_url_snapshot: "", source_publisher_snapshot: "", source_title_snapshot: "",
        source_input_hash: "", qa_verdict: "BLOCKED_SOURCE_INSUFFICIENT",
        failure_reason: assembled.detail.slice(0, 300),
      },
      update: { status: "SOURCE_INSUFFICIENT", qa_verdict: "BLOCKED_SOURCE_INSUFFICIENT", failure_reason: assembled.detail.slice(0, 300) },
    }).catch(() => null);
    return { ...base, articleId: row?.id ?? null, status: "SOURCE_INSUFFICIENT",
      verdict: "BLOCKED_SOURCE_INSUFFICIENT", message: assembled.detail };
  }

  const input = assembled.input;
  const inputHash = computeSourceInputHash(input, version);

  // 技术性幂等：同来源同版本同 variant 已有成稿就返回它，不重复生成
  const existing = await prisma.generatedArticle.findUnique({
    where: { source_item_id_generation_version_article_variant: {
      source_item_id: args.sourceItemId, generation_version: version, article_variant: variant } },
  });
  if (existing && existing.source_input_hash === inputHash && existing.status === "DRAFTED") {
    return {
      ...base, articleId: existing.id, status: "EXISTING", mode: existing.mode,
      verdict: existing.qa_verdict, headline: existing.headline,
      issueCount: Array.isArray(existing.qa_issues_json) ? existing.qa_issues_json.length : 0,
      message: "同来源同版本已有成稿",
    };
  }

  if (args.dryRun) {
    return { ...base, status: "DRAFTED", mode: input.mode,
      message: `dry-run：模式 ${input.mode}，可用来源 ${input.sourceText.length} 字符，claims ${input.claims.length} 条` };
  }

  const provider = args.provider ?? "deepseek";
  const called = await callProvider(provider, args.model, buildPrompt(input));
  if (!called.ok) return { ...base, status: "GENERATION_FAILED", mode: input.mode, message: called.message };

  const draft = parseDraft(called.content);
  if (!draft) return { ...base, status: "GENERATION_FAILED", mode: input.mode, message: "provider 返回无法解析为草稿" };

  const qa = checkFaithfulness(draft, input);

  const data = {
    source_item_id: args.sourceItemId,
    fact_pack_id: input.factPackId,
    generation_version: version,
    article_variant: variant,
    mode: input.mode,
    // QA 未通过时停在 FAITHFULNESS_FAILED，不进入可发布态
    status: qa.verdict === "PASSED" ? ("DRAFTED" as const) : ("FAITHFULNESS_FAILED" as const),
    source_url_snapshot: input.sourceUrl,
    source_publisher_snapshot: input.publisher,
    source_title_snapshot: input.title,
    source_published_at: input.publishedAt,
    source_captured_at: input.capturedAt,
    source_input_hash: inputHash,
    headline: draft.headline,
    short_summary: draft.shortSummary,
    body: draft.body,
    fact_mapping_json: draft.factMapping as unknown as Prisma.InputJsonValue,
    qa_verdict: qa.verdict,
    qa_issues_json: qa.issues as unknown as Prisma.InputJsonValue,
    qa_checked_at: new Date(),
    provider,
    model: called.model,
    generated_at: new Date(),
    failure_reason: null,
  };

  const row = await prisma.generatedArticle.upsert({
    where: { source_item_id_generation_version_article_variant: {
      source_item_id: args.sourceItemId, generation_version: version, article_variant: variant } },
    create: data,
    update: data,
  });

  return {
    sourceItemId: args.sourceItemId, articleId: row.id,
    status: qa.verdict === "PASSED" ? "DRAFTED" : "FAITHFULNESS_FAILED",
    mode: input.mode, verdict: qa.verdict,
    issueCount: qa.issues.length,
    issues: qa.issues.map((i) => ({ code: i.code, detail: i.detail })),
    headline: draft.headline, message: null,
  };
}

export { assembleSourceInput, computeSourceInputHash } from "./source-input";
export { checkFaithfulness, protectedTokens } from "./faithfulness";
export * from "./types";
