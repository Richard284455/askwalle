import type {
  DraftLanguage, ReviewDecision, ReviewIssueCategory,
} from "@prisma/client";

import { callProvider } from "@/lib/content/multilingual/generate";
import { properTokens, type Lang } from "@/lib/content/multilingual/linguistics";
import { resolveNewsroomModel } from "@/lib/content/multilingual/model-settings";
import { checkMasterFaithfulness, checkTranslationDrift, unitCorpus } from "@/lib/content/multilingual/qa";
import type { ContentUnitInput } from "@/lib/content/multilingual/types";
import { assembleDaily, assembleHotTopic, assembleSelected } from "@/lib/content/multilingual/unit-input";
import { prisma } from "@/lib/prisma";

import { httpUrlOrNull } from "../aihot/types";

import { findSourceLeaks, redactAttribution } from "./attribution";
import { recordReview, type Reviewer } from "./review";
import { LOCALES, REVIEW_CHECKLIST, type ChecklistKey, type ChecklistResult } from "./types";

/**
 * 自动审核。
 *
 * 内容改为「AI 自动审核并发布，人工事后复核」之后，这里就是**唯一**
 * 挡在公开页前面的闸门。所以它不能是橡皮图章 —— 一个只会盖 APPROVED 的
 * 自动审核，比没有审核更糟：它会给「已审核」这三个字背书。
 *
 * 两层，**方向不同**：
 *
 *   1. **确定性闸门**（硬门禁）。十项审核清单逐项算出结论，算不出的项
 *      用可验证的替代信号来判，绝不默认为过。任何一项不过 → 不批准。
 *   2. **模型复看**（只能否决）。模型只有**否决权**，没有批准权：
 *      它挑不出毛病不会让任何一项从「不过」变成「过」，
 *      它挑出毛病则整族拦下。方向搞反的话，模型的一句「看起来没问题」
 *      就能盖过确定性检查 —— 那就等于没有闸门。
 *
 * 生成时已经跑过一次忠实度 QA。这里**重跑**而不是读结论，是因为
 * 第二道闸门的意义就在于不信第一道：revision 是冻结之后的文本，
 * 而且要对着**此刻**的来源核，抓的是冻结之后来源又变了的情况。
 */

// ── 审核主体 ──────────────────────────────────────────────────────────────

/**
 * 自动审核的固定身份。
 *
 * **永远是 AGENT。** 事后追溯必须一眼看出哪些页面是模型自己放行的、
 * 哪些是人看过的 —— 这两件事的可信度差着一个数量级，混在一起记，
 * 「人工复核」就无从谈起：分不清哪些还没人看过。
 */
export const AUTO_REVIEWER: Reviewer = {
  type: "AGENT",
  id: "agent:newsroom-auto-review",
  name: "Newsroom 自动审核",
};

// ── 结果形状 ──────────────────────────────────────────────────────────────

export type CheckFailure = { key: ChecklistKey; detail: string };

export type LlmVerdict = {
  ran: boolean;
  /** BLOCK = 模型挑出了问题；PASS = 没挑出；UNAVAILABLE = 没跑成 */
  verdict: "PASS" | "BLOCK" | "UNAVAILABLE";
  issues: { check: string; detail: string }[];
  message: string | null;
  providerCalls: number;
};

export type AutoReviewLocale = {
  locale: DraftLanguage;
  translationId: number | null;
  revisionId: number | null;
  revisionNumber: number | null;
  checklist: ChecklistResult;
  failures: CheckFailure[];
  issueCategories: ReviewIssueCategory[];
  decision: ReviewDecision;
  notes: string;
  reviewId: number | null;
};

export type AutoReviewResult = {
  familyId: number;
  unitKey: string;
  /** APPROVED = 四种语言全过；BLOCKED = 至少一种没过 */
  status: "APPROVED" | "BLOCKED" | "FAMILY_MISSING" | "NOT_READY";
  locales: AutoReviewLocale[];
  llm: LlmVerdict;
  providerCalls: number;
  message: string | null;
};

export type AutoReviewOptions = {
  /** 关掉模型复看，只跑确定性闸门。离线测试与批量重跑用 */
  llm?: boolean;
  /** 只算不写：不留审核记录，不改译本状态 */
  dryRun?: boolean;
  reviewer?: Reviewer;
};

// ── 语言层面的可验证信号 ──────────────────────────────────────────────────

const LANG_OF: Record<DraftLanguage, Lang> = {
  EN_US: "EN_US", ES_ES: "ES_ES", PT_BR: "PT_BR", JA_JP: "JA_JP",
};

const CJK = /[぀-ヿ㐀-䶿一-鿿]/;
const KANA = /[぀-ヿ]/;

/**
 * 标题长度带（字符）。
 *
 * 日语按字符算天然更短，用同一条带子会把正常的日文标题判成过短 ——
 * 这类误判会让日语版永远发不出去，而问题其实在尺子上。
 */
const HEADLINE_BAND: Record<DraftLanguage, { min: number; max: number }> = {
  EN_US: { min: 24, max: 160 },
  ES_ES: { min: 24, max: 170 },
  PT_BR: { min: 24, max: 170 },
  JA_JP: { min: 10, max: 90 },
};

/**
 * 正文长度带，按体裁。下限防「空壳页」，上限防跑题灌水。
 *
 * 下限刻意定得宽松：这道尺子本来就没有客观刻度，卡在边缘上的时候
 * 它挡下的是「短了一点」，而不是「有问题」。实测一篇日语简讯
 * 167 字符被 168 的下限拦住 —— 那不是内容问题，是尺子的问题。
 * 240 字符（英文约 40 词）已经足够把真正的空壳页挡在外面。
 */
const BODY_BAND: Record<string, { min: number; max: number }> = {
  MULTILINGUAL_NEWS_BRIEF: { min: 240, max: 3_000 },
  HOT_TOPIC_BRIEF: { min: 200, max: 2_600 },
  DAILY_BRIEF: { min: 600, max: 12_000 },
};

/**
 * 情态标记。**丢掉情态就是改变事实** ——
 * "plans to launch" 译成「发布了」是把计划写成了既成事实，
 * 这类漂移数字比对抓不到，但它比数字错更严重。
 */
/**
 * 情态标记。**丢掉情态就是改变事实** ——
 * "plans to launch" 译成「発表した」是把计划写成了既成事实，
 * 这类漂移数字比对抓不到，但它比数字错更严重。
 *
 * 西语与巴葡的将来时/条件式是**词尾变化**，不是独立助动词：
 * "lanzará" / "permitirá" / "poderá" 里没有任何一个可以逐词列举的情态词。
 * 所以除了词表，还要认 `-rá/-rán/-ría` 这类词尾 ——
 * 只列词表的话，一篇满是将来时的西语译文会被判成「一处情态都没有」。
 */
const MODALITY: Record<Lang, RegExp> = {
  EN_US: /\b(plan(s|ned|ning)?|expect(s|ed|ing)?|will|would|may|might|could|should|aims?|intends?|reportedly|is set to|upcoming|preview|beta|early access|coming soon)\b/gi,
  ES_ES: /(\b(plane[ao]|planea|prev[eé]|previsto|espera|pretende|pr[óo]ximamente|seg[úu]n|beta|adelanto|pronto|podr|pued|deber|permitir)\w*|\b\w{3,}(r[áé]n?|r[íi]an?|r[íi]a)\b)/gi,
  PT_BR: /(\b(planeja|pretende|prev[êe]|previsto|espera|em breve|segundo|beta|pr[ée]via|dever|poder|pode[m]?|permitir)\w*|\b\w{3,}(r[áã]o?|r[íi]a[ms]?)\b)/gi,
  JA_JP: /(予定|見込み|計画|方針|とみられ|可能性|だろう|見通し|とされ|予想|期待|近日|ベータ|プレビュー|ようになり|できる|する見込)/g,
  SOURCE: /(?:)/g,
};

/** 内部痕迹：这些字样出现在公开正文里，就是把后台漏到了前台 */
const INTERNAL_MARKERS = [
  /\bqa[_\s-]?(verdict|issue|failed|passed)\b/i,
  /\bsource[_\s-]snapshot[_\s-]hash\b/i,
  /\bunit[_\s-]key\b/i,
  /\brevision[_\s-]number\b/i,
  /\b(system|assistant|user)\s*:\s*$/im,
  /^\s*\{\s*"headline"\s*:/m,
  /\bprompt\b\s*[:：]/i,
  /\b(NEEDS_REWRITE|GENERATION_FAILED|DRAFTED|IN_REVIEW)\b/,
];

function count(text: string, re: RegExp): number {
  return (text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)) ?? []).length;
}

// ── 确定性闸门 ────────────────────────────────────────────────────────────

type RevisionText = {
  locale: DraftLanguage;
  translationId: number;
  revisionId: number;
  revisionNumber: number;
  headline: string;
  summary: string;
  body: string;
  qaVerdict: string | null;
  qaIssues: { code: string; detail: string }[];
};

type GateContext = {
  contentForm: string;
  attributionName: string;
  attributionUrl: string;
  originalSourceName: string | null;
  originalSourceUrl: string | null;
  /** AI HOT **此刻**重新装配出来的输入。冻结时的那一份已经不作数了 */
  input: ContentUnitInput;
  /** 可比语料（标题 + 正文 + 事实 + 栏目），由 input 派生 */
  sourceCorpus: string;
  sourceTitle: string;
  sourceNames: string[];
  /** 冻结的来源指纹是否仍与当前来源一致 */
  sourceUnchanged: boolean;
  master: RevisionText;
};

function emptyChecklist(): ChecklistResult {
  return Object.fromEntries(REVIEW_CHECKLIST.map((c) => [c.key, true])) as ChecklistResult;
}

/**
 * 一种语言的确定性闸门。
 *
 * 返回逐项结论 + 每项不过的理由。**没有「无法判断」这个档位** ——
 * 判不了的项一律走可验证的替代信号，替代信号也算不出来就判不过。
 * 留一个「未知」档位，实际效果就是全部滑向通过。
 */
export function deterministicGate(rev: RevisionText, ctx: GateContext): {
  checklist: ChecklistResult; failures: CheckFailure[];
} {
  const checklist = emptyChecklist();
  const failures: CheckFailure[] = [];
  const fail = (key: ChecklistKey, detail: string) => {
    if (!checklist[key]) return; // 同一项只记第一条理由，不刷屏
    checklist[key] = false;
    failures.push({ key, detail });
  };

  const lang = LANG_OF[rev.locale];
  const article = [rev.headline, rev.summary, rev.body].join("\n");
  const isMaster = rev.locale === "EN_US";

  // ── 1. headline_natural ──
  const hl = rev.headline.trim();
  const band = HEADLINE_BAND[rev.locale];
  if (!hl) fail("headline_natural", "标题为空");
  else if (hl.length < band.min) fail("headline_natural", `标题仅 ${hl.length} 字符，短于 ${band.min}`);
  else if (hl.length > band.max) fail("headline_natural", `标题 ${hl.length} 字符，长于 ${band.max}`);
  else if (/^[A-Z0-9 \-_.,:!?]+$/.test(hl) && hl.length > 24) fail("headline_natural", "标题整串大写");
  else if (/[{}<>]|\\n|^"|"$/.test(hl)) fail("headline_natural", "标题带有格式残留（引号 / 转义 / 括号）");
  /*
   * 语种错位。**这是真发生过的事故**：热榜卡片上出现过中文标题，
   * 因为热点原标题是中文而译文没真的译。数字比对抓不到这种问题。
   */
  else if (rev.locale === "JA_JP" && !KANA.test(hl)) fail("headline_natural", "日语标题不含假名，疑似未翻译");
  else if (rev.locale !== "JA_JP" && CJK.test(hl)) fail("headline_natural", "非日语标题含中日文字符，疑似未翻译");

  /*
   * ── 2/3. 事实忠实度：直接复用生成侧的那两个 QA 函数 ──
   *
   * 母版对**当前**来源，译文对母版。刻意不在这里另写一份比对逻辑：
   * 「什么算漂移」写两份，迟早会一边放过另一边拦下，
   * 而到那时没人说得清哪一边是对的 —— 我第一版就是自己重写了数字比对，
   * 结果比生成侧更严，把本来合格的稿子判成了编造。
   *
   * 复用的同时仍然有新东西：这一遍跑的是**冻结之后的正文**，
   * 对的是**此刻重新装配的来源**。中间来源变过，这里就会显出来。
   */
  const drift = isMaster
    ? checkMasterFaithfulness(
        { headline: rev.headline, summary: rev.summary, body: rev.body }, ctx.input
      )
    : checkTranslationDrift(
        { headline: ctx.master.headline, summary: ctx.master.summary, body: ctx.master.body },
        { headline: rev.headline, summary: rev.summary, body: rev.body },
        rev.locale,
        ctx.input
      );
  for (const i of drift.issues) {
    if (i.code === "NUMBER_MISMATCH" || i.code === "DATE_MISMATCH" || i.code === "TRANSLATION_FACT_DRIFT") {
      fail("numbers_consistent", i.detail);
    } else if (i.code === "ENTITY_MISMATCH" || i.code === "MODEL_MISMATCH") {
      fail("entities_consistent", i.detail);
    } else if (i.code === "ATTRIBUTION_MISMATCH") {
      fail("attribution_correct", i.detail);
    } else if (i.code === "SOURCE_LINK_INVALID") {
      fail("links_valid", i.detail);
    } else if (i.code === "MODALITY_UPGRADE") {
      fail("modality_preserved", i.detail);
    } else if (i.code === "UNSUPPORTED_DETAIL" || i.code.startsWith("HOT_TOPIC_")) {
      fail("no_new_facts", i.detail);
    } else if (i.code === "EMPTY_FIELD") {
      fail("length_appropriate", i.detail);
    }
  }

  /*
   * ── 4. subject_action_consistent：母版的**核心主体**必须出现在译文里 ──
   *
   * 两条限制，都是被误报逼出来的：
   *
   *   1. **不看标题。** 英文标题是 Title Case，每个词都大写，
   *      properTokens 会把「ByteDance Unveils Seedance」「Accelerate AI Law
   *      Legislation」整段当成专名 —— 那是标题片段，不是实体名，
   *      任何译文都不可能逐字包含它。生成侧的漂移检查早就绕开标题了，
   *      这里跟它保持一致。
   *   2. **只看反复出现的那个主体。** 报道里出现一次的机构名，
   *      译文换个说法很正常；而全文反复出现的那个主角一旦消失，
   *      才是真的「谁做了什么」被写偏了。
   */
  if (!isMaster) {
    const masterBody = [ctx.master.summary, ctx.master.body].join("\n");
    const freq = new Map<string, number>();
    for (const p of properTokens(masterBody)) {
      // 多词短语多半仍是句首连写的产物，只取单词与紧凑的双词专名
      if (p.split(/\s+/).length > 2) continue;
      freq.set(p, (freq.get(p) ?? 0) + 1);
    }
    const core = [...freq.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([p]) => p);
    const lower = article.toLowerCase();
    const missing = core.filter((k) => !lower.includes(k.toLowerCase()));
    // 日语会把人名机构名音译成片假名 —— 全都不见才判，缺一个不算
    const tolerated = rev.locale === "JA_JP" ? core.length : Math.max(1, Math.ceil(core.length / 2));
    if (core.length && missing.length >= tolerated) {
      fail("subject_action_consistent", `母版反复出现的主体 ${missing.join("、")} 在译文中找不到`);
    }
  }

  /*
   * ── 5. modality_preserved ──
   *
   * 阈值定得很高，是**故意**的。
   *
   * 跨语言的情态靠词表识别不可靠 —— 西语和巴葡的将来时是词尾变化，
   * 日语是句末形态，任何词表都会漏。阈值定低一点，就会持续把
   * 「用了词表没收录的说法」判成「把计划写成了既成事实」，
   * 而每一次误判都会悄悄拦下一篇本来合格的稿子。
   *
   * 所以这里只保留**高把握**的那一档：母版通篇都在打预防针（≥4 处），
   * 译文却一处都没有。真正细腻的情态判断交给模型复看 ——
   * 那正是它比正则强的地方。
   */
  if (!isMaster) {
    const masterText = [ctx.master.headline, ctx.master.summary, ctx.master.body].join("\n");
    const m = count(masterText, MODALITY.EN_US);
    const t = count(article, MODALITY[lang]);
    if (m >= 4 && t === 0) {
      fail("modality_preserved", `母版有 ${m} 处情态标记（计划/预计/可能），译文一处都没有`);
    }
  }

  // ── 6. no_new_facts：生成侧 QA 结论 + 来源是否已变 ──
  if (rev.qaVerdict !== "PASSED") {
    fail("no_new_facts", `冻结版本的忠实度 QA 结论为 ${rev.qaVerdict ?? "（无）"}`);
  }
  for (const i of rev.qaIssues.slice(0, 1)) {
    fail("no_new_facts", `冻结版本遗留 QA 问题：${i.code} ${i.detail}`.slice(0, 200));
  }
  if (!ctx.sourceUnchanged) {
    fail("no_new_facts", "AI HOT 侧内容在冻结之后又变了，这一版已不对应当前来源");
  }

  // ── 7/8. 归因与链接 ──
  if (!ctx.attributionName.trim()) fail("attribution_correct", "缺少归因名称");
  if (!httpUrlOrNull(ctx.attributionUrl)) fail("links_valid", `AI HOT 链接非法：${ctx.attributionUrl.slice(0, 80)}`);
  if (ctx.originalSourceUrl !== null && !httpUrlOrNull(ctx.originalSourceUrl)) {
    fail("links_valid", `原始来源链接非法：${ctx.originalSourceUrl.slice(0, 80)}`);
  }

  // ── 9. no_internal_leakage：查**渲染后**的文本 ──
  const publicText = redactAttribution(article, {
    sourceNames: ctx.sourceNames, title: ctx.sourceTitle,
    providerName: ctx.attributionName, locale: rev.locale,
  });
  const leaks = findSourceLeaks(publicText, {
    sourceNames: ctx.sourceNames, title: ctx.sourceTitle,
    providerName: ctx.attributionName, locale: rev.locale,
  });
  if (leaks.length) fail("no_internal_leakage", `渲染后仍残留来源标识：${leaks.slice(0, 3).join("、")}`);
  for (const re of INTERNAL_MARKERS) {
    if (re.test(article)) { fail("no_internal_leakage", `正文含内部字样：${re.source.slice(0, 40)}`); break; }
  }

  // ── 10. length_appropriate ──
  const bodyLen = rev.body.trim().length;
  const bb = BODY_BAND[ctx.contentForm] ?? BODY_BAND.MULTILINGUAL_NEWS_BRIEF;
  // 日文信息密度高，同样内容字符数约为英文的六成
  const scale = rev.locale === "JA_JP" ? 0.6 : 1;
  if (bodyLen < bb.min * scale) fail("length_appropriate", `正文 ${bodyLen} 字符，短于下限 ${Math.round(bb.min * scale)}`);
  if (bodyLen > bb.max) fail("length_appropriate", `正文 ${bodyLen} 字符，超过上限 ${bb.max}`);
  if (!rev.summary.trim()) fail("length_appropriate", "导语为空");

  return { checklist, failures };
}

// ── 模型复看（只能否决） ──────────────────────────────────────────────────

const LLM_CHECKS: ChecklistKey[] = [
  "headline_natural", "subject_action_consistent", "modality_preserved", "no_new_facts",
];

function buildVetoPrompt(args: {
  sourceTitle: string; sourceCorpus: string;
  headline: string; summary: string; body: string;
}): string {
  return `你是新闻编辑室的复核员。下面是一条**信源材料**和一篇据此改写的英文稿。
请判断这篇稿子有没有**偏离信源**的问题。

【信源材料】
标题：${args.sourceTitle}
${args.sourceCorpus.slice(0, 4000)}

【待复核稿】
标题：${args.headline}
导语：${args.summary}
正文：
${args.body.slice(0, 6000)}

只报告这四类问题，其余一概不报：
- headline_natural：标题读起来不像人写的英文新闻标题（机翻腔、语法错、词不达意）
- subject_action_consistent：稿子里的行为主体或动作与信源不一致（谁做了什么被搞错了）
- modality_preserved：信源说的是计划 / 预计 / 可能 / 传闻，稿子写成了已经发生的事实
- no_new_facts：稿子里出现了信源没有的事实（数字、参数、评测成绩、价格、时间、许可、合作方等）

**明确不要报告的**：
- 行文风格、用词偏好、篇幅长短
- 内容与别处重复 —— 重复不是问题
- 信源本身是否属实 —— 你不负责核实信源，只负责核对稿子有没有忠于信源
- 稿子没有写出来源媒体名 —— 那是刻意的产品规则，不是缺漏

每条问题都必须能在稿子里指出具体位置，指不出来就不要报。
只输出 JSON：
{"ok": true}
或
{"ok": false, "issues": [{"check": "no_new_facts", "detail": "稿中的「32B 参数」信源未提及"}]}`;
}

/**
 * 模型复看一篇母版。**导出**是为了能单独验它 ——
 * 一道从来没有真的否决过任何东西的闸门，和一道坏掉的闸门，
 * 从审计数字上看一模一样。必须能拿已知有问题的稿子直接打它。
 */
export async function llmVeto(args: {
  sourceTitle: string; sourceCorpus: string;
  master: Pick<RevisionText, "headline" | "summary" | "body">;
}): Promise<LlmVerdict> {
  // 复看走**与生成完全相同**的模型设置：换了模型，稿子和复看必须一起换，
  // 否则「谁写的、谁看的」在审计里对不上
  const { provider, model, available, unavailableReason } = await resolveNewsroomModel();
  if (!available) {
    return { ran: true, verdict: "UNAVAILABLE", issues: [],
      message: unavailableReason ?? "Newsroom 模型当前不可用", providerCalls: 0 };
  }
  const called = await callProvider(provider, model ?? undefined, buildVetoPrompt({
    sourceTitle: args.sourceTitle, sourceCorpus: args.sourceCorpus,
    headline: args.master.headline, summary: args.master.summary, body: args.master.body,
  }));

  /*
   * 调用失败 → UNAVAILABLE，**不阻断**。
   *
   * 方向是刻意的：服务商挂掉不该让整个编辑室停更，
   * 而确定性闸门此刻仍然全程有效 —— 少的是「额外一票否决」，不是唯一的闸门。
   * 反过来，模型真的报出了问题，那就一定拦。
   */
  if (!called.ok) {
    return { ran: true, verdict: "UNAVAILABLE", issues: [], message: called.message, providerCalls: 1 };
  }

  let parsed: { ok?: unknown; issues?: unknown };
  try {
    const raw = called.content.trim().replace(/^```(?:json)?|```$/g, "").trim();
    parsed = JSON.parse(raw);
  } catch {
    return { ran: true, verdict: "UNAVAILABLE", issues: [], message: "模型返回不是合法 JSON", providerCalls: 1 };
  }

  const issues = (Array.isArray(parsed.issues) ? parsed.issues : [])
    .map((i) => i as { check?: unknown; detail?: unknown })
    .map((i) => ({
      check: typeof i.check === "string" ? i.check : "no_new_facts",
      detail: typeof i.detail === "string" ? i.detail.slice(0, 300) : "",
    }))
    .filter((i) => i.detail);

  if (parsed.ok === true && !issues.length) {
    return { ran: true, verdict: "PASS", issues: [], message: null, providerCalls: 1 };
  }
  if (!issues.length) {
    // 说了 not ok 却举不出问题 —— 举证不成立，不能凭一句话拦下
    return { ran: true, verdict: "PASS", issues: [], message: "模型判为不通过但未给出具体问题，按通过处理", providerCalls: 1 };
  }
  return { ran: true, verdict: "BLOCK", issues, message: null, providerCalls: 1 };
}

// ── 问题分类 ──────────────────────────────────────────────────────────────

const CATEGORY_OF: Partial<Record<ChecklistKey, ReviewIssueCategory>> = {
  numbers_consistent: "TRUE_FACT_DRIFT",
  entities_consistent: "TRUE_FACT_DRIFT",
  subject_action_consistent: "TRUE_FACT_DRIFT",
  modality_preserved: "TRUE_FACT_DRIFT",
  no_new_facts: "UNSUPPORTED_DETAIL",
  attribution_correct: "ATTRIBUTION_ERROR",
  links_valid: "ATTRIBUTION_ERROR",
  headline_natural: "TRANSLATION_QUALITY_ISSUE",
  length_appropriate: "TRANSLATION_QUALITY_ISSUE",
  no_internal_leakage: "ATTRIBUTION_ERROR",
};

function categorize(failures: CheckFailure[], llmBlocked: boolean): ReviewIssueCategory[] {
  const set = new Set<ReviewIssueCategory>();
  for (const f of failures) {
    const c = CATEGORY_OF[f.key];
    if (c) set.add(c);
  }
  /*
   * 确定性 QA 判过、模型却挑出了问题 —— 这正是 QA_FALSE_NEGATIVE 的定义。
   * 单独记一类，才能回答「确定性检查到底漏了多少」；
   * 混进 TRUE_FACT_DRIFT 里，这个数字就永远算不出来了。
   */
  if (llmBlocked) set.add("QA_FALSE_NEGATIVE");
  return set.size ? [...set] : ["NO_ISSUE"];
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function loadSourceContext(family: {
  content_form: string; selected_item_id: number | null;
  hot_topic_snapshot_id: number | null; daily_report_id: number | null;
  source_snapshot_hash: string;
}): Promise<{ input: ContentUnitInput; corpus: string; sourceNames: string[]; unchanged: boolean } | null> {
  const assembled = family.selected_item_id ? await assembleSelected(family.selected_item_id)
    : family.hot_topic_snapshot_id ? await assembleHotTopic(family.hot_topic_snapshot_id)
    : family.daily_report_id ? await assembleDaily(family.daily_report_id)
    : null;
  if (!assembled || !assembled.ok) return null;

  const input = assembled.input;
  return {
    input,
    corpus: unitCorpus(input),
    sourceNames: [
      input.originalSourceName ?? "",
      ...(input.hotTopic?.sourceNames ?? []),
      ...input.sections.flatMap((s) => s.items.map((i) => i.sourceName ?? "")),
    ].filter(Boolean),
    // 重新装配出来的指纹与冻结时一致 → 来源没变
    unchanged: input.sourceSnapshotHash === family.source_snapshot_hash,
  };
}

/**
 * 自动审核一个 family 的四种语言。
 *
 * 全过才算 APPROVED —— 逐语言批准而整族有一种语言没过是没有意义的：
 * 四种语言少一种，hreflang 就指向 404。
 */
export async function autoReviewFamily(
  familyId: number, opts: AutoReviewOptions = {}
): Promise<AutoReviewResult> {
  const family = await prisma.articleFamily.findUnique({
    where: { id: familyId },
    include: {
      translations: {
        include: {
          revisions: { orderBy: { revision_number: "desc" }, take: 1 },
        },
      },
    },
  });
  const base = { familyId, unitKey: family?.unit_key ?? "", locales: [] as AutoReviewLocale[],
    llm: { ran: false, verdict: "PASS" as const, issues: [], message: null, providerCalls: 0 },
    providerCalls: 0 };
  if (!family) return { ...base, status: "FAMILY_MISSING", message: `family #${familyId} 不存在` };

  // ── 取四种语言的当前版本 ──
  const revs = new Map<DraftLanguage, RevisionText>();
  for (const locale of LOCALES) {
    const t = family.translations.find((x) => x.locale === locale);
    const rev = t?.revisions[0];
    if (!t || !rev || t.current_revision_id !== rev.id) continue;
    revs.set(locale, {
      locale, translationId: t.id, revisionId: rev.id, revisionNumber: rev.revision_number,
      headline: rev.headline, summary: rev.summary, body: rev.body,
      qaVerdict: rev.qa_verdict, qaIssues: Array.isArray(rev.qa_issues_json)
        ? (rev.qa_issues_json as { code: string; detail: string }[]) : [],
    });
  }
  if (revs.size !== LOCALES.length) {
    const missing = LOCALES.filter((l) => !revs.has(l));
    return { ...base, status: "NOT_READY", message: `缺少可审核的版本：${missing.join("、")}` };
  }
  const master = revs.get("EN_US")!;

  const src = await loadSourceContext(family);
  if (!src) {
    return { ...base, status: "NOT_READY", message: "找不到（或无法重新装配）对应的 AI HOT 来源" };
  }

  const ctx: GateContext = {
    contentForm: family.content_form,
    attributionName: family.attribution_name,
    attributionUrl: family.attribution_url,
    originalSourceName: family.original_source_name,
    originalSourceUrl: family.original_source_url,
    input: src.input,
    sourceCorpus: src.corpus, sourceTitle: src.input.title, sourceNames: src.sourceNames,
    sourceUnchanged: src.unchanged,
    master,
  };

  // ── 1. 确定性闸门（四种语言各一遍）──
  const gates = new Map(LOCALES.map((l) => [l, deterministicGate(revs.get(l)!, ctx)]));

  /*
   * ── 2. 模型复看：**只看英文母版，只跑一次** ──
   *
   * 三种译文是从母版翻的，译文能编出来的东西母版里都有；
   * 而译文与母版之间的偏离，确定性漂移检查（数字/日期/型号/新专名双向）
   * 恰好是可靠的。真正需要人类式判断的是「母版有没有编」这一步。
   * 每种语言各跑一次，是把四倍的钱花在同一个问题上。
   */
  let llm: LlmVerdict = { ran: false, verdict: "PASS", issues: [], message: null, providerCalls: 0 };
  const gateAllPassed = [...gates.values()].every((g) => !g.failures.length);
  if (opts.llm !== false && gateAllPassed) {
    llm = await llmVeto({ sourceTitle: src.input.title, sourceCorpus: src.corpus, master });
  } else if (opts.llm !== false) {
    llm = { ran: false, verdict: "PASS", issues: [], providerCalls: 0,
      message: "确定性闸门已判不通过，跳过模型复看（不必为已经拦下的稿子付费）" };
  }

  // 模型的否决落在母版上，但影响整族 —— 译文是从这一版母版翻出来的
  if (llm.verdict === "BLOCK") {
    for (const l of LOCALES) {
      const g = gates.get(l)!;
      for (const i of llm.issues) {
        const key = (LLM_CHECKS as string[]).includes(i.check) ? (i.check as ChecklistKey) : "no_new_facts";
        if (g.checklist[key]) {
          g.checklist[key] = false;
          g.failures.push({ key, detail: `模型复核：${i.detail}` });
        }
      }
    }
  }

  // ── 3. 落审核记录 ──
  const reviewer = opts.reviewer ?? AUTO_REVIEWER;
  const out: AutoReviewLocale[] = [];
  for (const locale of LOCALES) {
    const rev = revs.get(locale)!;
    const g = gates.get(locale)!;
    const decision: ReviewDecision = g.failures.length ? "NEEDS_REVISION" : "APPROVED";
    const issueCategories = g.failures.length
      ? categorize(g.failures, llm.verdict === "BLOCK")
      : (["NO_ISSUE"] as ReviewIssueCategory[]);
    const notes = g.failures.length
      ? `自动审核未通过：\n${g.failures.map((f) => `- ${f.key}：${f.detail}`).join("\n")}`
      : `自动审核通过（十项确定性检查全过${llm.verdict === "PASS" && llm.ran ? "，模型复看未发现问题" : llm.verdict === "UNAVAILABLE" ? `，模型复看未跑成：${llm.message ?? ""}` : ""}）`;

    let reviewId: number | null = null;
    if (!opts.dryRun) {
      const r = await recordReview({
        translationId: rev.translationId, revisionId: rev.revisionId,
        reviewer, decision, checklist: g.checklist, issueCategories, notes,
      });
      if (!r.ok) {
        return {
          ...base, status: "BLOCKED", locales: out, llm, providerCalls: llm.providerCalls,
          message: `${locale} 审核记录写入被拒：${r.reason}`,
        };
      }
      reviewId = r.reviewId;
    }

    out.push({
      locale, translationId: rev.translationId, revisionId: rev.revisionId,
      revisionNumber: rev.revisionNumber,
      checklist: g.checklist, failures: g.failures, issueCategories, decision, notes, reviewId,
    });
  }

  const approved = out.every((o) => o.decision === "APPROVED");
  return {
    familyId: family.id, unitKey: family.unit_key,
    status: approved ? "APPROVED" : "BLOCKED",
    locales: out, llm, providerCalls: llm.providerCalls,
    message: approved ? null
      : `未通过的语言：${out.filter((o) => o.decision !== "APPROVED").map((o) => o.locale).join("、")}`,
  };
}
