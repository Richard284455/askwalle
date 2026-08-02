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
import {
  captureProtectedBaseline, loadProtectedBaseline, readProtectedState, type ProtectedState,
} from "@/lib/content/publishing/protected-baseline";
import { LOCALES } from "@/lib/content/publishing/types";
import { prisma } from "@/lib/prisma";

const CAPTURE = process.argv.includes("--capture-baseline");

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++; else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); }
  console.log(`  ${ok ? "✅" : "❌"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const now = await readProtectedState();

  if (CAPTURE) {
    await captureProtectedBaseline();
    console.log("已记录受保护状态基线：");
    for (const [k, v] of Object.entries(now)) console.log(`  ${k.padEnd(26)} ${v}`);
    console.log("\n后续运行 npm run aihot:verify 会与这份基线比对。");
    return;
  }

  console.log("AI HOT 内容链路核对\n");
  console.log("一、受保护状态（与基线比对）");
  const base = await loadProtectedBaseline();
  if (!base) {
    console.log("  ⚠ 尚无基线。先运行：npm run aihot:verify -- --capture-baseline");
    fail++;
    failures.push("缺少受保护状态基线");
  } else {
    for (const key of Object.keys(now) as (keyof ProtectedState)[]) {
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

  const allDrafts = await prisma.multilingualDraft.findMany({
    select: { status: true, qa_issues_json: true },
  });
  const codesOf = (raw: unknown) =>
    (Array.isArray(raw) ? (raw as { code?: string }[]) : []).map((i) => i.code ?? "");
  const draftIssues = allDrafts.flatMap((d) => codesOf(d.qa_issues_json));

  /*
   * 漂移分两种，只有**漏过去**的才算失败。
   *
   *   - QA_FAILED 的草稿上带着漂移问题码 —— 那是确定性 QA 接住了它，
   *     内容并没有进入发布链路。把这算成失败，等于安全网每工作一次就报一次警。
   *   - DRAFTED 的草稿上还带着漂移问题码 —— 这才是真出事：
   *     它被标成可发布，却记着一条没解决的失真。
   */
  const escaped = allDrafts.filter((d) => d.status === "DRAFTED").flatMap((d) => codesOf(d.qa_issues_json));
  const tally = new Map<string, number>();
  for (const c of escaped) tally.set(c, (tally.get(c) ?? 0) + 1);
  const blocked = draftIssues.length - escaped.length;
  console.log(`  确定性 QA 已拦下 ${blocked} 项问题（拦下不算失败）`);

  check("数字漂移未漏过 QA", !tally.get("NUMBER_MISMATCH"), String(tally.get("NUMBER_MISMATCH") ?? 0));
  check("日期漂移未漏过 QA", !tally.get("DATE_MISMATCH"), String(tally.get("DATE_MISMATCH") ?? 0));
  check("模型版本漂移未漏过 QA", !tally.get("MODEL_MISMATCH"), String(tally.get("MODEL_MISMATCH") ?? 0));
  check("新增事实未漏过 QA", !tally.get("ENTITY_MISMATCH") && !tally.get("UNSUPPORTED_DETAIL"),
    `entity=${tally.get("ENTITY_MISMATCH") ?? 0} unsupported=${tally.get("UNSUPPORTED_DETAIL") ?? 0}`);
  check("翻译事实漂移未漏过 QA", !tally.get("TRANSLATION_FACT_DRIFT"), String(tally.get("TRANSLATION_FACT_DRIFT") ?? 0));
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

  /*
   * 每条发布记录都必须落在「当时被批准过的那一版」上。
   *
   * 判据取审核记录里的 approved_revision_id，不取译本上的同名字段：
   * 后者是可变指针，内容更新出新 revision 时会被**故意**清空
   * （不让旧批准替新稿背书）。用它当判据，每次正常更新都会误报。
   */
  const approvedRevisionIds = new Set(
    (await prisma.translationReview.findMany({
      where: { decision: "APPROVED", approved_revision_id: { not: null } },
      select: { approved_revision_id: true },
    })).map((r) => r.approved_revision_id!)
  );
  const mismatched = (await prisma.articlePublication.findMany({
    where: { status: "PUBLISHED" }, select: { revision_id: true, locale: true, path: true },
  })).filter((p) => !approvedRevisionIds.has(p.revision_id));
  check("发布的都是已批准的那一版", mismatched.length === 0,
    mismatched.slice(0, 3).map((p) => `${p.locale}${p.path}`).join(", ") || "0 条不符");

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
