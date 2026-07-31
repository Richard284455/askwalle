import type { TimeReliability } from "./types";

/**
 * 时间信号。
 *
 * 优先级：页面 JSON_LD/META > 其他页面声明 > FEED > captured_at。
 *
 * 关键边界：**FEED 日期只是粗时间窗口**。它是订阅的说法，不是事件发生时间 ——
 * 订阅可以补发旧文，也可以把整批文章标成同一天。LOW / FALLBACK 只能用来
 * 放宽或收紧召回，绝不能单独支撑「这两件事同时发生」。
 */

export type TimeSignal = {
  timeValue: Date | null;
  timeSource: string;
  timeReliability: TimeReliability;
};

export function resolveTimeSignal(input: {
  documentPublishedAt: Date | null;
  publishedAtSource: string | null;
  capturedAt: Date;
}): TimeSignal {
  const source = (input.publishedAtSource ?? "NONE").toUpperCase();
  if (input.documentPublishedAt) {
    if (source === "JSON_LD" || source === "META") {
      return { timeValue: input.documentPublishedAt, timeSource: source, timeReliability: "HIGH" };
    }
    if (source === "FEED") {
      return { timeValue: input.documentPublishedAt, timeSource: "FEED", timeReliability: "LOW" };
    }
    // OPEN_GRAPH / HTML_TITLE / PAGE 等其它页面声明
    if (source !== "NONE") {
      return { timeValue: input.documentPublishedAt, timeSource: source, timeReliability: "MEDIUM" };
    }
  }
  return { timeValue: input.capturedAt, timeSource: "CAPTURED_AT", timeReliability: "FALLBACK" };
}

export function hoursBetween(a: Date | null, b: Date | null): number | null {
  if (!a || !b) return null;
  return Math.abs(a.getTime() - b.getTime()) / 3_600_000;
}

/** 任一方可靠性偏低时放宽窗口 —— 低可靠日期只能扩大召回，不能确认时间 */
export function isLowConfidence(pair: [TimeReliability, TimeReliability]): boolean {
  return pair.some((r) => r === "LOW" || r === "FALLBACK");
}
