import crypto from "crypto";

import type { ClusteringInput, PairFeatures, ScoreResult } from "./types";

/**
 * 从边构造候选分组。
 *
 * **只有 EXACT_DOCUMENT_MATCH 允许求连通分量。**
 *
 * 原因是传递性在模糊匹配下根本不成立：A 和 B 像、B 和 C 像，完全可能
 * A 和 C 毫无关系 —— B 只是碰巧和两边都沾边。对 fuzzy 边跑连通分量，
 * 一条中间边就能把两簇无关文档焊成一个「事件」，而且越跑越大。
 * 「指向同一份文档」不一样：那是等价关系，传递性是它本来的性质。
 *
 * 所以本阶段 fuzzy 边只作为**独立的 pair review 候选**存在，
 * 不产生也不改变任何 candidate membership。合并要等人工或语义审核。
 */

export type ScoredPair = { features: PairFeatures; score: ScoreResult };

export type ClusterPlan = {
  exactGroups: number[][];
  singletons: number[];
};

/** 只用 exact 边求连通分量；fuzzy 边一律不参与 */
export function planClusters(packIds: number[], pairs: ScoredPair[]): ClusterPlan {
  const sorted = [...packIds].sort((a, b) => a - b);
  const parent = new Map<number, number>(sorted.map((id) => [id, id]));

  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // 小 id 当根：结果与输入顺序无关
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  for (const p of pairs) {
    if (p.score.classification !== "EXACT_DOCUMENT_MATCH") continue;
    union(p.features.leftPackId, p.features.rightPackId);
  }

  const groups = new Map<number, number[]>();
  for (const id of sorted) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(id);
  }

  const exactGroups: number[][] = [];
  const singletons: number[] = [];
  for (const members of [...groups.values()].sort((a, b) => a[0] - b[0])) {
    const ordered = [...members].sort((a, b) => a - b);
    if (ordered.length > 1) exactGroups.push(ordered);
    else singletons.push(ordered[0]);
  }
  return { exactGroups, singletons: singletons.sort((a, b) => a - b) };
}

/** 候选键必须只由成员决定 —— 同一批成员在同一规则版本下恒得同一个键 */
export function candidateKeyOf(type: "SINGLETON" | "EXACT_DOCUMENT_GROUP", members: number[]): string {
  const ordered = [...members].sort((a, b) => a - b);
  if (type === "SINGLETON") return `singleton:${ordered[0]}`;
  const digest = crypto.createHash("sha256").update(ordered.join(",")).digest("hex").slice(0, 24);
  return `exact:${digest}`;
}

/** 时间范围取成员里的最早/最晚；全无时间时返回 null */
export function timeRangeOf(members: ClusteringInput[]): { start: Date | null; end: Date | null } {
  const times = members.map((m) => m.timeValue).filter((t): t is Date => t !== null);
  if (!times.length) return { start: null, end: null };
  const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
  return { start: sorted[0], end: sorted[sorted.length - 1] };
}
