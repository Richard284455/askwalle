import { prisma } from "@/lib/prisma";

import { httpUrlOrNull } from "../aihot/types";

/**
 * 公开归因。
 *
 * 产品决定：公开页**不展示实际信源名称**，也不在标题/导语/正文里强调 AI HOT。
 * 来源信息只保留在数据库与后台，供生成、忠实度 QA、审计与追溯使用。
 *
 * 落实方式有两层，缺一不可：
 *   1. **数据投影层**：公开 DTO 里根本没有实际来源字段。
 *      靠 CSS 隐藏是无效的 —— 名字仍在 HTML、RSC payload 与序列化 props 里。
 *   2. **渲染兜底层**：已批准的 revision 是不可变的，正文里可能仍带着
 *      早先生成的模板归因。那些只能在渲染时剔除，**绝不回头改原文**。
 */

export const PUBLIC_ATTRIBUTION_MODES = ["AIHOT_AND_GENERIC_ORIGINAL", "AIHOT_ONLY"] as const;
export type PublicAttributionMode = (typeof PUBLIC_ATTRIBUTION_MODES)[number];

/** 默认模式：保留原文入口，但只用通用文字，不写来源名 */
export const DEFAULT_ATTRIBUTION_MODE: PublicAttributionMode = "AIHOT_AND_GENERIC_ORIGINAL";

const MODE_KEY = "aihot:public-attribution-mode";
const AUTHORIZATION_KEY = "aihot:aihot-only-authorization";

export type AttributionModeResolution = {
  mode: PublicAttributionMode;
  requested: PublicAttributionMode;
  /** 请求了 AIHOT_ONLY 但没有书面授权时为 true，并已回落到默认模式 */
  deniedForMissingAuthorization: boolean;
  authorizationReference: string | null;
};

/**
 * 解析当前生效的公开归因模式。
 *
 * **fail closed**：AIHOT_ONLY 会去掉原文入口，属于对外承诺的变更，
 * 必须有显式记录的书面授权才允许生效。没有记录就回落到默认模式 ——
 * 宁可多给一个原文入口，也不要在没有授权的情况下把它撤掉。
 */
export async function resolveAttributionMode(): Promise<AttributionModeResolution> {
  const row = await prisma.setting.findUnique({ where: { key: MODE_KEY } }).catch(() => null);
  const raw = row?.value?.trim();
  const requested: PublicAttributionMode =
    raw && (PUBLIC_ATTRIBUTION_MODES as readonly string[]).includes(raw)
      ? (raw as PublicAttributionMode)
      : DEFAULT_ATTRIBUTION_MODE;

  if (requested !== "AIHOT_ONLY") {
    return { mode: requested, requested, deniedForMissingAuthorization: false, authorizationReference: null };
  }

  const auth = await prisma.setting.findUnique({ where: { key: AUTHORIZATION_KEY } }).catch(() => null);
  const reference = auth?.value?.trim() || null;
  if (!reference) {
    return {
      mode: DEFAULT_ATTRIBUTION_MODE, requested,
      deniedForMissingAuthorization: true, authorizationReference: null,
    };
  }
  return { mode: "AIHOT_ONLY", requested, deniedForMissingAuthorization: false, authorizationReference: reference };
}

// ── 渲染兜底：从不可变正文里剔除模板归因 ─────────────────────────────────

export type RedactionContext = {
  /** 数据库里的实际来源名称（可能是复合串），以及热点的来源名单 */
  sourceNames: string[];
  /** 内容标题。**出现在标题里的实体是事件主体，必须保留** */
  title: string;
  providerName: string;
};

/** 榜单的中性说法。品牌名只在底部出现 */
const NEUTRAL_FEED = "the trending list";

/**
 * 整句删除的模板归因句式。
 *
 * 只删「整句都在讲谁在报道」的句子 —— 删掉不损失任何事实。
 * **绝不能**用它去删含有事实的句子：早先那版按整句删，
 * 把「According to a post by X, OpenAI used Astra to solve ten problems」整句抹了，
 * 连同事实一起没了。事实必须留下，归因才是要去掉的那部分。
 */
const PURE_ATTRIBUTION_SENTENCE = [
  /sources?\s+(?:include|monitoring|currently monitoring|covering)/i,
  /the\s+(?:feed|page|listing|list)\s+(?:aggregates|links to)/i,
  /representative source/i,
  /the topic originates from/i,
  /(?:with )?additional coverage (?:from|came from)/i,
  /(?:AI\s*HOT|the trending (?:feed|list))\s+reports?\s+on\b/i,
  /^\s*source\s*:/i,
  /discovered via/i,
  /read (?:the )?original source/i,
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 句切分，保留结尾标点 */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?。！？])\s+/).filter((s) => s.trim().length > 0);
}

/**
 * 把实际来源名拆成需要屏蔽的片段。
 *
 * **出现在标题里的词一律豁免** —— 那是事件主体。
 * "DeepSeek-V4-Flash Official API Enters Public Beta" 这条里，
 * DeepSeek 既是来源名的一部分，也是新闻主体；屏蔽它等于把内容本身删了。
 */
export function redactionTokens(ctx: RedactionContext): string[] {
  const titleNorm = ctx.title.toLowerCase();
  const tokens = new Set<string>();
  for (const name of ctx.sourceNames) {
    if (!name) continue;
    const cleaned = name.trim();
    if (cleaned.length >= 3) tokens.add(cleaned);
    for (const m of cleaned.matchAll(/@[A-Za-z0-9_]{3,}/g)) tokens.add(m[0]);
    /*
     * 中日文来源名必须单独抽出来。
     * 「IT之家（RSS）」在正文里会写成「IT之家 (RSS)」—— 全角括号变半角、
     * 还多了个空格，整串精确匹配对不上。只按拉丁片段抽取则完全漏掉它，
     * 结果是西语/日语正文里赫然留着中文来源名。
     */
    for (const m of cleaned.matchAll(/[A-Za-z]*[\u4e00-\u9fff]+[A-Za-z]*/g)) {
      if (m[0].length >= 2) tokens.add(m[0]);
    }
    for (const m of cleaned.matchAll(/[A-Z][A-Za-z0-9.''-]{2,}(?:\s+[A-Z][A-Za-z0-9.''-]{2,})*/g)) {
      const frag = m[0].trim();
      if (frag.length >= 4) tokens.add(frag);
    }
  }
  // 标题里出现过的一律不屏蔽（事件主体）；同时排除过于通用的词
  const GENERIC = new Set(["rss", "web", "news", "blog", "feed", "the", "and", "api"]);
  return [...tokens]
    .filter((t) => !titleNorm.includes(t.toLowerCase()))
    .filter((t) => !GENERIC.has(t.toLowerCase()))
    .sort((a, b) => b.length - a.length); // 长的先替换，避免短片段先吃掉一半
}

/**
 * 去掉发布者归因**从句**，保留句子其余部分。
 *
 * 这是整个剔除逻辑的重心：归因是附加成分，事实是主干，
 * 只能砍附加成分。
 */
function stripAttributionClauses(text: string, names: string[]): string {
  let out = text;

  /*
   * 通用引导语。**四种语言都要覆盖** ——
   * 只处理英文的话，西语 "Según X," 与日文「Xによると、」会把来源名原样留在正文里。
   */
  out = out
    .replace(/\baccording to (?:a |the )?(?:post|report|update|announcement|statement)[^,.]{0,60}[,]\s*/gi, "")
    .replace(/\baccording to [^,.]{0,60}[,]\s*/gi, "")
    // 西语 / 巴葡
    .replace(/\b(?:Según|Segundo)\s+[^,.]{0,60}[,]\s*/gi, "")
    .replace(/\b(?:De acordo com|Conforme (?:relatado )?(?:pel[ao]|com))\s+[^,.]{0,60}[,]\s*/gi, "")
    .replace(/,\s*(?:según|segundo|conforme)\s+[^,.]{0,60}(?=[.。])/gi, "")
    // 日文：「Xによると、」「Xによれば、」「Xが伝えた」
    .replace(/[^、。\n]{0,40}(?:によると|によれば|に基づくと)[、]?\s*/g, "")
    .replace(/と[^、。\n]{0,30}(?:が伝えた|が報じた|は伝えている)/g, "")
    .replace(/,\s*according to [^,.]{0,60}(?=[.。])/gi, "")
    .replace(/,\s*as (?:reported|stated|noted) (?:by|in) [^,.]{0,60}(?=[.。])/gi, "")
    .replace(/\bas (?:reported|stated|noted) (?:by|in) [^,.]{0,60}[,]\s*/gi, "")
    .replace(/,\s*per [^,.]{0,40}(?=[.。])/gi, "");

  for (const name of names) {
    const n = escapeRe(name);
    out = out
      .replace(new RegExp(`\\b${n}\\s*\\(@[A-Za-z0-9_]+\\)\\s+(?:reported|reports|stated|states|said|says)\\s+that\\s+`, "gi"), "")
      .replace(new RegExp(`\\b${n}\\s+(?:reported|reports|stated|states|said|says)\\s+that\\s+`, "gi"), "")
      .replace(new RegExp(`,?\\s*according to ${n}\\b\\s*`, "gi"), " ")
      .replace(new RegExp(`,?\\s*as (?:reported|stated) (?:by|in) ${n}\\b\\s*`, "gi"), " ")
      // 残留的名字本身（含紧跟的括号 handle 与前面的介词）
      .replace(new RegExp(`\\s*\\b(?:from|by|via|on)\\s+${n}\\s*\\(@[A-Za-z0-9_]+\\)`, "gi"), "")
      .replace(new RegExp(`\\s*\\b(?:from|by|via|on)\\s+${n}\\b`, "gi"), "")
      .replace(new RegExp(`\\s*${n}\\s*\\(@[A-Za-z0-9_]+\\)\\s*`, "gi"), " ")
      .replace(new RegExp(`\\s*${n}\\s*`, "gi"), " ");
  }
  return out;
}

/**
 * 处理聚合方品牌。
 *
 * 品牌不是「替换成另一个名字」那么简单：它在句中既可能是归因主语
 * （"AI HOT reports that X" → 去掉主语，留下 X），也可能是地点状语
 * （"ranks #1 on AI HOT" → 换成中性说法）。分开处理才不会写出病句。
 */
function neutralizeProvider(text: string): string {
  return text
    // 归因主语：整个「AI HOT 说」去掉，保留后面的事实
    .replace(/\b(?:AI\s*HOT|the trending feed)\s+(?:reports?|reported|states?|stated|says?|said)\s+that\s+/gi, "")
    .replace(/\baccording to\s+(?:AI\s*HOT|the trending feed)\s*[,]?\s*/gi, "")
    // 「AI HOT 目前把这条列为…」→「这条目前被列为…」
    .replace(/\b(?:AI\s*HOT|the trending feed)\s+currently\s+lists?\s+this\s+as\b/gi, "This is currently listed as")
    .replace(/\b(?:AI\s*HOT|the trending feed)\s+(?:currently\s+)?ranks?\s+this\s+topic\s+at\b/gi, "This topic is ranked")
    .replace(/\b(?:AI\s*HOT|the trending feed)\s+is\s+currently\s+tracking\b/gi, "The trending list currently tracks")
    // 「AI HOT lists X as …」→「The trending list features X as …」，避免出现 "list lists"
    .replace(/\b(?:AI\s*HOT|the trending feed)\s+lists?\s+/gi, "The trending list features ")
    // 所有格与定冠词
    .replace(/\b(?:AI\s*HOT|the trending feed)['’]s\s+/gi, "the ")
    .replace(/\bthe\s+(?:AI\s*HOT|trending feed)\s+(?:board|leaderboard|list|feed)\b/gi, NEUTRAL_FEED)
    .replace(/\b(?:on|in)\s+(?:AI\s*HOT|the trending feed)\b/gi, `on ${NEUTRAL_FEED}`)
    // 标题式前缀 "AI HOT: xxx"
    .replace(/\bAI\s*HOT\s*[:：]\s*/gi, "")
    /*
     * 标题里的定语用法（"AI HOT Ranking Shows…"、"AI HOT Daily Briefing"）：
     * 直接删掉品牌词，不做替换。
     * 换成中性名词会写出「the trending list Ranking Shows Strong Signal」
     * 这种既不通顺、大小写也不对的标题 —— 标题里品牌词后面跟着大写词时，
     * 它是修饰语，删掉刚好，替换反而坏事。
     */
    .replace(/\bAI\s*HOT\s+(?=[A-Z])/g, "")
    // 兜底
    .replace(/\bAI\s*HOT\b/gi, NEUTRAL_FEED)
    .replace(/\bthe the\b/gi, "the");
}

/**
 * 清掉删名字之后留下的悬空引导词。
 *
 * 「IT之家（RSS）によると、欧州連合の…」删掉名字后会变成「によると、欧州連合の…」——
 * 句子以助词开头，读起来是残句。引导词本来就依附于那个名字，名字没了它也该走。
 */
function dropDanglingLeaders(text: string): string {
  return text
    .split("\n")
    .map((line) => line
      .replace(/^\s*(?:によると|によれば|に基づくと)[、,]?\s*/g, "")
      .replace(/^\s*(?:Según|Segundo|De acordo com|Conforme(?:\s+relatado)?(?:\s+pel[ao])?)\s*[,，]?\s*/gi, "")
      .replace(/^\s*(?:According to)\s*[,]?\s*/gi, "")
      .replace(/(^|[.。!?]\s*)(?:によると|によれば)[、,]\s*/g, "$1")
      .replace(/(^|[.!?]\s+)(?:Según|Segundo|De acordo com)\s*[,]\s*/gi, "$1")
      // "una publicación en X de, OpenAI …" 这类删名后留下的孤立介词
      .replace(/\s+(?:de|por|em|by|from)\s*,\s*/gi, ", ")
    )
    .join("\n");
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*\./g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+\)/g, ")")
    .replace(/\(\s+/g, "(")
    .replace(/^[\s,;:]+/gm, "")
    .split("\n").map((l) => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 句首与行首还原大写 */
function recapitalize(text: string): string {
  return text
    .replace(/(^|[.!?]\s+|\n)([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
}

/**
 * 渲染层归因剔除。
 *
 * **只动展示，不动 revision。** 已批准的正文是不可变的审计对象；
 * 这里返回的是它的公开投影。
 *
 * 顺序是关键：先砍从句（保住事实），再删纯归因整句，最后才做兜底 ——
 * 反过来会把带事实的句子整句抹掉。
 */
export function redactAttribution(text: string, ctx: RedactionContext): string {
  if (!text) return text;
  const tokens = redactionTokens(ctx);

  const lines = text.split(/\n/).map((line) => {
    if (!line.trim()) return "";
    // 1) 先在句内砍掉归因从句
    let work = stripAttributionClauses(line, tokens);
    work = neutralizeProvider(work);
    // 2) 再删「整句都是归因」的句子
    const sentences = splitSentences(work).filter(
      (s) => !PURE_ATTRIBUTION_SENTENCE.some((re) => re.test(s))
    );
    // 3) 兜底：仍带实际来源名、且去掉名字后所剩无几的句子整句删
    const kept = sentences.filter((s) => {
      const leaks = tokens.filter((t) => s.toLowerCase().includes(t.toLowerCase()));
      if (!leaks.length) return true;
      const stripped = stripAttributionClauses(s, leaks).trim();
      return stripped.split(/\s+/).filter(Boolean).length >= 5
        && !tokens.some((t) => stripped.toLowerCase().includes(t.toLowerCase()));
    }).map((s) => stripAttributionClauses(s, tokens));
    return kept.join(" ");
  });

  return recapitalize(tidy(dropDanglingLeaders(lines.join("\n"))));
}

/** 公开文本里是否仍残留实际来源名。测试与发布前检查都用它 */
export function findSourceLeaks(publicText: string, ctx: RedactionContext): string[] {
  const tokens = redactionTokens(ctx);
  const lower = publicText.toLowerCase();
  return tokens.filter((t) => lower.includes(t.toLowerCase()));
}

// ── 底部归因组件的数据 ────────────────────────────────────────────────────

export type PublicAttribution = {
  /**
   * 四种语言统一的英文品牌文案。
   *
   * 刻意**不含** mode 字段：模式是服务端决策，客户端不需要它。
   * 放进公开 DTO 只会让枚举名进 RSC payload，白白多一处对外暴露。
   */
  poweredByLabel: "Powered by AI HOT";
  providerUrl: string;
  /** 通用原文入口；AIHOT_ONLY 模式或链接非法时为 null。**永不含来源名** */
  originalHref: string | null;
};

export function buildPublicAttribution(args: {
  mode: PublicAttributionMode;
  providerUrl: string;
  originalSourceUrl: string | null;
}): PublicAttribution | null {
  const providerUrl = httpUrlOrNull(args.providerUrl);
  // AI HOT 链接非法 → 没有合法出处可声明，页面不该以可发布状态存在
  if (!providerUrl) return null;
  const originalHref = args.mode === "AIHOT_ONLY" ? null : httpUrlOrNull(args.originalSourceUrl);
  return { poweredByLabel: "Powered by AI HOT", providerUrl, originalHref };
}
