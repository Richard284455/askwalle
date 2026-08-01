import { aliasesOf, entityPresent, normalizeForEntityMatch } from "./entity-alias";
import { looksLikeName, numberTokens, properTokens } from "./linguistics";
import { HOT_TOPIC_WORD_BAND, type ContentUnitInput, type DraftContent, type MlIssue } from "./types";

/**
 * 热点简报的忠实度 QA。
 *
 * 它**不评价热点重不重要、是不是真的** —— 那两件事都不在这条链路的职责里。
 * 它只回答一个问题：这篇简报有没有超出 AI HOT 榜单实际给出的东西。
 *
 * 热点是这条链路上最容易出事的体裁：素材常常只有一个标题和几个计数，
 * 而「写一篇简报」的惯性会让模型去补背景、补影响、补时间。
 * 所以这里的检查比其它体裁更严，而且逐项对应可核对的字段。
 *
 * 只跑在**英文母版**上。译文的事实一致性由 checkTranslationDrift 负责 ——
 * 它以母版为基准做双向数值与型号比对，比在四种语言里各写一套正则可靠得多。
 */

/** 「N 个来源 / N 条信号」这类表述里的关键词 */
const SOURCE_WORDS = /\b(sources?|outlets?|feeds?|publishers?|signals?|mentions?|posts?)\b/i;
const RANK_WORDS = /\b(rank(ed|ing)?|position|number|#|top|no\.)\b/i;

/** 事件发生类动词。榜单抓取时间被写成这些动作发生的时间，就是失真 */
const EVENT_VERBS =
  /\b(announced|released|launched|unveiled|shipped|published|introduced|debuted|occurred|happened|went live|rolled out)\b/i;

/**
 * 「这是榜单信号」的表述。
 *
 * SIGNAL 模式下素材只有标题与计数，简报**必须**把自己的性质讲明白，
 * 否则读者会当成一篇完整报道 —— 而它根本没有支撑一篇报道的材料。
 */
const SIGNAL_FRAMING =
  /\b(trending|currently lists?|is being tracked|being tracked|tracked across|listed as|does not include|no further details?|available feed|signal)\b/i;

/** 按句切分，便于把「时间」和「动作」放在同一句里判断 */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** 把日期折成 YYYY-MM-DD，用于和 captured_at / latest_at 比对 */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 热点母版 QA。
 *
 * 返回的问题码全部是热点专属或通用阻断码；**永远不会**返回
 * LOW_IMPORTANCE / SOURCE_INSUFFICIENT / NEEDS_SECOND_SOURCE / DUPLICATE_EVENT ——
 * 那些是已经取消的门禁，重新出现就说明规则被写回去了。
 */
export function checkHotTopicBrief(
  draft: DraftContent,
  input: ContentUnitInput
): { verdict: "PASSED" | "NEEDS_REWRITE"; issues: MlIssue[] } {
  const issues: MlIssue[] = [];
  const ht = input.hotTopic;
  if (!ht) return { verdict: "PASSED", issues };

  const article = [draft.headline, draft.summary, draft.body].join("\n");

  if (!draft.headline?.trim() || !draft.summary?.trim() || !draft.body?.trim()) {
    issues.push({ code: "EMPTY_FIELD", detail: "标题、摘要或正文为空" });
    return { verdict: "NEEDS_REWRITE", issues };
  }

  // ── 归因链接 ──
  if (!/^https?:\/\/[^\s]+\.[^\s]+/.test(input.attributionUrl)) {
    issues.push({ code: "SOURCE_LINK_INVALID", detail: `AI HOT 链接非法：${input.attributionUrl}` });
  }

  // ── 允许出现的数字：只有 API 真给过的那些 ──
  /*
   * 允许集必须覆盖 facts。
   * 来源计数、信号数、名次、抓取时间**只**存在于结构化字段里 ——
   * 漏掉它们，等于把我们亲手喂给模型的每一个数字都判成「凭空冒出来的」。
   */
  const materialText = [
    input.title, input.sourceText, ht.sourceNames.join(" "),
    ...input.facts.map((f) => f.value),
    ...input.sections.flatMap((s) => s.items.map((i) => `${i.title} ${i.summary ?? ""}`)),
  ].join("\n");
  const allowed = new Set<string>();
  for (const v of [ht.sourceCount, ht.signalCount, ht.rank, ht.sourceNames.length]) {
    if (v !== null && v !== undefined) allowed.add(String(v));
  }
  for (const t of numberTokens(materialText)) allowed.add(t.replace(/[^\d.]/g, ""));

  for (const tok of numberTokens(article)) {
    const bare = tok.replace(/[^\d.]/g, "");
    if (!bare || allowed.has(bare)) continue;
    // 数字紧挨着「来源/信号」这类词时，说的就是计数，按计数不符处理
    const near = sentences(article).find((s) => s.includes(tok));
    const isCount = near ? SOURCE_WORDS.test(near) : false;
    issues.push({
      code: isCount ? "HOT_TOPIC_SOURCE_COUNT_MISMATCH" : "HOT_TOPIC_UNSUPPORTED_DETAIL",
      detail: isCount
        ? `文中的来源/信号计数「${tok}」与 AI HOT 给出的 source=${ht.sourceCount} signal=${ht.signalCount} 不符`
        : `数字「${tok}」不在 AI HOT 提供的字段里`,
      snippet: tok,
    });
  }

  // ── 计数如果被写出来，必须写对 ──
  for (const s of sentences(article)) {
    if (!SOURCE_WORDS.test(s)) continue;
    const nums = numberTokens(s).map((t) => t.replace(/[^\d.]/g, "")).filter(Boolean);
    for (const n of nums) {
      const ok = [ht.sourceCount, ht.signalCount, ht.sourceNames.length]
        .filter((v) => v !== null && v !== undefined).map(String).includes(n);
      if (!ok && allowed.has(n)) continue; // 来自标题/摘要的数字，不是计数
      if (!ok) {
        issues.push({
          code: "HOT_TOPIC_SOURCE_COUNT_MISMATCH",
          detail: `「${n}」被当作来源/信号计数，但 AI HOT 给的是 source=${ht.sourceCount} signal=${ht.signalCount}`,
          snippet: s.slice(0, 100),
        });
      }
    }
  }

  // ── 排名 ──
  for (const s of sentences(article)) {
    if (!RANK_WORDS.test(s)) continue;
    const nums = numberTokens(s).map((t) => t.replace(/[^\d.]/g, "")).filter(Boolean);
    for (const n of nums) {
      // 计数词同现时优先当计数，已在上面判过
      if (SOURCE_WORDS.test(s)) continue;
      if (ht.rank === null) {
        issues.push({
          code: "HOT_TOPIC_RANK_MISMATCH",
          detail: `文中给出了名次「${n}」，但 AI HOT 未提供排名`, snippet: s.slice(0, 100),
        });
      } else if (n !== String(ht.rank)) {
        issues.push({
          code: "HOT_TOPIC_RANK_MISMATCH",
          detail: `文中名次「${n}」与 AI HOT 榜单名次 ${ht.rank} 不符`, snippet: s.slice(0, 100),
        });
      }
    }
  }

  // ── 来源名称：只能出现名单里有的 ──
  const nameCorpus = normalizeForEntityMatch(
    [input.title, ht.sourceNames.join(" "), input.sourceText, "AI HOT", input.attributionName].join("\n")
  );
  const known = (w: string) => aliasesOf(w).length > 1;
  for (const p of properTokens([draft.summary, draft.body].join("\n"))) {
    if (entityPresent(p, nameCorpus)) continue;
    const nameLike = p.split(/\s+/).filter((w) => looksLikeName(w, known));
    if (!nameLike.length) continue;
    if (nameLike.some((w) => entityPresent(w, nameCorpus))) continue;
    issues.push({
      code: "HOT_TOPIC_SOURCE_NAME_MISMATCH",
      detail: `「${p}」不在 AI HOT 给出的来源名单或标题里`, snippet: p,
    });
  }

  // ── 抓取时间不得写成事件发生时间 ──
  const timeDays = [isoDay(ht.capturedAt), ht.latestAt ? isoDay(ht.latestAt) : null].filter(Boolean) as string[];
  for (const s of sentences(article)) {
    const mentionsDay = timeDays.some((d) => s.includes(d) || s.includes(d.slice(5)));
    if (!mentionsDay) continue;
    if (EVENT_VERBS.test(s) && !/\b(as of|listed|tracked|captured|updated|recorded)\b/i.test(s)) {
      issues.push({
        code: "HOT_TOPIC_TIME_MISREPRESENTED",
        detail: "AI HOT 的抓取/更新时间被写成了事件发生的时间",
        snippet: s.slice(0, 110),
      });
      break;
    }
  }

  // ── SIGNAL 模式：必须自报家门，且不得断言事件细节 ──
  if (ht.mode === "SIGNAL") {
    /*
     * 自述必须出现在**正文**里，不能只靠标题。
     * 标题写个 "Trending" 而正文通篇像完整报道，读者读到的仍然是一篇报道 ——
     * 框定作用得落在他真正会读的那段文字上。
     */
    if (!SIGNAL_FRAMING.test(draft.body)) {
      issues.push({
        code: "HOT_TOPIC_TIME_MISREPRESENTED",
        detail: "SIGNAL 简报未说明这是 AI HOT 榜单信号，读者会误当成完整报道",
      });
    }
    const words = wordCount(draft.body);
    const band = HOT_TOPIC_WORD_BAND.SIGNAL;
    if (words > band.max) {
      issues.push({
        code: "HOT_TOPIC_UNSUPPORTED_DETAIL",
        detail: `SIGNAL 正文 ${words} 词，超过 ${band.max} 词上限 —— 素材只有标题与计数，多出来的篇幅没有出处`,
      });
    }
  } else {
    const words = wordCount(draft.body);
    const band = HOT_TOPIC_WORD_BAND.ENRICHED;
    if (words > band.max) {
      issues.push({
        code: "HOT_TOPIC_UNSUPPORTED_DETAIL",
        detail: `ENRICHED 正文 ${words} 词，超过 ${band.max} 词上限`,
      });
    }
  }

  return { verdict: issues.length === 0 ? "PASSED" : "NEEDS_REWRITE", issues };
}
