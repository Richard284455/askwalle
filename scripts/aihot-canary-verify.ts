/**
 * AI HOT 内容链路的受保护状态核对。
 *
 *   npm run aihot:verify -- --capture-baseline   # 记录当前受保护状态为基线
 *   npm run aihot:verify                         # 与基线比对 + 内容自检
 *
 * 只读库并核对，不发请求、不调 provider、不写内容、不发布。
 *
 * **基线是动态记录的，不写死数字。** 写死绝对值的核对脚本活不过一个阶段：
 * 下一次正常的内容增长就会让它假报失败，然后所有人开始忽略它。
 * 受保护的是「本任务**不该**碰的东西」，不是「数字必须一直是那个数」。
 */
import { httpUrlOrNull } from "@/lib/content/aihot/types";
import { NEVER_BLOCKING_CODES } from "@/lib/content/multilingual/types";
import { LOCALES } from "@/lib/content/publishing/types";
import { prisma } from "@/lib/prisma";

import { createHash } from "crypto";

const BASELINE_KEY = "aihot:protected-baseline";
const CAPTURE = process.argv.includes("--capture-baseline");

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++; else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); }
  console.log(`  ${ok ? "✅" : "❌"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/**
 * 受保护状态：本任务**不允许**改动的东西。
 *
 * 刻意不含 MultilingualDraft / ArticleFamily / Publication / AI HOT 三张来源表 ——
 * 那些正是本链路该增长的地方，把它们锁死等于禁止工作本身。
 */
async function protectedState() {
  const ws = await prisma.website.findMany({
    select: { id: true, url: true, status: true, active: true }, orderBy: { id: "asc" },
  });
  /*
   * 逐个查，不并发 12 路。
   * 连接池是共享的（本地还开着 dev server），一次打满会直接拿到 P1001，
   * 而那个报错看起来像「数据库挂了」，其实只是我们自己把池占满了。
   */
  const factPacks = await prisma.sourceFactPack.count();
  const factClaims = await prisma.sourceFactClaim.count();
  const factEvidence = await prisma.sourceFactEvidence.count();
  const runs = await prisma.eventClusteringRun.count();
  const edges = await prisma.eventSimilarityEdge.count();
  const candidates = await prisma.eventClusterCandidate.count();
  const members = await prisma.eventClusterCandidateMember.count();
  const lifecycle = await prisma.toolLifecycleState.count();
  const resourceContent = await prisma.resourceContent.count();
  const sourceItems = await prisma.sourceItem.count();
  const contentSources = await prisma.contentSource.count();
  const generatedArticles = await prisma.generatedArticle.count();
  return {
    websiteUrlFingerprint: createHash("sha256")
      .update(ws.map((w) => `${w.id}|${w.url}`).join("\n")).digest("hex").slice(0, 16),
    websiteStatusFingerprint: createHash("sha256")
      .update(JSON.stringify(ws.map((w) => ({ id: w.id, status: w.status, active: w.active })))).digest("hex").slice(0, 16),
    factPacks, factClaims, factEvidence,
    clusteringRuns: runs, clusteringEdges: edges, clusterCandidates: candidates, clusterMembers: members,
    lifecycle, resourceContent, sourceItems, contentSources, generatedArticles,
  };
}

type Protected = Awaited<ReturnType<typeof protectedState>>;

async function main() {
  const now = await protectedState();

  if (CAPTURE) {
    await prisma.setting.upsert({
      where: { key: BASELINE_KEY },
      create: { key: BASELINE_KEY, value: JSON.stringify(now) },
      update: { value: JSON.stringify(now) },
    });
    console.log("已记录受保护状态基线：");
    for (const [k, v] of Object.entries(now)) console.log(`  ${k.padEnd(26)} ${v}`);
    console.log("\n后续运行 npm run aihot:verify 会与这份基线比对。");
    return;
  }

  console.log("AI HOT 内容链路核对\n");
  console.log("一、受保护状态（与基线比对）");
  const row = await prisma.setting.findUnique({ where: { key: BASELINE_KEY } });
  if (!row) {
    console.log("  ⚠ 尚无基线。先运行：npm run aihot:verify -- --capture-baseline");
    fail++;
    failures.push("缺少受保护状态基线");
  } else {
    const base = JSON.parse(row.value) as Protected;
    for (const key of Object.keys(now) as (keyof Protected)[]) {
      const b = base[key], n = now[key];
      check(`${key} 未变`, b === n, b === n ? String(n) : `基线 ${b} → 现在 ${n}`);
    }
  }

  console.log("\n二、AI HOT 内容与草稿");
  const selected = await prisma.aihotSelectedItem.count();
  const topics = await prisma.aihotHotTopicSnapshot.count();
  const dailies = await prisma.aihotDailyReport.count();
  const drafts = await prisma.multilingualDraft.count();
  console.log(`  精选 ${selected} · 热点快照 ${topics} · 日报 ${dailies} · 多语言草稿 ${drafts}`);

  const draftIssues = (await prisma.multilingualDraft.findMany({ select: { qa_issues_json: true } }))
    .flatMap((d) => (Array.isArray(d.qa_issues_json) ? (d.qa_issues_json as { code?: string }[]) : []))
    .map((i) => i.code ?? "");
  const tally = new Map<string, number>();
  for (const c of draftIssues) tally.set(c, (tally.get(c) ?? 0) + 1);
  check("数字漂移 0", !tally.get("NUMBER_MISMATCH"), String(tally.get("NUMBER_MISMATCH") ?? 0));
  check("日期漂移 0", !tally.get("DATE_MISMATCH"), String(tally.get("DATE_MISMATCH") ?? 0));
  check("模型版本漂移 0", !tally.get("MODEL_MISMATCH"), String(tally.get("MODEL_MISMATCH") ?? 0));
  check("新增事实 0", !tally.get("ENTITY_MISMATCH") && !tally.get("UNSUPPORTED_DETAIL"),
    `entity=${tally.get("ENTITY_MISMATCH") ?? 0} unsupported=${tally.get("UNSUPPORTED_DETAIL") ?? 0}`);
  check("翻译事实漂移 0", !tally.get("TRANSLATION_FACT_DRIFT"), String(tally.get("TRANSLATION_FACT_DRIFT") ?? 0));
  check("QA 从不产出重复/单一来源/未验证/低重要性结论",
    !draftIssues.some((c) => (NEVER_BLOCKING_CODES as readonly string[]).includes(c)));

  console.log("\n三、审核与发布");
  const families = await prisma.articleFamily.findMany({
    include: { translations: { include: { publications: true, reviews: true } } },
  });
  const pubs = await prisma.articlePublication.findMany({ where: { status: "PUBLISHED" } });
  console.log(`  家族 ${families.length} · 审核记录 ${families.reduce((n, f) => n + f.translations.reduce((m, t) => m + t.reviews.length, 0), 0)} · 已发布页面 ${pubs.length}`);

  const publishedFamilies = families.filter((f) => f.translations.some((t) => t.publications.some((p) => p.status === "PUBLISHED")));
  const incomplete = publishedFamilies.filter((f) => {
    const locales = new Set(f.translations.filter((t) => t.publications.some((p) => p.status === "PUBLISHED")).map((t) => t.locale));
    return locales.size !== LOCALES.length;
  });
  check("已发布家族均为四语言齐全", incomplete.length === 0,
    incomplete.map((f) => f.unit_key).join(", ") || `${publishedFamilies.length} 个家族`);

  const badAttr = families.filter((f) => !httpUrlOrNull(f.attribution_url));
  check("无效 attribution URL 0", badAttr.length === 0, badAttr.map((f) => f.unit_key).slice(0, 3).join(", "));
  const badSrc = families.filter((f) => f.original_source_url !== null && !httpUrlOrNull(f.original_source_url));
  check("无效原始来源 URL 0", badSrc.length === 0, badSrc.map((f) => f.unit_key).slice(0, 3).join(", "));

  // 每条发布记录都必须落在「已批准的那一版」上
  const mismatched = families.flatMap((f) => f.translations.filter((t) =>
    t.publications.some((p) => p.status === "PUBLISHED" && p.revision_id !== t.approved_revision_id)));
  check("发布的都是已批准的那一版", mismatched.length === 0, `${mismatched.length} 条不符`);

  const dupPaths = await prisma.$queryRawUnsafe<{ locale: string; path: string; n: bigint }[]>(
    `SELECT locale::text, path, COUNT(*) AS n FROM article_publications
      WHERE status='PUBLISHED' GROUP BY locale, path HAVING COUNT(*) > 1`);
  check("同一 locale 内路径无重复", dupPaths.length === 0, dupPaths.map((d) => `${d.locale}${d.path}`).join(", "));

  const unreviewedPublished = families.flatMap((f) => f.translations.filter((t) =>
    t.publications.some((p) => p.status === "PUBLISHED") && t.reviews.length === 0));
  check("已发布内容均有人工审核记录", unreviewedPublished.length === 0, `${unreviewedPublished.length} 条缺审核`);

  console.log("\n四、产品边界");
  check("未创建 AIEvent（该模型不存在，链路上也没有）",
    !Object.keys(prisma).some((k) => /^ai[eE]vent$/.test(k)));
  check("未写入 GeneratedArticle 发布态",
    (await prisma.generatedArticle.count({ where: { status: "PUBLISHED" } })) === 0);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) { console.log("\n未通过："); for (const f of failures) console.log(`  - ${f}`); }
  await prisma.$disconnect();
  if (fail) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
