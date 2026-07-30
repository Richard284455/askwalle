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

import type { ArticleFetchPolicy } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { normalizeUrl } from "@/lib/content/url-normalize";

type Tier = "OFFICIAL_PRIMARY" | "STRUCTURED_TECHNICAL" | "AUTHORITATIVE_MEDIA" | "COMMUNITY_SIGNAL";
const TIERS: Tier[] = ["OFFICIAL_PRIMARY", "STRUCTURED_TECHNICAL", "AUTHORITATIVE_MEDIA", "COMMUNITY_SIGNAL"];
const POLICIES: ArticleFetchPolicy[] = ["FEED_ONLY", "ON_DEMAND", "NEVER_FETCH", "ALWAYS_FETCH"];

/** 定义文件的字段形状（snake_case，与人工维护的 JSON 一致） */
type SourceDef = {
  external_key: string;
  name: string;
  publisher: string;
  source_tier: Tier;
  /** RSS / ATOM —— 仅声明；解析器仍会自行探测，两者不符值得报警 */
  adapter_type: "RSS" | "ATOM";
  feed_url?: string | null;
  homepage?: string | null;
  language?: string;
  enabled?: boolean;
  fetch_interval_minutes?: number;
  /** 人工确认记录：发布者身份与使用边界 */
  notes?: string;
  /** 正文抓取强度。缺省 FEED_ONLY —— 放宽必须在定义文件里显式写出来 */
  article_fetch_policy?: ArticleFetchPolicy;
};

const APPLY = process.argv.includes("--apply");
const FILE = process.argv.slice(2).find((a) => !a.startsWith("--"));

function validate(defs: unknown): SourceDef[] {
  if (!Array.isArray(defs)) throw new Error("定义文件顶层必须是数组");
  const seenKeys = new Set<string>();
  const seenUrls = new Set<string>();
  return defs.map((raw, i) => {
    const d = raw as SourceDef;
    const at = `第 ${i + 1} 条`;
    if (!d.external_key?.trim()) throw new Error(`${at}: 缺少 external_key`);
    if (seenKeys.has(d.external_key)) throw new Error(`${at}: external_key 重复: ${d.external_key}`);
    seenKeys.add(d.external_key);
    if (!d.name?.trim()) throw new Error(`${at}: 缺少 name`);
    if (!d.publisher?.trim()) throw new Error(`${at}: 缺少 publisher（发布者身份必须人工确认）`);
    if (!TIERS.includes(d.source_tier)) {
      throw new Error(`${at}: source_tier 必须是 ${TIERS.join(" / ")}`);
    }
    if (d.adapter_type !== "RSS" && d.adapter_type !== "ATOM") {
      throw new Error(`${at}: adapter_type 必须是 RSS 或 ATOM`);
    }
    if (!d.feed_url?.trim()) throw new Error(`${at}: 缺少 feed_url`);
    // 只校验合法性，**原样存储**。URL 归一化是给文章去重用的；订阅地址是人工确认过的
    // 配置端点，改写它（比如剥掉 /feed/ 的末尾斜杠）会让服务端 301 回来，白多一跳，
    // 还会把 feedMoved 误报成「源迁移」。
    if (!normalizeUrl(d.feed_url)) {
      throw new Error(`${at}: feed_url 不是合法的 http/https 地址: ${d.feed_url}`);
    }
    d.feed_url = d.feed_url.trim();
    if (seenUrls.has(d.feed_url)) throw new Error(`${at}: feed_url 重复: ${d.feed_url}`);
    seenUrls.add(d.feed_url);
    if (!d.notes?.trim()) throw new Error(`${at}: 缺少 notes（使用边界需人工确认后写明）`);
    if (d.article_fetch_policy && !POLICIES.includes(d.article_fetch_policy)) {
      throw new Error(`${at}: article_fetch_policy 必须是 ${POLICIES.join(" / ")}`);
    }
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
    // 身份以 external_key 为准：feed_url 可能迁移，配置与库靠它对齐
    const existing = await prisma.contentSource.findUnique({
      where: { external_key: def.external_key },
    });

    if (!existing) {
      plan.push({ action: "create", def });
      continue;
    }
    const desired: Record<string, unknown> = {
      name: def.name,
      homepage: def.homepage ?? null,
      publisher: def.publisher,
      source_tier: def.source_tier,
      declared_format: def.adapter_type,
      article_fetch_policy: def.article_fetch_policy ?? "FEED_ONLY",
      feed_url: def.feed_url ?? null,
      lang: def.language ?? "en",
      enabled: def.enabled ?? true,
      fetch_interval_minutes: def.fetch_interval_minutes ?? 60,
      notes: def.notes ?? null,
    };
    const changes = Object.entries(desired)
      .filter(([k, v]) => (existing as unknown as Record<string, unknown>)[k] !== v)
      .map(([k, v]) => `${k}: ${JSON.stringify((existing as unknown as Record<string, unknown>)[k])} → ${JSON.stringify(v)}`);
    plan.push({ action: changes.length ? "update" : "unchanged", def, id: existing.id, changes });
  }

  for (const p of plan) {
    const mark = p.action === "create" ? "＋新建" : p.action === "update" ? "～更新" : "＝不变";
    console.log(`  ${mark}  ${p.def.external_key}  ${p.def.name}${p.id ? ` (#${p.id})` : ""}`);
    console.log(`         ${p.def.source_tier} · ${p.def.adapter_type} · ${p.def.fetch_interval_minutes ?? 60} 分钟`);
    console.log(`         ${p.def.feed_url}`);
    console.log(`         发布者: ${p.def.publisher}`);
    console.log(`         边界: ${(p.def.notes ?? "").slice(0, 110)}${(p.def.notes ?? "").length > 110 ? "…" : ""}`);
    for (const c of p.changes ?? []) console.log(`         · ${c}`);
  }

  const counts = {
    create: plan.filter((p) => p.action === "create").length,
    update: plan.filter((p) => p.action === "update").length,
    unchanged: plan.filter((p) => p.action === "unchanged").length,
  };
  console.log(`\n新建 ${counts.create} · 更新 ${counts.update} · 不变 ${counts.unchanged}`);

  const tally = (key: (d: SourceDef) => string) => {
    const m = new Map<string, number>();
    for (const d of defs) m.set(key(d), (m.get(key(d)) ?? 0) + 1);
    return [...m].sort().map(([k, v]) => `${k}=${v}`).join(" · ");
  };
  console.log(`tier:    ${tally((d) => d.source_tier)}`);
  console.log(`policy:  ${tally((d) => d.article_fetch_policy ?? "FEED_ONLY")}`);
  console.log(`adapter: ${tally((d) => d.adapter_type)}`);
  console.log(`发布者:  ${tally((d) => d.publisher)}`);
  console.log(`校验:    external_key 无重复 ✅ · feed_url 无重复 ✅ · publisher/notes 均非空 ✅ · 全程未发网络请求 ✅`);

  // 文件里没有但库里有的源：只提示，不删不改
  const known = defs.map((d) => d.external_key);
  const orphans = await prisma.contentSource.findMany({
    where: { NOT: { external_key: { in: known } } },
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
      external_key: p.def.external_key,
      name: p.def.name,
      // RSS 与 ATOM 都走订阅抓取；kind 区分的是「订阅」还是「人工提交」
      kind: "rss" as const,
      declared_format: p.def.adapter_type,
      source_tier: p.def.source_tier,
      article_fetch_policy: p.def.article_fetch_policy ?? "FEED_ONLY",
      feed_url: p.def.feed_url ?? null,
      homepage: p.def.homepage ?? null,
      publisher: p.def.publisher,
      lang: p.def.language ?? "en",
      enabled: p.def.enabled ?? true,
      fetch_interval_minutes: p.def.fetch_interval_minutes ?? 60,
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
