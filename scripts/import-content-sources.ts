/**
 * 信息源定义的幂等导入。
 *
 *   npm run sources:import -- <definitions.json>            # dry-run
 *   npm run sources:import -- <definitions.json> --apply    # 写库
 *
 * 来源定义**只**通过本 CLI 进入数据库，不手工改表 —— 这样每个源的
 * Feed URL、发布者身份与使用边界都在版本化的文件里可审计。
 *
 * 幂等：以 feed_url 为身份键（manual 源以 name 为键）。重跑只会更新已变的字段，
 * 不会重复建源；**不删除**文件里没有的源（下线要显式 disable，不靠导入的副作用）。
 *
 * 本 CLI 不发任何网络请求，不抓取，不调 AI。
 */
import { readFileSync } from "fs";

import { prisma } from "@/lib/prisma";
import { normalizeUrl } from "@/lib/content/url-normalize";

type SourceDef = {
  name: string;
  kind: "rss" | "manual";
  feedUrl?: string | null;
  homepage?: string | null;
  publisher: string;
  lang?: string;
  enabled?: boolean;
  fetchIntervalMinutes?: number;
  /** 人工确认记录：发布者身份与使用边界 */
  notes?: string;
};

const APPLY = process.argv.includes("--apply");
const FILE = process.argv.slice(2).find((a) => !a.startsWith("--"));

function validate(defs: unknown): SourceDef[] {
  if (!Array.isArray(defs)) throw new Error("定义文件顶层必须是数组");
  return defs.map((raw, i) => {
    const d = raw as SourceDef;
    const at = `第 ${i + 1} 条`;
    if (!d.name?.trim()) throw new Error(`${at}: 缺少 name`);
    if (d.kind !== "rss" && d.kind !== "manual") throw new Error(`${at}: kind 必须是 rss 或 manual`);
    if (!d.publisher?.trim()) throw new Error(`${at}: 缺少 publisher（发布者身份必须人工确认）`);
    if (d.kind === "rss") {
      if (!d.feedUrl?.trim()) throw new Error(`${at}: rss 源必须有 feedUrl`);
      const n = normalizeUrl(d.feedUrl);
      if (!n) throw new Error(`${at}: feedUrl 不是合法的 http/https 地址: ${d.feedUrl}`);
      // 规范化后入库，避免同一个源因为末尾斜杠差异被建成两个
      d.feedUrl = n.url;
    } else if (d.feedUrl) {
      throw new Error(`${at}: manual 源不应有 feedUrl`);
    }
    if (!d.notes?.trim()) throw new Error(`${at}: 缺少 notes（使用边界需人工确认后写明）`);
    return d;
  });
}

async function main() {
  if (!FILE) {
    console.error("用法: npm run sources:import -- <definitions.json> [--apply]");
    process.exitCode = 1;
    return;
  }
  const defs = validate(JSON.parse(readFileSync(FILE, "utf8")));
  console.log(`定义文件 ${FILE} · ${defs.length} 条\n`);

  const plan: { action: "create" | "update" | "unchanged"; def: SourceDef; id?: number; changes?: string[] }[] = [];

  for (const def of defs) {
    const existing = def.kind === "rss"
      ? await prisma.contentSource.findUnique({ where: { feed_url: def.feedUrl! } })
      : await prisma.contentSource.findFirst({ where: { kind: "manual", name: def.name } });

    if (!existing) {
      plan.push({ action: "create", def });
      continue;
    }
    const desired: Record<string, unknown> = {
      name: def.name,
      homepage: def.homepage ?? null,
      publisher: def.publisher,
      lang: def.lang ?? "en",
      enabled: def.enabled ?? true,
      fetch_interval_minutes: def.fetchIntervalMinutes ?? 60,
      notes: def.notes ?? null,
    };
    const changes = Object.entries(desired)
      .filter(([k, v]) => (existing as unknown as Record<string, unknown>)[k] !== v)
      .map(([k, v]) => `${k}: ${JSON.stringify((existing as unknown as Record<string, unknown>)[k])} → ${JSON.stringify(v)}`);
    plan.push({ action: changes.length ? "update" : "unchanged", def, id: existing.id, changes });
  }

  for (const p of plan) {
    const mark = p.action === "create" ? "＋新建" : p.action === "update" ? "～更新" : "＝不变";
    console.log(`  ${mark}  ${p.def.name}${p.id ? ` (#${p.id})` : ""}`);
    console.log(`         ${p.def.kind}  ${p.def.feedUrl ?? "(人工提交)"}`);
    console.log(`         发布者: ${p.def.publisher}`);
    console.log(`         边界: ${p.def.notes}`);
    for (const c of p.changes ?? []) console.log(`         · ${c}`);
  }

  const counts = {
    create: plan.filter((p) => p.action === "create").length,
    update: plan.filter((p) => p.action === "update").length,
    unchanged: plan.filter((p) => p.action === "unchanged").length,
  };
  console.log(`\n新建 ${counts.create} · 更新 ${counts.update} · 不变 ${counts.unchanged}`);

  // 文件里没有但库里有的源：只提示，不删不改
  const known = new Set(defs.filter((d) => d.feedUrl).map((d) => d.feedUrl!));
  const orphans = await prisma.contentSource.findMany({
    where: { kind: "rss", NOT: { feed_url: { in: [...known] } } },
    select: { id: true, name: true, feed_url: true, enabled: true },
  });
  if (orphans.length) {
    console.log(`\n库中存在但定义文件未包含的源 ${orphans.length} 个（**不会被删除或停用**，下线请显式 disable）:`);
    for (const o of orphans) console.log(`  #${o.id} ${o.name} ${o.feed_url} enabled=${o.enabled}`);
  }

  if (!APPLY) {
    console.log("\n[dry-run] 加 --apply 才写库");
    return;
  }

  let created = 0;
  let updated = 0;
  for (const p of plan) {
    const data = {
      name: p.def.name,
      kind: p.def.kind,
      feed_url: p.def.feedUrl ?? null,
      homepage: p.def.homepage ?? null,
      publisher: p.def.publisher,
      lang: p.def.lang ?? "en",
      enabled: p.def.enabled ?? true,
      fetch_interval_minutes: p.def.fetchIntervalMinutes ?? 60,
      notes: p.def.notes ?? null,
    };
    if (p.action === "create") {
      await prisma.contentSource.create({ data });
      created++;
    } else if (p.action === "update") {
      // 只改定义字段；抓取状态（etag / next_fetch_at / 失败计数）一律不动
      await prisma.contentSource.update({ where: { id: p.id! }, data });
      updated++;
    }
  }
  console.log(`\n已新建 ${created} · 已更新 ${updated}`);

  const total = await prisma.contentSource.count();
  console.log(`当前信息源总数: ${total}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
