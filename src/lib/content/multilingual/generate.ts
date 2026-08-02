import { Prisma, type DraftLanguage, type MultilingualDraftStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { resolveProviderRuntime, type ProviderKey } from "@/lib/website/ai-provider-config";

import { resolveNewsroomModel } from "./model-settings";

import { ML_GENERATION_VERSION } from "../aihot/types";

import { checkHotTopicBrief } from "./hot-topic-qa";
import { checkMasterFaithfulness, checkTranslationDrift } from "./qa";
import { assembleDaily, assembleHotTopic, assembleSelected, computeInputHash } from "./unit-input";
import {
  bodyLimitFor, HOT_TOPIC_WORD_BAND, LANGUAGE_LABEL, MASTER_LANGUAGE, TRANSLATION_LANGUAGES,
  type ContentUnitInput, type DraftContent, type MlIssue,
} from "./types";

/**
 * 多语言草稿生成。
 *
 * 顺序是刻意的：
 *   AI HOT 输入 → 英文母版 → 母版忠实度 QA → 三种译文 → 译文漂移 QA → 存草稿
 *
 * **四种语言不是各自独立扩写。** 让四个语言分别面对原始输入，等于四次
 * 独立的再创作，事实会各漂各的，而且没有任何一个基准能用来比对。
 * 母版一旦定稿，译文的职责就只剩「不要改变母版说过的话」。
 *
 * 本阶段**只生成草稿，不发布**。
 */

const TIMEOUT_MS = 180_000;
/** 母版与译文各允许一次带反馈的重写。再多就是在赌，不是在修 */
const MAX_ATTEMPTS = 2;

export type LanguageOutcome = {
  language: DraftLanguage;
  draftId: number | null;
  status: MultilingualDraftStatus;
  issueCount: number;
  issues: { code: string; detail: string }[];
  headline: string | null;
};

export type GenerateUnitResult = {
  unitKey: string;
  contentForm: string | null;
  status: "OK" | "EXISTING" | "SOURCE_INSUFFICIENT" | "MASTER_FAILED" | "GENERATION_FAILED";
  languages: LanguageOutcome[];
  providerCalls: number;
  message: string | null;
};

// ── 提示词 ────────────────────────────────────────────────────────────────

function factLines(input: ContentUnitInput): string {
  return input.facts.length
    ? input.facts.map((f) => `- ${f.label}：${f.value}${f.volatile ? "（会随时间变化，引用时须加时间限定）" : ""}`).join("\n")
    : "（无）";
}

function sectionLines(input: ContentUnitInput): string {
  if (!input.sections.length) return "";
  return input.sections
    .map((s, i) => `【栏目 ${i + 1}｜${s.label ?? "未命名"}】\n` +
      s.items.map((it) => `  - ${it.title}${it.summary ? `：${it.summary}` : ""}${it.sourceName ? `（来源：${it.sourceName}）` : ""}`).join("\n"))
    .join("\n");
}

const FORM_BRIEF: Record<string, string> = {
  MULTILINGUAL_NEWS_BRIEF:
    "写成一条独立的英文短资讯：说清楚发生了什么、涉及谁、有什么可核对的细节。",
  HOT_TOPIC_BRIEF: "",
  DAILY_BRIEF:
    `写成一期英文每日简报。**必须保留输入栏目的原始顺序与数量**，但用你自己的语言和版式重新编排，
不得逐条照搬摘要原文。每个栏目下用一到两句话概括该栏目的条目。`,
};

/**
 * 热点简报的体裁说明，按素材丰富度分两套。
 *
 * SIGNAL 的关键不是「写短」，而是**如实说明这是榜单信号**。
 * 一篇没有材料却装成完整报道的简报，比一篇坦白说「信息就这么多」的简报危险得多。
 */
function hotTopicBrief(input: ContentUnitInput): string {
  const ht = input.hotTopic!;
  if (ht.mode === "SIGNAL") {
    const band = HOT_TOPIC_WORD_BAND.SIGNAL;
    return `写成一条英文**实时热点信号简报**（${band.min}–${band.max} 词）。

可用材料**只有**：热点标题、榜单名次、来源数量、信号条数、抓取日期。
按这个顺序组织：
  1. 这个热点是什么（只能复述标题所表达的内容，不得展开）
  2. 当前的关注广度（名次、来源数、信号条数，如实引用）。
     **名次必须写成「截至某个时间点」的状态**（例如 "as of <抓取日期>, ranked N"），
     不能写成固定属性 —— 榜单名次每天都在变，不加时间限定的名次很快就会变成假话。
  3. 当前可确认的信息边界（明确说明可获取的信息仅限于此）

**必须**让读者看出这是榜单信号而不是完整报道。可以直接写类似：
  "This is currently listed as a trending topic."
  "The topic is being tracked across N sources."
  "The available feed does not include further event details."

**不得列举来源名称**，也不得出现聚合方的品牌名 —— 出处由页面底部统一声明。

**严禁**为了凑篇幅补充：技术细节、商业影响、事件背景、发布时间、产品参数、
具体事件进展，以及任何 API 没有给出的结论。写不满下限就说明材料确实少 ——
那就照实少写，不要编。`;
  }
  const band = HOT_TOPIC_WORD_BAND.ENRICHED;
  return `写成一条英文热点简报（${band.min}–${band.max} 词）。

除标题与榜单计数外，本条还有 AI HOT 提供的摘要或可精确关联的精选资讯，可以使用它们。
仍然**不得**引入这些材料之外的任何事实，不得推断影响力、市场反应或趋势，
也不得把「上榜」写成「事件已经发生」。计数与名次只能如实引用。`;
}

export function buildMasterPrompt(input: ContentUnitInput, retryIssues?: MlIssue[]): string {
  const limit = bodyLimitFor(input);
  const sections = sectionLines(input);
  const isDaily = input.contentForm === "DAILY_BRIEF";

  const retry = retryIssues?.length
    ? `\n═══ 上一稿被判不合格，必须修正 ═══\n${retryIssues.map((i) => `- [${i.code}] ${i.detail}`).join("\n")}\n`
    : "";

  return `你是一名资讯编辑。请**仅依据下面这一份 AI HOT 材料**，用你自己的语言写一篇**英文（en-US）**原创资讯。

═══ 硬性约束（违反任何一条即为不合格）═══
1. 不得引入材料中没有的任何事实、数字、日期、人名、机构名、产品名或结论。
2. 数字、金额、百分比、日期、型号与版本号必须与材料**完全对应**，不得换算成不同的量、取整或改写。
3. 保留**事件内部**的观点归属：材料里的主张、预测、声明写明是**事件当事人**说的
   （例如「OpenAI said」「the company expects」）。
   **不得把计划、预期写成已经完成的事实。**
4. 不得逐句翻译或照搬材料的摘要原文，要重新组织结构与表达。
5. 不得推断材料未声明的因果关系，不得为凑篇幅编造细节。
6. **不得出现任何发布者归因**：不写「据 X 报道」「according to <媒体>」「来自 AI HOT」，
   不写发布者名称、不写原始来源地址、不写 AI HOT 地址、不写来源元数据。
   出处由页面底部统一声明，不由正文承担。
   注意区分：作为**新闻主体**的公司/人物/产品必须保留
   （"OpenAI announced…" 里的 OpenAI 是事件主体，不是来源标签）。
7. 正文长度不超过 ${limit} 字符。
8. 输出必须是英文。${retry}

═══ 体裁 ═══
${input.contentForm === "HOT_TOPIC_BRIEF" && input.hotTopic ? hotTopicBrief(input) : (FORM_BRIEF[input.contentForm] ?? "")}

═══ AI HOT 材料 ═══
标题：${input.title}
${input.publishedAt ? `时间：${input.publishedAt.toISOString().slice(0, 10)}\n` : ""}AI HOT 页面：${input.attributionUrl}
${input.originalSourceUrl ? `原始来源地址：${input.originalSourceUrl}\n` : ""}
正文材料：
${input.sourceText}

结构化字段：
${factLines(input)}
${sections ? `\n栏目材料：\n${sections}\n` : ""}
═══ 输出格式 ═══
只输出 JSON，不要额外说明：
{
  "headline": "英文标题",
  "summary": "一到两句英文摘要",
  "body": "英文正文"${isDaily ? `,
  "sections": [{ "label": "英文栏目名（对应输入栏目，顺序与数量必须一致）", "body": "该栏目的英文正文" }]` : ""}
}`;
}

export function buildTranslationPrompt(
  master: DraftContent, language: DraftLanguage, input: ContentUnitInput, retryIssues?: MlIssue[]
): string {
  const retry = retryIssues?.length
    ? `\n═══ 上一版被判存在事实漂移，必须修正 ═══\n${retryIssues.map((i) => `- [${i.code}] ${i.detail}`).join("\n")}\n`
    : "";
  return `请把下面这篇英文资讯翻译成 **${LANGUAGE_LABEL[language]}**。

═══ 硬性约束 ═══
1. 这是翻译，不是再创作。**不得增加、删减或改变任何事实。**
2. 数字、金额、百分比必须保持**同一个量**。按目标语言的书写习惯排版可以，改变数值不行。
   注意：西班牙语的 billón 是 10^12，10^9 要写 mil millones；巴西葡萄牙语的 bilhão 才是 10^9。
3. 日期必须指向同一天，可以改写法（August 1, 2026 / 1 de agosto de 2026 / 2026年8月1日）。
4. 型号与版本号（GPT-5.6、v1.2.3 这类）**原样保留，不翻译、不改写**。
5. **不得添加任何发布者归因**（"según <媒体>"、"によると" 之类都不行）。
   英文原文里作为**事件主体**的公司、人物、产品名照译保留。
6. 不得引入英文原文里没有出现的机构名、产品名或人名。${retry}

═══ 英文原文 ═══
标题：${master.headline}
摘要：${master.summary}
正文：
${master.body}

═══ 输出格式 ═══
只输出 JSON，不要额外说明：
{
  "headline": "译文标题",
  "summary": "译文摘要",
  "body": "译文正文"
}`;
}

// ── provider ──────────────────────────────────────────────────────────────

type ParsedDraft = DraftContent & { sections?: { label: string; body: string }[] };

export function parseDraft(raw: string): ParsedDraft | null {
  let obj: unknown;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;
  const r = obj as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const headline = str(r.headline);
  const summary = str(r.summary);
  let body = str(r.body);
  const sections = Array.isArray(r.sections)
    ? r.sections
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
        .map((x) => ({ label: str(x.label), body: str(x.body) }))
        .filter((x) => x.label || x.body)
    : undefined;
  /*
   * 分栏产出必须并进正文。
   *
   * 模型给日报时会返回一小段导语加五个栏目，正文字段只有导语。
   * 如果只拿导语去做忠实度检查，占产出九成的栏目内容就完全没被查过 ——
   * 编在栏目里的事实会一路畅通。正文因此始终是**完整产出**，
   * 栏目结构另存一份供排版使用。
   */
  if (sections?.length) {
    const rendered = sections.map((s) => `## ${s.label}\n${s.body}`).join("\n\n");
    body = body ? `${body}\n\n${rendered}` : rendered;
  }
  if (!headline || !summary || !body) return null;
  return { headline, summary, body, sections };
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
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    const body = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return { ok: false, message: "provider 未返回内容" };
    return { ok: true, content, model: runtime.model };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 160) : "请求失败" };
  }
}

// ── 写库 ──────────────────────────────────────────────────────────────────

async function saveDraft(args: {
  input: ContentUnitInput; language: DraftLanguage; isMaster: boolean; masterDraftId: number | null;
  version: string; inputHash: string; status: MultilingualDraftStatus;
  content: ParsedDraft | null; issues: MlIssue[]; provider: string | null; model: string | null;
  failureReason: string | null;
}): Promise<number> {
  const { input, content } = args;
  const data = {
    content_form: input.contentForm,
    content_kind: input.contentKind,
    unit_key: input.unitKey,
    selected_item_id: input.selectedItemId,
    hot_topic_snapshot_id: input.hotTopicSnapshotId,
    daily_report_id: input.dailyReportId,
    language: args.language,
    is_master: args.isMaster,
    master_draft_id: args.masterDraftId,
    generation_version: args.version,
    status: args.status,
    source_snapshot_hash: input.sourceSnapshotHash,
    source_input_hash: args.inputHash,
    provider_attribution_name: input.attributionName,
    provider_attribution_url: input.attributionUrl,
    original_source_name: input.originalSourceName,
    original_source_url: input.originalSourceUrl,
    category_slug: input.categorySlug,
    hot_topic_mode: input.hotTopic?.mode ?? null,
    headline: content?.headline ?? null,
    summary: content?.summary ?? null,
    body: content?.body ?? null,
    sections_json: (content?.sections ?? null) as unknown as Prisma.InputJsonValue,
    qa_verdict: args.issues.length ? ("NEEDS_REWRITE" as const) : ("PASSED" as const),
    qa_issues_json: args.issues as unknown as Prisma.InputJsonValue,
    qa_checked_at: new Date(),
    provider: args.provider,
    model: args.model,
    generated_at: content ? new Date() : null,
    failure_reason: args.failureReason,
  };
  const row = await prisma.multilingualDraft.upsert({
    where: { unit_key_language_generation_version: { unit_key: input.unitKey, language: args.language, generation_version: args.version } },
    create: data,
    update: data,
  });
  return row.id;
}

// ── 主流程 ────────────────────────────────────────────────────────────────

export type GenerateUnitArgs = {
  kind: "SELECTED" | "HOT_TOPIC" | "DAILY";
  id: number;
  provider?: ProviderKey;
  model?: string;
  generationVersion?: string;
  /** 只组装与检查，不调用 provider、不写库 */
  dryRun?: boolean;
  /** 强制重生成，忽略已有成稿 */
  force?: boolean;
};

export async function generateUnit(args: GenerateUnitArgs): Promise<GenerateUnitResult> {
  const version = args.generationVersion ?? ML_GENERATION_VERSION;
  const assembled =
    args.kind === "SELECTED" ? await assembleSelected(args.id)
    : args.kind === "HOT_TOPIC" ? await assembleHotTopic(args.id)
    : await assembleDaily(args.id);

  if (!assembled.ok) {
    return { unitKey: `${args.kind.toLowerCase()}:#${args.id}`, contentForm: null,
      status: "SOURCE_INSUFFICIENT", languages: [], providerCalls: 0, message: assembled.reason };
  }

  const input = assembled.input;
  const inputHash = computeInputHash(input, version);
  const base: GenerateUnitResult = {
    unitKey: input.unitKey, contentForm: input.contentForm, status: "OK",
    languages: [], providerCalls: 0, message: null,
  };

  // 技术性幂等：同输入同版本、四种语言都已成稿 → 不再调用 provider。
  // **不做业务去重** —— 内容与历史草稿重复不是拒绝理由
  if (!args.force) {
    const existing = await prisma.multilingualDraft.findMany({
      where: { unit_key: input.unitKey, generation_version: version },
      select: { id: true, language: true, status: true, headline: true, source_input_hash: true },
    });
    const complete = existing.length === 4
      && existing.every((d) => d.source_input_hash === inputHash && d.status === "DRAFTED");
    if (complete) {
      return { ...base, status: "EXISTING",
        languages: existing.map((d) => ({ language: d.language, draftId: d.id, status: d.status, issueCount: 0, issues: [], headline: d.headline })),
        message: "同输入同版本四种语言均已成稿，未调用 provider" };
    }
  }

  if (args.dryRun) {
    return { ...base, message: `dry-run：体裁 ${input.contentForm}，来源文本 ${input.sourceText.length} 字符，栏目 ${input.sections.length} 个，事实 ${input.facts.length} 条` };
  }

  /*
   * 模型来自后台设置，不再写死在代码里。
   * 显式传入的 args.provider 优先（脚本/测试用），其余一律走设置 ——
   * 「线上到底在用哪个模型」必须能在一个地方回答清楚。
   */
  const configured = args.provider ? null : await resolveNewsroomModel();
  if (configured && !configured.available) {
    /*
     * 配置的 provider 用不了：**如实失败**，不悄悄换一个。
     * 换掉意味着某天的稿子是另一个模型写的，而审计里看不出任何痕迹。
     */
    return { ...base, status: "GENERATION_FAILED", providerCalls: 0,
      message: `Newsroom 模型不可用：${configured.unavailableReason}` };
  }
  const provider = args.provider ?? configured!.provider;
  /*
     * 变量名带 configured 前缀：翻译循环里另有一个 `model`，
     * 装的是 provider **返回的**模型名。两者同名会让人以为是同一个东西。
     */
  const configuredModel: string | undefined = args.model ?? configured?.model ?? undefined;
  let providerCalls = 0;

  // ── 1. 英文母版 ──
  let master: ParsedDraft | null = null;
  let masterIssues: MlIssue[] = [];
  let masterModel: string | null = null;
  let masterFailure: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const called = await callProvider(provider, configuredModel, buildMasterPrompt(input, attempt > 1 ? masterIssues : undefined));
    providerCalls++;
    if (!called.ok) { masterFailure = called.message; continue; }
    const parsed = parseDraft(called.content);
    if (!parsed) { masterFailure = "provider 返回无法解析为草稿"; continue; }
    masterModel = called.model;

    const qa = checkMasterFaithfulness(parsed, input);
    // 热点另跑专属检查：计数、名单、名次、时间语义、信号自述
    const hotIssues = input.contentForm === "HOT_TOPIC_BRIEF" && input.hotTopic
      ? checkHotTopicBrief(parsed, input).issues : [];
    const issues = [...qa.issues, ...checkDailySections(parsed, input), ...hotIssues];
    master = parsed;
    masterIssues = issues;
    masterFailure = null;
    if (!issues.length) break;
  }

  if (!master) {
    const id = await saveDraft({
      input, language: MASTER_LANGUAGE, isMaster: true, masterDraftId: null, version, inputHash,
      status: "GENERATION_FAILED", content: null, issues: [], provider, model: masterModel,
      failureReason: masterFailure?.slice(0, 300) ?? "母版生成失败",
    });
    return { ...base, status: "GENERATION_FAILED", providerCalls,
      languages: [{ language: MASTER_LANGUAGE, draftId: id, status: "GENERATION_FAILED", issueCount: 0, issues: [], headline: null }],
      message: masterFailure };
  }

  const masterStatus: MultilingualDraftStatus = masterIssues.length ? "QA_FAILED" : "DRAFTED";
  const masterId = await saveDraft({
    input, language: MASTER_LANGUAGE, isMaster: true, masterDraftId: null, version, inputHash,
    status: masterStatus, content: master, issues: masterIssues, provider, model: masterModel,
    failureReason: null,
  });
  base.languages.push({
    language: MASTER_LANGUAGE, draftId: masterId, status: masterStatus,
    issueCount: masterIssues.length, issues: masterIssues.map((i) => ({ code: i.code, detail: i.detail })),
    headline: master.headline,
  });

  // 母版没过就不翻译：拿一份已知失真的母版去生成三种语言，只会把同一处
  // 失真复制三遍，还要多花三次 provider 调用
  if (masterIssues.length) {
    /*
     * 但**必须**把上一轮留下的译文作废。
     * 母版重生成过、译文还挂着旧内容，两者就对不上了 ——
     * 审核台上会看到一篇「已成稿」的西语译文，其母版却是不合格的另一稿。
     */
    const stale = await prisma.multilingualDraft.updateMany({
      where: {
        unit_key: input.unitKey, generation_version: version,
        language: { in: TRANSLATION_LANGUAGES }, status: { not: "QA_FAILED" },
      },
      data: { status: "QA_FAILED", failure_reason: "母版未通过忠实度 QA，本轮未重译，此译文已作废" },
    });
    return { ...base, status: "MASTER_FAILED", providerCalls,
      message: `母版未通过忠实度 QA（${masterIssues.length} 项），已跳过翻译${stale.count ? `，作废旧译文 ${stale.count} 条` : ""}` };
  }

  // ── 2. 三种译文 ──
  for (const language of TRANSLATION_LANGUAGES) {
    let translation: ParsedDraft | null = null;
    let issues: MlIssue[] = [];
    let model: string | null = null;
    let failure: string | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const called = await callProvider(provider, configuredModel, buildTranslationPrompt(master, language, input, attempt > 1 ? issues : undefined));
      providerCalls++;
      if (!called.ok) { failure = called.message; continue; }
      const parsed = parseDraft(called.content);
      if (!parsed) { failure = "provider 返回无法解析为译文"; continue; }
      model = called.model;
      const qa = checkTranslationDrift(master, parsed, language, input);
      translation = parsed;
      issues = qa.issues;
      failure = null;
      if (!issues.length) break;
    }

    if (!translation) {
      const id = await saveDraft({
        input, language, isMaster: false, masterDraftId: masterId, version, inputHash,
        status: "GENERATION_FAILED", content: null, issues: [], provider, model,
        failureReason: failure?.slice(0, 300) ?? "译文生成失败",
      });
      base.languages.push({ language, draftId: id, status: "GENERATION_FAILED", issueCount: 0, issues: [], headline: null });
      continue;
    }

    const status: MultilingualDraftStatus = issues.length ? "QA_FAILED" : "DRAFTED";
    const id = await saveDraft({
      input, language, isMaster: false, masterDraftId: masterId, version, inputHash,
      status, content: translation, issues, provider, model, failureReason: null,
    });
    base.languages.push({
      language, draftId: id, status, issueCount: issues.length,
      issues: issues.map((i) => ({ code: i.code, detail: i.detail })), headline: translation.headline,
    });
  }

  return { ...base, providerCalls };
}

/**
 * 日报栏目数与顺序必须与输入一致。
 *
 * 多出一个栏目就是凭空多了一块内容；少一个则是把信源的编辑判断丢了。
 * 这条检查是「保留原始栏目顺序」这个要求唯一可自动验证的部分。
 */
function checkDailySections(draft: ParsedDraft, input: ContentUnitInput): MlIssue[] {
  if (input.contentForm !== "DAILY_BRIEF") return [];
  const got = draft.sections?.length ?? 0;
  const want = input.sections.length;
  if (got === want) return [];
  if (got > want) {
    return [{ code: "UNSUPPORTED_DETAIL", detail: `日报产出 ${got} 个栏目，输入只有 ${want} 个` }];
  }
  return [{ code: "EMPTY_FIELD", detail: `日报产出 ${got} 个栏目，输入有 ${want} 个，栏目缺失` }];
}
