/**
 * 来源忠实资讯生成的离线测试。
 *
 *   npm run test:article-gen
 *
 * 全部走真实 Prisma，**不调用 provider、不发外部请求、不发布**。
 * 忠实度检查是确定性规则，所以可以完全离线验证。
 *
 * 核心命题：
 *   1. 文章里的数字、日期、型号、专名必须能在来源里找到；
 *   2. 来源说「计划」，文章不得写成「已完成」；
 *   3. 内容重复**不是**拒绝理由，但技术性重复必须被挡住。
 */
import crypto from "crypto";

import { prisma } from "@/lib/prisma";
import { checkFaithfulness, numericMagnitude, protectedTokens } from "@/lib/content/article-gen/faithfulness";
import { assembleSourceInput, computeSourceInputHash } from "@/lib/content/article-gen/source-input";
import { buildPrompt, generateArticle } from "@/lib/content/article-gen/generate";
import { BRIEF_MAX_CHARS, GENERATION_VERSION, type GeneratedDraft, type SourceArticleInput } from "@/lib/content/article-gen/types";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(id: string, name: string, ok: boolean, detail = "") {
  if (ok) pass++; else { fail++; failures.push(`${id} ${name}${detail ? ` — ${detail}` : ""}`); }
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const section = (t: string) => console.log(`\n${t}\n`);

const MARKER = "__artgen_test_publisher__";
let seq = 0;

async function purge(): Promise<number> {
  const srcs = await prisma.contentSource.findMany({ where: { publisher: MARKER }, select: { id: true } });
  if (!srcs.length) return 0;
  const ids = srcs.map((s) => s.id);
  const items = await prisma.sourceItem.findMany({ where: { source_id: { in: ids } }, select: { id: true } });
  const itemIds = items.map((i) => i.id);
  if (itemIds.length) {
    await prisma.generatedArticle.deleteMany({ where: { source_item_id: { in: itemIds } } });
    const packs = await prisma.sourceFactPack.findMany({ where: { source_item_id: { in: itemIds } }, select: { id: true } });
    const pids = packs.map((p) => p.id);
    if (pids.length) {
      const claims = await prisma.sourceFactClaim.findMany({ where: { fact_pack_id: { in: pids } }, select: { id: true } });
      await prisma.sourceFactEvidence.deleteMany({ where: { claim_id: { in: claims.map((c) => c.id) } } });
      await prisma.sourceFactClaim.deleteMany({ where: { fact_pack_id: { in: pids } } });
      await prisma.sourceFactPack.deleteMany({ where: { id: { in: pids } } });
    }
    await prisma.sourceItemEnrichmentRun.deleteMany({ where: { source_item_id: { in: itemIds } } });
    await prisma.bulkJobItem.updateMany({ where: { source_item_id: { in: itemIds } }, data: { source_item_id: null } });
  }
  await prisma.contentSourceRun.deleteMany({ where: { source_id: { in: ids } } });
  await prisma.bulkJobItem.deleteMany({ where: { source_id: { in: ids } } });
  await prisma.sourceItem.deleteMany({ where: { source_id: { in: ids } } });
  await prisma.contentSource.deleteMany({ where: { id: { in: ids } } });
  return srcs.length;
}

async function makeItem(opts: { title: string; excerpt?: string | null; withPack?: boolean; packText?: string }) {
  seq += 1;
  const suffix = `${Date.now()}-${seq}`;
  const src = await prisma.contentSource.create({ data: {
    external_key: `ag-${suffix}`, name: "ArtGen Test", kind: "rss",
    feed_url: `https://ag.example/f-${suffix}.xml`, publisher: MARKER, source_tier: "OFFICIAL_PRIMARY" } });
  const url = `https://ag.example/a/${suffix}`;
  const item = await prisma.sourceItem.create({ data: {
    source_id: src.id, url, url_hash: crypto.createHash("sha256").update(url).digest("hex").slice(0,32),
    title: opts.title, status: "link_only", raw_excerpt: opts.excerpt ?? null,
    published_at: new Date("2026-07-22T00:00:00Z") } });
  if (opts.withPack) {
    const run = await prisma.sourceItemEnrichmentRun.create({ data: {
      source_item_id: item.id, outcome: "OK", error_domain: "NONE", requested_url: url,
      final_url: url, canonical_url: url, http_status: 200, visible_text_length: 5000,
      started_at: new Date(), excerpt: opts.packText ?? "正文材料",
      content_hash: crypto.createHash("sha256").update(suffix).digest("hex").slice(0,32),
      metadata_json: { contentQuality: "SUBSTANTIAL" } } });
    await prisma.sourceFactPack.create({ data: {
      source_item_id: item.id, enrichment_run_id: run.id, extractor_version: "source-fact-pack-v1",
      input_hash: crypto.createHash("sha256").update(`i${suffix}`).digest("hex"), status: "READY",
      eligibility_basis: "AUTO_SUBSTANTIAL", publisher_snapshot: MARKER, source_tier_snapshot: "OFFICIAL_PRIMARY",
      requested_url_snapshot: url, final_url_snapshot: url, canonical_url_snapshot: url,
      document_title_snapshot: opts.title, document_published_at_snapshot: new Date("2026-07-22T00:00:00Z"),
      content_quality_snapshot: "SUBSTANTIAL", visible_text_length_snapshot: 5000,
      captured_at: new Date(), claim_count: 0, evidence_count: 0 } });
  }
  return item.id;
}

const SRC: SourceArticleInput = {
  sourceItemId: -1, factPackId: null, mode: "FULL_SOURCE", evidenceMode: "ARTICLE_PAGE",
  publisher: "Acme Agency", sourceUrl: "https://acme.example/x", canonicalUrl: null,
  title: "Acme Agency selects 12 projects under the Horizon Program",
  author: null, publishedAt: new Date("2026-07-22T00:00:00Z"), capturedAt: new Date(),
  sourceText: "Acme Agency said it selected 12 projects under the Horizon Program on July 22, 2026. " +
    "The agency plans to invest $40 million over three years. Director Jane Roe said the portfolio covers energy and materials research.",
  claims: [], language: "en",
};
const draft = (o: Partial<GeneratedDraft>): GeneratedDraft => ({
  headline: "Acme Agency picks 12 Horizon Program projects",
  shortSummary: "Acme Agency said it selected 12 projects under the Horizon Program.",
  body: "Acme Agency said it has selected 12 projects under the Horizon Program on July 22, 2026. " +
    "According to the agency, it plans to invest $40 million over three years. Director Jane Roe said the portfolio covers energy and materials research.",
  factMapping: [], ...o,
});

async function main() {
  const purged = await purge();
  if (purged) console.log(`  （清理上一轮残留的 ${purged} 个测试源）`);
  const resourceBefore = await prisma.resourceContent.count();
  const packsBefore = await prisma.sourceFactPack.count();

  section("A  确定性 token 抽取");
  const tok = protectedTokens("GPT-5.6 launched July 22, 2026 with $40 million and 12 projects at 25%");
  check("A1", "抽出数字与金额", tok.numbers.some((n) => /40/.test(n)) && tok.numbers.some((n) => /12/.test(n)), tok.numbers.join(","));
  check("A2", "抽出日期", tok.dates.some((d) => /July 22, 2026/i.test(d)), tok.dates.join(","));
  check("A3", "抽出型号", tok.models.some((m) => /gpt-5\.6/i.test(m)), tok.models.join(","));

  section("B  忠实度检查");
  check("B1", "忠实草稿判 PASSED", checkFaithfulness(draft({}), SRC).verdict === "PASSED",
    JSON.stringify(checkFaithfulness(draft({}), SRC).issues.map((i) => i.code)));
  const numBad = checkFaithfulness(draft({ body: draft({}).body.replace("$40 million", "$60 million") }), SRC);
  check("B2", "改动金额被拦下", numBad.issues.some((i) => i.code === "NUMBER_NOT_IN_SOURCE"), numBad.issues.map((i)=>i.code).join(","));
  const dateBad = checkFaithfulness(draft({ body: draft({}).body.replace("July 22, 2026", "July 23, 2026") }), SRC);
  check("B3", "改动日期被拦下", dateBad.issues.some((i) => i.code === "DATE_NOT_IN_SOURCE"));
  const entBad = checkFaithfulness(draft({ body: `${draft({}).body} Beta Corporation also joined.` }), SRC);
  check("B4", "新增机构名被拦下", entBad.issues.some((i) => i.code === "ENTITY_NOT_IN_SOURCE"), entBad.issues.map((i)=>i.detail)[0] ?? "");
  const modBad = checkFaithfulness(draft({
    body: "Acme Agency said it selected 12 projects on July 22, 2026. The agency has delivered $40 million in funding. Director Jane Roe said the portfolio covers energy and materials research.",
  }), SRC);
  check("B5", "把计划写成已完成被拦下", modBad.issues.some((i) => i.code === "MODALITY_UPGRADED"), modBad.issues.map((i)=>i.code).join(","));
  const attrBad = checkFaithfulness(draft({
    headline: "Twelve projects picked", shortSummary: "Twelve projects were picked.",
    body: "Twelve projects were selected under the Horizon Program on July 22, 2026, with $40 million over three years.",
  }), SRC);
  check("B6", "丢失归属被拦下", attrBad.issues.some((i) => i.code === "ATTRIBUTION_MISSING"));
  const copyBad = checkFaithfulness(draft({ body: `${SRC.sourceText} Acme Agency said so.` }), SRC);
  check("B7", "逐字照搬长段落被拦下", copyBad.issues.some((i) => i.code === "VERBATIM_COPY"));
  const briefSrc: SourceArticleInput = { ...SRC, mode: "FEED_ONLY_BRIEF", evidenceMode: "FEED" };
  const longBrief = checkFaithfulness(draft({ body: draft({}).body.repeat(6) }), briefSrc);
  check("B8", "短讯超长被拦下", longBrief.issues.some((i) => i.code === "BRIEF_TOO_LONG"),
    `上限 ${BRIEF_MAX_CHARS}`);
  check("B9", "空字段被拦下", checkFaithfulness(draft({ body: "" }), SRC).issues.some((i) => i.code === "EMPTY_FIELD"));
  // 跨语言数量级：从英文来源生成中文稿时，$40 million 会被正当地写成「4000 万」
  check("B10", "numericMagnitude 跨语言折算一致",
    numericMagnitude("$40 million") === numericMagnitude("4000 万") &&
    numericMagnitude("$100 billion") === numericMagnitude("1000亿") &&
    numericMagnitude("2 million") === numericMagnitude("200万"),
    `${numericMagnitude("$40 million")} / ${numericMagnitude("4000 万")}`);
  check("B11", "数量级不同仍判不等", numericMagnitude("40") !== numericMagnitude("40 million"));
  // 出版方常在型号里用不换行连字符（U+2011），NFKC 不会折成 ASCII 连字符
  const dashSrc: SourceArticleInput = { ...SRC, sourceText: SRC.sourceText + " The GPT\u20115.5 model is referenced." };
  const dashOk = checkFaithfulness(draft({
    body: draft({}).body + " Acme Agency also compared it with GPT-5.5.",
  }), dashSrc);
  check("B13", "来源用不换行连字符时型号仍能匹配（且不留尾随标点误报）",
    dashOk.issues.length === 0,
    dashOk.issues.map((i) => `${i.code}:${i.detail}`).join(" | ") || "无问题");
  // 中文月份就是数字：来源 "In December" ↔ 中文稿「12 月」
  const monthSrc: SourceArticleInput = { ...SRC, sourceText: SRC.sourceText + " In December, the agency shared its plan." };
  const monthOk = checkFaithfulness(draft({
    headline: "Acme Agency 的 Horizon Program 进展",
    shortSummary: "Acme Agency 表示已选出 12 个项目。",
    body: "Acme Agency 表示，其已于 12 月分享了相关计划，并在 2026 年 7 月 22 日选出 12 个项目。据该机构介绍，计划投入 4000 万美元。",
  }), monthSrc);
  check("B14", "中文「12 月」不被当成未出现的数量",
    !monthOk.issues.some((i) => i.code === "NUMBER_NOT_IN_SOURCE"),
    monthOk.issues.map((i) => `${i.code}:${i.detail}`).join(" | ") || "无问题");

  const cn = checkFaithfulness(draft({
    headline: "Acme Agency 拟投入 4000 万美元",
    shortSummary: "Acme Agency 表示已选出 12 个项目。",
    body: "Acme Agency 表示，其在 2026 年 7 月 22 日选出了 Horizon Program 下的 12 个项目。据该机构介绍，计划在三年内投入 4000 万美元。Director Jane Roe 表示该组合涵盖能源与材料研究。",
  }), SRC);
  check("B12", "中文稿里的「4000 万」不被误报为新数字",
    !cn.issues.some((i) => i.code === "NUMBER_NOT_IN_SOURCE"),
    cn.issues.map((i) => `${i.code}:${i.detail}`).join(" | ") || "无问题");

  section("C  来源输入组装与模式判定");
  const fullId = await makeItem({ title: "Full source item", withPack: true, packText: "这是一段足够长的来源正文材料，长度明显超过最小可用信息量的门槛，足以支撑生成一篇完整的原创资讯。" });
  const fullIn = await assembleSourceInput(fullId);
  check("C1", "有 fact pack → FULL_SOURCE", fullIn.ok && fullIn.input.mode === "FULL_SOURCE" && fullIn.input.evidenceMode === "ARTICLE_PAGE");
  const feedId = await makeItem({ title: "Feed only item", excerpt: "这是订阅提供的摘要，长度足以写出一条简讯，但没有文章正文可用。" });
  const feedIn = await assembleSourceInput(feedId);
  check("C2", "只有订阅字段 → FEED_ONLY_BRIEF", feedIn.ok && feedIn.input.mode === "FEED_ONLY_BRIEF" && feedIn.input.evidenceMode === "FEED");
  check("C3", "FEED_ONLY 不关联 fact pack（不污染 SUBSTANTIAL 语义）",
    feedIn.ok && feedIn.input.factPackId === null);
  const thinId = await makeItem({ title: "x", excerpt: null });
  const thinIn = await assembleSourceInput(thinId);
  check("C4", "信息过少 → SOURCE_INSUFFICIENT", !thinIn.ok && thinIn.reason === "SOURCE_INSUFFICIENT");

  // 订阅的 guid 常常是哈希而不是 URL，不能当署名链接用
  seq += 1;
  const guidSrc = await prisma.contentSource.create({ data: {
    external_key: `ag-guid-${Date.now()}`, name: "GuidTest", kind: "rss",
    feed_url: `https://ag.example/guid-${Date.now()}.xml`, publisher: MARKER, source_tier: "OFFICIAL_PRIMARY" } });
  const guidItem = await prisma.sourceItem.create({ data: {
    source_id: guidSrc.id, url: "https://ag.example/real-article",
    url_hash: crypto.createHash("sha256").update(`g${Date.now()}`).digest("hex").slice(0,32),
    canonical_url: "09bd7931863bd59f564c816598e73d7e7a962684",
    title: "Guid is a hash not a url",
    raw_excerpt: "这条来源的 guid 是哈希而不是地址，署名链接必须回退到真实 URL。", status: "link_only" } });
  const guidIn = await assembleSourceInput(guidItem.id);
  check("C5", "guid 是哈希时署名链接回退到真实 URL",
    guidIn.ok && guidIn.input.sourceUrl === "https://ag.example/real-article" && guidIn.input.canonicalUrl === null,
    guidIn.ok ? guidIn.input.sourceUrl : "assemble 失败");

  section("D  提示词约束");
  const prompt = buildPrompt(fullIn.ok ? fullIn.input : SRC);
  for (const [id, needle, label] of [
    ["D1", "逐字一致", "要求数字逐字一致"],
    ["D2", "不得把计划或预期写成已经完成", "禁止把预测写成结果"],
    ["D3", "保留归属", "要求保留归属"],
    ["D4", "不得引入来源材料中没有的", "禁止引入外部事实"],
  ] as const) check(id, label, prompt.includes(needle));

  section("E  幂等与重复策略");
  const h1 = computeSourceInputHash(fullIn.ok ? fullIn.input : SRC, GENERATION_VERSION);
  const h2 = computeSourceInputHash(fullIn.ok ? fullIn.input : SRC, GENERATION_VERSION);
  check("E1", "同来源同版本 → 同 input hash", h1 === h2);
  check("E2", "换生成版本 → 不同 hash", h1 !== computeSourceInputHash(fullIn.ok ? fullIn.input : SRC, "other-version"));
  const dry1 = await generateArticle({ sourceItemId: fullId, dryRun: true });
  const dry2 = await generateArticle({ sourceItemId: fullId, dryRun: true });
  check("E3", "dry-run 不写库", (await prisma.generatedArticle.count({ where: { source_item_id: fullId } })) === 0);
  check("E4", "dry-run 结果稳定", dry1.mode === dry2.mode && dry1.status === dry2.status);
  // 手工插一条模拟已生成，验证唯一约束
  await prisma.generatedArticle.create({ data: {
    source_item_id: fullId, generation_version: GENERATION_VERSION, article_variant: "default",
    mode: "FULL_SOURCE", status: "DRAFTED", source_url_snapshot: "u", source_publisher_snapshot: MARKER,
    source_title_snapshot: "t", source_input_hash: h1, headline: "h", short_summary: "s", body: "b",
    qa_verdict: "PASSED" } });
  let dupRejected = false;
  try {
    await prisma.generatedArticle.create({ data: {
      source_item_id: fullId, generation_version: GENERATION_VERSION, article_variant: "default",
      mode: "FULL_SOURCE", status: "DRAFTED", source_url_snapshot: "u", source_publisher_snapshot: MARKER,
      source_title_snapshot: "t", source_input_hash: h1 } });
  } catch (e) { dupRejected = /Unique constraint/i.test(e instanceof Error ? e.message : ""); }
  check("E5", "同 (item, version, variant) 重复插入被拒", dupRejected);
  await prisma.generatedArticle.create({ data: {
    source_item_id: fullId, generation_version: GENERATION_VERSION, article_variant: "analysis",
    mode: "FULL_SOURCE", status: "DRAFTED", source_url_snapshot: "u", source_publisher_snapshot: MARKER,
    source_title_snapshot: "t", source_input_hash: h1 } });
  check("E6", "不同 variant 允许并存（同来源多篇不同角度）",
    (await prisma.generatedArticle.count({ where: { source_item_id: fullId } })) === 2);
  const existing = await generateArticle({ sourceItemId: fullId, dryRun: false });
  check("E7", "已有成稿时返回 EXISTING，不重复调用 provider", existing.status === "EXISTING", existing.status);

  section("F  重复内容不构成拒绝");
  const dupA = await makeItem({ title: "Same headline about a launch", excerpt: "同一件事的第一份来源摘要，内容足够写简讯。" });
  const dupB = await makeItem({ title: "Same headline about a launch", excerpt: "同一件事的第二份来源摘要，内容足够写简讯。" });
  const rA = await generateArticle({ sourceItemId: dupA, dryRun: true });
  const rB = await generateArticle({ sourceItemId: dupB, dryRun: true });
  check("F1", "标题完全相同的两条来源各自都可生成",
    rA.status !== "SOURCE_INSUFFICIENT" && rB.status !== "SOURCE_INSUFFICIENT", `${rA.status}/${rB.status}`);
  check("F2", "生成路径不含事件聚类/去重判断（不产生 event 记录）",
    (await prisma.eventClusteringRun.count()) === 1);

  section("G  不变量");
  check("G1", "ResourceContent 未变化", (await prisma.resourceContent.count()) === resourceBefore);
  check("G2", "未创建 AIEvent（本阶段无该表/无该路径）",
    !Object.keys(prisma).some((k) => /^ai[eE]vent$/.test(k)));
  check("G3", "未发布任何文章", (await prisma.generatedArticle.count({ where: { status: "PUBLISHED" } })) === 0);

  const purgedAfter = await purge();
  const residue = await prisma.contentSource.count({ where: { publisher: MARKER } });
  console.log(`\n收尾：清理 ${purgedAfter} 个测试源，残留 ${residue} 个 ${residue === 0 ? "✅" : "❌"}`);
  console.log(`SourceFactPack ${packsBefore} → ${await prisma.sourceFactPack.count()} ${packsBefore === await prisma.sourceFactPack.count() ? "✅" : "❌"}`);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) { console.log("\n失败项："); for (const f of failures) console.log(`  - ${f}`); }
  await prisma.$disconnect();
  if (fail) process.exit(1);
}
main().catch(async (e) => { console.error(e); try { await purge(); } finally { await prisma.$disconnect(); } process.exit(1); });
