import type { DraftLanguage } from "@prisma/client";

import { httpUrlOrNull } from "../aihot/types";

import { aliasesOf, entityPresent, normalizeForEntityMatch } from "./entity-alias";
import {
  dateCovered, dateKeys, looksLikeName, modelTokens, normModel, numberSet, numberTokens,
  properTokens, singularizeAcronym, spelledOutInEnglish, type Lang,
} from "./linguistics";
import { bodyLimitFor, type ContentUnitInput, type DraftContent, type MlIssue } from "./types";

/**
 * 忠实度 QA。**确定性规则，不用模型判模型。**
 *
 * 只回答一个问题：产出里的东西，AI HOT 的输入里有没有。
 * **不**回答「AI HOT 说的对不对」—— 那是外部事实核查，不在这条链路上。
 *
 * 也**不**产出 DUPLICATE_EVENT / SINGLE_SOURCE / NOT_EXTERNALLY_VERIFIED /
 * LOW_IMPORTANCE：内容重复、单一来源、未经外部验证都不是拒绝理由。
 */

/** 来源与母版的情态词。来源说「计划」，母版不得写成「已完成」 */
const TENTATIVE =
  /\b(plan(s|ned|ning)?|expect(s|ed)?|aim(s|ed)?|intend(s|ed)?|propose(s|d)?|will|would|may|might|could|upcoming|soon)\b|计划|预计|拟|有望|即将|将于|将要|据悉|传闻|或将/i;
const COMPLETED =
  /\b(has|have|had)\s+(launched|shipped|released|completed|delivered|achieved|deployed|rolled out)\b|\b(launched|shipped|released|completed|delivered|achieved|deployed)\s+(?:on|in|last)\b|已(经)?(发布|上线|完成|交付|部署|实现|推出)/i;

/** 按句切分。中英标点都要切，来源是中文而母版是英文 */
function clauses(text: string): string[] {
  return text.split(/[。！？；\n]+|(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 情态升级检查。
 *
 * 粗糙的做法是「来源里有『计划』且母版里有『已完成』就报警」——
 * 那会把「7 月 31 日发布了 X，计划第三季度开放 API」这种再正常不过的材料
 * 判成失真：两个说法各指各的事，根本不冲突。误报一多，真正的升级就被淹了。
 *
 * 所以只在能对上号时才报：找出**只**出现在来源「计划类」句子里的标识
 * （型号、数字），再看母版里断言「已完成」的句子有没有用到它们。
 */
function checkModality(article: string, corpus: string): MlIssue[] {
  const srcClauses = clauses(corpus);
  const tentativeClauses = srcClauses.filter((c) => TENTATIVE.test(c));
  if (!tentativeClauses.length) return [];
  const assertedClauses = srcClauses.filter((c) => !TENTATIVE.test(c));

  const tokensOf = (cs: string[]) => {
    const s = new Set<string>();
    for (const c of cs) {
      for (const m of modelTokens(c)) s.add(normModel(m));
      for (const n of numberTokens(c)) s.add(norm(n));
    }
    return s;
  };
  const assertedTokens = tokensOf(assertedClauses);
  // 来源里被明确标成「还没发生」的标识
  const tentativeOnly = [...tokensOf(tentativeClauses)].filter((t) => !assertedTokens.has(t));
  if (!tentativeOnly.length) return [];

  const issues: MlIssue[] = [];
  for (const sentence of clauses(article)) {
    if (!COMPLETED.test(sentence)) continue;
    const hit = tentativeOnly.find(
      (t) => normModel(sentence).includes(t) || norm(sentence).includes(t)
    );
    if (hit) {
      issues.push({
        code: "MODALITY_UPGRADE",
        detail: `来源把「${hit}」表述为计划/预期，产出却写成已完成`,
        snippet: sentence.slice(0, 90),
      });
      break;
    }
  }
  return issues;
}

/**
 * 这个专名是不是「凭空冒出来的」。
 *
 * 中文来源 → 英文母版这一步同时是翻译，所以被译过来的普通名词
 * （Intelligence、Index）永远不会逐字出现在中文语料里。判定因此分两种：
 *
 *   - 多词短语：只要**有一个**词能在来源里找到，就不算凭空冒出来
 *     （来源写「Artificial Analysis 智能指数」，母版写
 *     "Artificial Analysis Intelligence Index" 是忠实翻译，不是编造）；
 *   - 单个词：只查真正像名字的（登记实体 / 驼峰 / 全大写缩写），
 *     普通名词一律放过 —— 要求模型不许翻译名词是做不到的要求。
 */
function isNewEntity(phrase: string, corpusEntityNorm: string, corpusNorm: string): boolean {
  const known = (w: string) => aliasesOf(w).length > 1;
  const nameLike = phrase.split(/\s+/).filter(Boolean).filter((w) => looksLikeName(w, known));
  // 整个短语都是普通英文词 → 它是被翻译过来的说法，不是实体。
  // "Price-Performance Frontier" 对应「性价比前沿」，"Interactive AI" 对应
  // 「交互式AI系统」—— 都不该按「来源里没有这个词」去判编造
  if (!nameLike.length) return false;
  return !nameLike.some((w) => {
    const base = singularizeAcronym(w);
    return entityPresent(w, corpusEntityNorm) || entityPresent(base, corpusEntityNorm)
      || corpusNorm.includes(norm(w)) || corpusNorm.includes(norm(base));
  });
}

/** 语料归一化：统一连字符与空白，便于逐字比对 */
function norm(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‐-―−﹘﹣－]/g, "-")
    .toLowerCase()
    .replace(/[\s,]+/g, "");
}

/** 输入侧的可比语料：标题 + 正文 + 分栏 + 结构化事实 + 归因名 */
export function unitCorpus(input: ContentUnitInput): string {
  return [
    input.title,
    input.sourceText,
    input.attributionName,
    input.originalSourceName ?? "",
    input.publishedAt?.toISOString() ?? "",
    ...input.facts.map((f) => `${f.label} ${f.value}`),
    ...input.sections.flatMap((s) => [s.label ?? "", ...s.items.map((i) => `${i.title} ${i.summary ?? ""} ${i.sourceName ?? ""}`)]),
  ].join("\n");
}

/**
 * 母版 QA：英文母版 vs AI HOT 输入。
 *
 * 来源语言是中文，母版是英文 —— 这一步同时是改写与翻译，所以实体比对
 * 必须走别名表，否则「谷歌 → Google」会被当成凭空引入的实体。
 */
export function checkMasterFaithfulness(
  draft: DraftContent,
  input: ContentUnitInput
): { verdict: "PASSED" | "NEEDS_REWRITE"; issues: MlIssue[] } {
  const issues: MlIssue[] = [];
  const article = [draft.headline, draft.summary, draft.body].join("\n");
  const corpus = unitCorpus(input);
  const corpusNorm = norm(corpus);
  const corpusEntityNorm = normalizeForEntityMatch(corpus);

  if (!draft.headline?.trim() || !draft.summary?.trim() || !draft.body?.trim()) {
    issues.push({ code: "EMPTY_FIELD", detail: "标题、摘要或正文为空" });
  }

  // ── 归因链接必须真的能点开 ──
  if (!httpUrlOrNull(input.attributionUrl)) {
    issues.push({ code: "SOURCE_LINK_INVALID", detail: `AI HOT 归因链接非法: ${String(input.attributionUrl).slice(0, 80)}` });
  }
  if (input.originalSourceUrl !== null && !httpUrlOrNull(input.originalSourceUrl)) {
    issues.push({ code: "SOURCE_LINK_INVALID", detail: `原始来源链接非法: ${String(input.originalSourceUrl).slice(0, 80)}` });
  }

  // ── 数字：按数量级比，跨语言等价（4000万 ↔ $40 million）──
  const srcNumbers = numberSet(corpus, "SOURCE");
  for (const tok of numberTokens(article)) {
    const v = numberSet(tok, "EN_US");
    const one = [...v][0];
    if (one === undefined) continue;
    if (srcNumbers.has(one)) continue;
    // 退回字面：年份、计数这类没有单位的
    if (corpusNorm.includes(norm(tok))) continue;
    issues.push({ code: "NUMBER_MISMATCH", detail: `数字「${tok}」未出现在 AI HOT 输入中`, snippet: tok });
  }

  // ── 日期：折成规范键再比，允许精度降低但不允许多出来 ──
  const srcDates = dateKeys(corpus);
  for (const k of dateKeys(article)) {
    if (!dateCovered(k, srcDates)) {
      issues.push({ code: "DATE_MISMATCH", detail: `日期「${k}」未出现在 AI HOT 输入中`, snippet: k });
    }
  }

  // ── 型号/版本：必须逐字一致，GPT-5.6 写成 GPT-5 是实质失真 ──
  const srcModels = new Set(modelTokens(corpus).map(normModel));
  const srcModelNorm = norm(corpus);
  for (const m of modelTokens(article)) {
    if (srcModels.has(normModel(m))) continue;
    if (srcModelNorm.includes(normModel(m))) continue;
    issues.push({ code: "MODEL_MISMATCH", detail: `型号/版本「${m}」未出现在 AI HOT 输入中`, snippet: m });
  }

  /*
   * 专名：别名表 → 整体匹配 → 逐词回退。
   *
   * **刻意跳过标题。** 英文标题按惯例是 Title Case，
   * "Releases Lyria Music Generation Model" 里每个词都大写，
   * 拿大小写来认专名就会把整句话当成一串凭空冒出来的实体。
   * 标题里真正要紧的是数字与型号，那两项对全文（含标题）已经查过了。
   */
  for (const p of properTokens([draft.summary, draft.body].join("\n"))) {
    if (entityPresent(p, corpusEntityNorm)) continue;
    if (corpusNorm.includes(norm(p))) continue;
    if (!isNewEntity(p, corpusEntityNorm, corpusNorm)) continue;
    issues.push({ code: "ENTITY_MISMATCH", detail: `专名「${p}」未出现在 AI HOT 输入中`, snippet: p });
  }

  // ── 情态：来源标成「计划」的事，母版不得写成已完成 ──
  issues.push(...checkModality(article, corpus));

  // ── 归因：正文必须能追溯到原始来源或 AI HOT ──
  const attributionNames = [input.originalSourceName, input.attributionName].filter(Boolean) as string[];
  const articleEntityNorm = normalizeForEntityMatch(article);
  const hasAttribution = attributionNames.some((n) => {
    if (entityPresent(n, articleEntityNorm)) return true;
    // 来源名常是 "X：阿易 AI Notes (@AYi_AInotes)" 这种复合串，取其中的
    // 拉丁字母片段做匹配，避免因为括号与前缀而误判为「没有归因」
    const latin = n.match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) ?? [];
    return latin.some((frag) => articleEntityNorm.includes(normalizeForEntityMatch(frag)));
  });
  if (!hasAttribution) {
    issues.push({
      code: "ATTRIBUTION_MISMATCH",
      detail: `正文未提及来源（${attributionNames.join(" / ") || "无"}）`,
    });
  }

  // ── 篇幅：可用事实少却写得长，只能是编出来的 ──
  const limit = bodyLimitFor(input);
  if (draft.body.length > limit) {
    issues.push({
      code: "UNSUPPORTED_DETAIL",
      detail: `正文 ${draft.body.length} 字符，超过 ${input.contentForm} 的 ${limit} 上限`,
    });
  }

  return { verdict: issues.length === 0 ? "PASSED" : "NEEDS_REWRITE", issues };
}

const LANG_TO_PARSER: Record<DraftLanguage, Lang> = {
  EN_US: "EN_US", ES_ES: "ES_ES", PT_BR: "PT_BR", JA_JP: "JA_JP",
};

/**
 * 译文 QA：译文 vs 英文母版。
 *
 * 比对基准是**母版**而不是原始输入 —— 译文的职责是不改变母版的事实，
 * 母版是否忠实于来源已经在上一步判过了。基准搞错的话，母版的一处失真
 * 会在三种语言里各报一次，掩盖真正的翻译漂移。
 *
 * 只检查跨文字体系仍然可靠的三类：数字、日期、型号/版本，
 * 外加「译文里冒出母版没有的拉丁文专名」这一个方向。
 * 人名机构名在日语里可能音译成片假名，要求它们逐字出现只会制造噪声。
 */
export function checkTranslationDrift(
  master: DraftContent,
  translation: DraftContent,
  language: DraftLanguage,
  input: ContentUnitInput
): { verdict: "PASSED" | "NEEDS_REWRITE"; issues: MlIssue[] } {
  const issues: MlIssue[] = [];
  const lang = LANG_TO_PARSER[language];
  const masterText = [master.headline, master.summary, master.body].join("\n");
  const transText = [translation.headline, translation.summary, translation.body].join("\n");

  if (!translation.headline?.trim() || !translation.summary?.trim() || !translation.body?.trim()) {
    issues.push({ code: "EMPTY_FIELD", detail: "译文标题、摘要或正文为空", language });
    return { verdict: "NEEDS_REWRITE", issues };
  }

  // ── 数字：两个方向都查。少一个是丢事实，多一个是编事实 ──
  const mNums = numberSet(masterText, "EN_US");
  const tNums = numberSet(transText, lang);
  for (const v of mNums) {
    if (!tNums.has(v)) {
      issues.push({ code: "TRANSLATION_FACT_DRIFT", detail: `母版中的数值 ${v} 在译文中缺失`, snippet: String(v), language });
    }
  }
  for (const v of tNums) {
    if (mNums.has(v)) continue;
    // 母版把这个数写成了英文单词（third quarter → 第3四半期）——正常译法，不是漂移
    if (spelledOutInEnglish(v, masterText)) continue;
    issues.push({ code: "TRANSLATION_FACT_DRIFT", detail: `译文出现母版没有的数值 ${v}`, snippet: String(v), language });
  }

  // ── 日期 ──
  const mDates = dateKeys(masterText);
  const tDates = dateKeys(transText);
  for (const k of tDates) {
    if (!dateCovered(k, mDates)) {
      issues.push({ code: "TRANSLATION_FACT_DRIFT", detail: `译文出现母版没有的日期 ${k}`, snippet: k, language });
    }
  }
  for (const k of mDates) {
    if (!dateCovered(k, tDates)) {
      issues.push({ code: "TRANSLATION_FACT_DRIFT", detail: `母版中的日期 ${k} 在译文中缺失`, snippet: k, language });
    }
  }

  // ── 型号/版本：这类标识在任何语言里都不翻译，必须原样保留 ──
  const mModels = new Set(modelTokens(masterText).map(normModel));
  const tModels = new Set(modelTokens(transText).map(normModel));
  for (const m of mModels) {
    if (!tModels.has(m) && !normModel(transText).includes(m)) {
      issues.push({ code: "TRANSLATION_FACT_DRIFT", detail: `母版型号「${m}」在译文中缺失或被改写`, snippet: m, language });
    }
  }
  for (const m of tModels) {
    if (!mModels.has(m) && !normModel(masterText).includes(m)) {
      issues.push({ code: "TRANSLATION_FACT_DRIFT", detail: `译文出现母版没有的型号「${m}」`, snippet: m, language });
    }
  }

  // ── 新实体：只查「译文多出来」这个方向；同样跳过标题（Title Case）──
  const masterEntityNorm = normalizeForEntityMatch(masterText);
  for (const p of properTokens([translation.summary, translation.body].join("\n"))) {
    if (entityPresent(p, masterEntityNorm)) continue;
    if (!isNewEntity(p, masterEntityNorm, normalizeForEntityMatch(masterText))) continue;
    issues.push({ code: "ENTITY_MISMATCH", detail: `译文出现母版没有的专名「${p}」`, snippet: p, language });
  }

  // ── 归因必须活过翻译 ──
  const attributionNames = [input.originalSourceName, input.attributionName].filter(Boolean) as string[];
  const transEntityNorm = normalizeForEntityMatch(transText);
  const kept = attributionNames.some((n) => {
    if (entityPresent(n, transEntityNorm)) return true;
    const latin = n.match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) ?? [];
    return latin.some((frag) => transEntityNorm.includes(normalizeForEntityMatch(frag)));
  });
  if (!kept) {
    issues.push({ code: "ATTRIBUTION_MISMATCH", detail: "译文未保留来源归属", language });
  }

  // ── 篇幅：西语/巴葡天然比英文长，放宽到 1.5 倍再判 ──
  const limit = Math.round(bodyLimitFor(input) * 1.5);
  if (translation.body.length > limit) {
    issues.push({ code: "UNSUPPORTED_DETAIL", detail: `译文正文 ${translation.body.length} 字符，超过 ${limit} 上限`, language });
  }

  return { verdict: issues.length === 0 ? "PASSED" : "NEEDS_REWRITE", issues };
}
