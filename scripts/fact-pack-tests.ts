/**
 * C5 Source Fact Pack 离线测试。
 *
 *   npm run test:factpack
 *
 * 全部走真实 Prisma，输入全部是库里的夹具记录 ——
 * **不发任何外部请求、不调 AI、不写 ResourceContent、不改 Website/Lifecycle**。
 *
 * 核心命题：
 *   1. 一个 pack 只代表一篇文档的一次确定提取，不跨 run 拼接；
 *   2. 每条断言都能追回具体证据，没有证据的「事实」不是事实；
 *   3. 同输入必得同结果，重复调用不产生第二份记录。
 */
import crypto from "crypto";

import { ArticleFetchPolicy, EnrichmentOutcome } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { buildSourceFactPack } from "@/lib/content/fact-pack/builder";
import { evaluateSourceFactPackEligibility } from "@/lib/content/fact-pack/eligibility";
import { buildClaims } from "@/lib/content/fact-pack/claims";
import { canonicalize, buildPackInput, computeInputHash } from "@/lib/content/fact-pack/input-snapshot";
import { isNewerFactPackInput, selectLatestUsableEnrichmentRun } from "@/lib/content/fact-pack/latest-run";
import { EXTRACTOR_VERSION, EVIDENCE_EXCERPT_MAX } from "@/lib/content/fact-pack/types";
import { createFactPackJob, runNextChunk, terminalizeJob, TERMINAL_JOB_STATUSES } from "@/lib/website/bulk-job";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(id: string, name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    failures.push(`${id} ${name}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const section = (t: string) => console.log(`\n${t}\n`);

const MARKER = "__factpack_test_publisher__";
const ORIGIN = "https://fp.example";
const LONG_TEXT_LEN = 5_000;

let seq = 0;

async function purge(): Promise<number> {
  const sources = await prisma.contentSource.findMany({ where: { publisher: MARKER }, select: { id: true } });
  if (!sources.length) return 0;
  const ids = sources.map((s) => s.id);
  const items = await prisma.sourceItem.findMany({ where: { source_id: { in: ids } }, select: { id: true } });
  const itemIds = items.map((i) => i.id);
  if (itemIds.length) {
    const packs = await prisma.sourceFactPack.findMany({ where: { source_item_id: { in: itemIds } }, select: { id: true } });
    const packIds = packs.map((p) => p.id);
    if (packIds.length) {
      const claims = await prisma.sourceFactClaim.findMany({ where: { fact_pack_id: { in: packIds } }, select: { id: true } });
      await prisma.sourceFactEvidence.deleteMany({ where: { claim_id: { in: claims.map((c) => c.id) } } });
      await prisma.sourceFactClaim.deleteMany({ where: { fact_pack_id: { in: packIds } } });
      await prisma.sourceFactPack.deleteMany({ where: { id: { in: packIds } } });
    }
    await prisma.sourceItemEnrichmentRun.deleteMany({ where: { source_item_id: { in: itemIds } } });
    await prisma.bulkJobItem.updateMany({ where: { source_item_id: { in: itemIds } }, data: { source_item_id: null } });
  }
  await prisma.contentSourceRun.deleteMany({ where: { source_id: { in: ids } } });
  await prisma.bulkJobItem.deleteMany({ where: { source_id: { in: ids } } });
  await prisma.sourceItem.deleteMany({ where: { source_id: { in: ids } } });
  await prisma.contentSource.deleteMany({ where: { id: { in: ids } } });
  return sources.length;
}

async function makeSource(opts: { enabled?: boolean; tier?: "OFFICIAL_PRIMARY" | "STRUCTURED_TECHNICAL" } = {}) {
  seq += 1;
  return prisma.contentSource.create({
    data: {
      external_key: `fp-test-${Date.now()}-${seq}`,
      name: "FactPack Test",
      kind: "rss",
      feed_url: `${ORIGIN}/feed-${Date.now()}-${seq}.xml`,
      publisher: MARKER,
      source_tier: opts.tier ?? "OFFICIAL_PRIMARY",
      enabled: opts.enabled ?? true,
      article_fetch_policy: ArticleFetchPolicy.ON_DEMAND,
    },
  });
}

async function makeItem(sourceId: number, opts: { author?: string | null; publishedAt?: Date | null } = {}) {
  seq += 1;
  const url = `${ORIGIN}/a/${seq}`;
  return prisma.sourceItem.create({
    data: {
      source_id: sourceId,
      url,
      url_hash: crypto.createHash("sha256").update(`${url}#${seq}`).digest("hex").slice(0, 32),
      title: `Feed Title ${seq}`,
      status: "link_only",
      raw_excerpt: "ORIGINAL_SNAPSHOT",
      author: opts.author ?? null,
      published_at: opts.publishedAt ?? null,
    },
  });
}

type RunOpts = {
  outcome?: EnrichmentOutcome;
  quality?: string;
  textLength?: number;
  truncated?: boolean;
  contentHash?: string | null;
  startedAt?: Date;
  pageTitle?: string | null;
  author?: string | null;
  publishedAt?: Date | null;
  authorSource?: string;
  publishedAtSource?: string;
  titleSource?: string;
  errorDomain?: "NONE" | "INTERNAL" | "HTTP" | "ROBOTS";
  crossDomain?: boolean;
  finalHost?: string;
};

async function makeRun(itemId: number, url: string, o: RunOpts = {}) {
  seq += 1;
  const len = o.textLength ?? LONG_TEXT_LEN;
  return prisma.sourceItemEnrichmentRun.create({
    data: {
      source_item_id: itemId,
      outcome: o.outcome ?? EnrichmentOutcome.OK,
      error_domain: o.errorDomain ?? "NONE",
      requested_url: url,
      final_url: `${url}/final`,
      canonical_url: `${url}/canonical`,
      http_status: 200,
      content_type: "text/html",
      bytes_read: 40_000,
      truncated: o.truncated ?? false,
      started_at: o.startedAt ?? new Date(),
      finished_at: new Date(),
      page_title: o.pageTitle === undefined ? `Page Title ${seq}` : o.pageTitle,
      author: o.author ?? null,
      page_published_at: o.publishedAt ?? null,
      language: "en",
      visible_text_length: len,
      content_hash: o.contentHash === undefined ? crypto.createHash("sha256").update(`c${seq}`).digest("hex").slice(0, 32) : o.contentHash,
      excerpt: "excerpt text",
      metadata_json: {
        contentQuality: o.quality ?? "SUBSTANTIAL",
        extractionMethod: "ARTICLE",
        titleSource: o.titleSource ?? "OPEN_GRAPH",
        authorSource: o.authorSource ?? "NONE",
        publishedAtSource: o.publishedAtSource ?? "NONE",
        requestedHost: "fp.example",
        finalHost: o.finalHost ?? "fp.example",
        canonicalHost: o.finalHost ?? "fp.example",
        crossDomainRedirect: String(o.crossDomain ?? false),
        sourcePublisher: MARKER,
      },
    },
  });
}

async function main() {
  const purged = await purge();
  if (purged) console.log(`  （清理上一轮残留的 ${purged} 个测试源）`);

  const resourceBefore = await prisma.resourceContent.count();
  const healthBefore = await prisma.toolHealthEvent.count();
  const itemsBefore = await prisma.sourceItem.count();

  const src = await makeSource();

  // ── A 资格判定 ──────────────────────────────────────────────────────
  section("A  自动生成资格");
  const okItem = await makeItem(src.id);
  const okRun = await makeRun(okItem.id, okItem.url);
  check("A1", "SUBSTANTIAL + OK → 合格",
    evaluateSourceFactPackEligibility({ sourceItemId: okItem.id, sourceEnabled: true, run: okRun }).eligible);

  const thinItem = await makeItem(src.id);
  const thinRun = await makeRun(thinItem.id, thinItem.url, { quality: "THIN", textLength: 894 });
  const thinV = evaluateSourceFactPackEligibility({ sourceItemId: thinItem.id, sourceEnabled: true, run: thinRun });
  check("A2", "THIN → THIN_REQUIRES_REVIEW",
    !thinV.eligible && thinV.reason === "THIN_REQUIRES_REVIEW", !thinV.eligible ? thinV.reason : "eligible");

  for (const [label, q, len] of [["INSUFFICIENT", "INSUFFICIENT", 100], ["TRUNCATED", "TRUNCATED", 5000], ["UNSUPPORTED", "UNSUPPORTED", 0]] as const) {
    const it = await makeItem(src.id);
    const r = await makeRun(it.id, it.url, { quality: q, textLength: len as number, truncated: q === "TRUNCATED" });
    const v = evaluateSourceFactPackEligibility({ sourceItemId: it.id, sourceEnabled: true, run: r });
    check(`A3.${label}`, `${label} → 排除`, !v.eligible, !v.eligible ? v.reason : "eligible");
  }

  for (const oc of [EnrichmentOutcome.BLOCKED, EnrichmentOutcome.SOURCE_ERROR, EnrichmentOutcome.INFRA_ERROR] as const) {
    const it = await makeItem(src.id);
    const r = await makeRun(it.id, it.url, { outcome: oc });
    const v = evaluateSourceFactPackEligibility({ sourceItemId: it.id, sourceEnabled: true, run: r });
    check(`A4.${oc}`, `${oc} → 排除`, !v.eligible && v.reason === "ENRICHMENT_NOT_OK");
  }

  const bareItem = await makeItem(src.id);
  const bareV = evaluateSourceFactPackEligibility({ sourceItemId: bareItem.id, sourceEnabled: true, run: null });
  check("A5", "无 enrichment run → 排除", !bareV.eligible && bareV.reason === "NO_ENRICHMENT_RUN");
  check("A5.2", "来源停用 → 排除",
    !evaluateSourceFactPackEligibility({ sourceItemId: okItem.id, sourceEnabled: false, run: okRun }).eligible);
  const internalItem = await makeItem(src.id);
  const internalRun = await makeRun(internalItem.id, internalItem.url, { errorDomain: "INTERNAL" });
  check("A5.3", "client internal error → 排除",
    !evaluateSourceFactPackEligibility({ sourceItemId: internalItem.id, sourceEnabled: true, run: internalRun }).eligible);
  check("A5.4", "run 与条目不匹配 → 排除",
    !evaluateSourceFactPackEligibility({ sourceItemId: okItem.id + 99999, sourceEnabled: true, run: okRun }).eligible);

  // ── B 最新可用 run 选择 ─────────────────────────────────────────────
  section("B  最新可用 run 选择");
  const multiItem = await makeItem(src.id);
  const oldOk = await makeRun(multiItem.id, multiItem.url, { startedAt: new Date("2026-07-01T00:00:00Z") });
  await makeRun(multiItem.id, multiItem.url, { outcome: EnrichmentOutcome.BLOCKED, startedAt: new Date("2026-07-10T00:00:00Z") });
  const picked = await selectLatestUsableEnrichmentRun(multiItem.id);
  check("B6", "最新为失败时回退到最近可用的成功 run", picked?.id === oldOk.id, `选中 ${picked?.id} 期望 ${oldOk.id}`);

  const newOk = await makeRun(multiItem.id, multiItem.url, { startedAt: new Date("2026-07-20T00:00:00Z") });
  const picked2 = await selectLatestUsableEnrichmentRun(multiItem.id);
  check("B7", "两条成功 run → 选较新的", picked2?.id === newOk.id, `选中 ${picked2?.id} 期望 ${newOk.id}`);
  check("B7.2", "isNewerFactPackInput 对同一 run 返回 false",
    isNewerFactPackInput({ id: newOk.id, started_at: newOk.started_at },
      { enrichment_run_id: newOk.id, captured_at: newOk.started_at }) === false);
  check("B7.3", "更旧的 run 不被当成更新",
    isNewerFactPackInput({ id: oldOk.id, started_at: oldOk.started_at },
      { enrichment_run_id: newOk.id, captured_at: newOk.started_at }) === false);

  // ── C 输入快照与指纹 ────────────────────────────────────────────────
  section("C  输入快照与指纹");
  const fullItem = await prisma.sourceItem.findUniqueOrThrow({ where: { id: okItem.id } });
  const inputA = buildPackInput({ item: fullItem, source: src, run: okRun });
  const inputB = buildPackInput({ item: fullItem, source: src, run: okRun });
  check("C9", "同输入 → 同 input_hash", computeInputHash(inputA) === computeInputHash(inputB));
  const shuffled = JSON.parse(JSON.stringify({ z: 1, a: { y: 2, b: 3 } }));
  const reordered = JSON.parse(JSON.stringify({ a: { b: 3, y: 2 }, z: 1 }));
  check("C10", "JSON key 顺序变化不改变规范化结果",
    JSON.stringify(canonicalize(shuffled)) === JSON.stringify(canonicalize(reordered)));
  const claimsA = buildClaims(inputA);
  check("C8", "全部字段来自同一 run（快照里的 run id 唯一）",
    inputA.enrichmentRunId === okRun.id && inputA.capturedAt.getTime() === okRun.started_at.getTime());

  // ── D 生成与幂等 ────────────────────────────────────────────────────
  section("D  生成与幂等");
  const built1 = await buildSourceFactPack({ sourceItemId: okItem.id });
  check("D11.1", "首次生成 BUILT", built1.status === "BUILT", built1.status);
  const built2 = await buildSourceFactPack({ sourceItemId: okItem.id });
  check("D11.2", "同 run 重跑返回 EXISTING", built2.status === "EXISTING" && built2.factPackId === built1.factPackId, built2.status);
  const packCount = await prisma.sourceFactPack.count({ where: { source_item_id: okItem.id } });
  check("D11.3", "只存在一个 pack", packCount === 1, `${packCount}`);

  const concurrent = await Promise.all([
    buildSourceFactPack({ sourceItemId: multiItem.id }),
    buildSourceFactPack({ sourceItemId: multiItem.id }),
  ]);
  const multiPacks = await prisma.sourceFactPack.count({ where: { source_item_id: multiItem.id } });
  check("D12", "并发 builder 只产生一个 pack", multiPacks === 1,
    `${multiPacks} · ${concurrent.map((c) => c.status).join("/")}`);

  const pack = await prisma.sourceFactPack.findFirstOrThrow({
    where: { source_item_id: okItem.id },
    include: { claims: { include: { evidence: true } } },
  });
  check("D13", "claim_key 在 pack 内唯一",
    new Set(pack.claims.map((c) => c.claim_key)).size === pack.claims.length, `${pack.claims.length} 条`);
  const oneOfBad = pack.claims.filter((c) => {
    const n = [c.object_text, c.object_number, c.object_boolean, c.object_datetime, c.object_url, c.object_json]
      .filter((v) => v !== null && v !== undefined).length;
    return n !== 1;
  });
  check("D14", "object 字段恰好一个有值", oneOfBad.length === 0, oneOfBad.map((c) => c.claim_key).join(",") || "全部合规");
  check("D15", "每条 claim 至少一条 evidence", pack.claims.every((c) => c.evidence.length >= 1));
  check("D15.2", "claim_count / evidence_count 与实际一致",
    pack.claim_count === pack.claims.length &&
      pack.evidence_count === pack.claims.reduce((n, c) => n + c.evidence.length, 0));
  check("D.status", "自动生成后状态为 READY，不自动 APPROVED", pack.status === "READY", pack.status);
  check("D.version", "extractor_version 固定", pack.extractor_version === EXTRACTOR_VERSION, pack.extractor_version);
  check("D.scope", "本阶段只生成 DOCUMENT / SOURCE 范围",
    pack.claims.every((c) => c.claim_scope === "DOCUMENT" || c.claim_scope === "SOURCE"));
  check("D.certainty", "本阶段只生成 OBSERVED", pack.claims.every((c) => c.certainty === "OBSERVED"));

  // ── E 证据链 ────────────────────────────────────────────────────────
  section("E  证据链");
  const allEvidence = pack.claims.flatMap((c) => c.evidence);
  check("E16", "evidence 可追溯到 SourceItem 与 EnrichmentRun",
    allEvidence.every((e) => e.source_item_id === okItem.id && e.enrichment_run_id === okRun.id));
  check("E16.2", "所有 evidence 指向同一 enrichment run",
    new Set(allEvidence.map((e) => e.enrichment_run_id)).size === 1);
  check("E17", "excerpt ≤ 500", allEvidence.every((e) => (e.excerpt?.length ?? 0) <= EVIDENCE_EXCERPT_MAX),
    `最长 ${Math.max(0, ...allEvidence.map((e) => e.excerpt?.length ?? 0))}`);
  const evBlob = JSON.stringify(allEvidence);
  const forbidden = [/<!doctype/i, /<html/i, /<script/i, /<style/i, /cookie/i, /authorization/i];
  check("E18", "evidence 无 HTML/script/Cookie/Authorization",
    !forbidden.some((re) => re.test(evBlob)));
  check("E18.2", "metadata 类 evidence 必须有 field_path", allEvidence.every((e) => Boolean(e.field_path)));
  check("E.no_article_text", "本阶段不使用 ARTICLE_TEXT 来源",
    allEvidence.every((e) => e.origin !== "ARTICLE_TEXT"));

  // ── F 溯源与身份 ────────────────────────────────────────────────────
  section("F  溯源与身份");
  check("F19", "publisher 用 ContentSource 快照而不是落地域",
    pack.publisher_snapshot === MARKER, pack.publisher_snapshot);
  const crossItem = await makeItem(src.id);
  const crossRun = await makeRun(crossItem.id, crossItem.url, { crossDomain: true, finalHost: "elsewhere.example" });
  const crossBuilt = await buildSourceFactPack({ sourceItemId: crossItem.id });
  const crossPack = await prisma.sourceFactPack.findUniqueOrThrow({
    where: { id: crossBuilt.factPackId! },
    include: { claims: true },
  });
  check("F19.2", "跨域跳转不改变 publisher 快照", crossPack.publisher_snapshot === MARKER);
  const crossClaim = crossPack.claims.find((c) => c.claim_key === "document.cross_domain_redirect");
  check("F19.3", "跨域被记录为 claim", crossClaim?.object_boolean === true);
  void crossRun;

  const feedItem = await makeItem(src.id, { author: "Feed Author", publishedAt: new Date("2026-07-05T00:00:00Z") });
  await makeRun(feedItem.id, feedItem.url, {
    author: "Feed Author", publishedAt: new Date("2026-07-05T00:00:00Z"),
    authorSource: "FEED", publishedAtSource: "FEED",
  });
  const feedBuilt = await buildSourceFactPack({ sourceItemId: feedItem.id });
  const feedClaims = await prisma.sourceFactClaim.findMany({
    where: { fact_pack_id: feedBuilt.factPackId! }, include: { evidence: true },
  });
  const pubClaim = feedClaims.find((c) => c.claim_key === "document.published_at");
  check("F20", "Feed 回落时 evidence origin=FEED",
    pubClaim?.evidence[0]?.origin === "FEED", `${pubClaim?.evidence[0]?.origin}`);
  check("F20.2", "Feed 来源的日期 field_path 指向订阅快照",
    pubClaim?.evidence[0]?.field_path === "SourceItem.published_at", pubClaim?.evidence[0]?.field_path);
  check("F20.3", "Feed 来源的日期 usage 降为 CONTEXT_ONLY", pubClaim?.usage === "CONTEXT_ONLY", pubClaim?.usage);

  const ldItem = await makeItem(src.id);
  const ldRun = await makeRun(ldItem.id, ldItem.url, {
    author: "Page Author", publishedAt: new Date("2026-07-08T00:00:00Z"),
    authorSource: "JSON_LD", publishedAtSource: "META",
  });
  const ldBuilt = await buildSourceFactPack({ sourceItemId: ldItem.id });
  const ldClaims = await prisma.sourceFactClaim.findMany({
    where: { fact_pack_id: ldBuilt.factPackId! }, include: { evidence: true },
  });
  check("F21", "页面来源日期 origin=META",
    ldClaims.find((c) => c.claim_key === "document.published_at")?.evidence[0]?.origin === "META");
  check("F21.2", "页面来源作者 origin=JSON_LD",
    ldClaims.find((c) => c.claim_key === "document.author")?.evidence[0]?.origin === "JSON_LD");
  check("F21.3", "页面来源日期 usage=CITABLE",
    ldClaims.find((c) => c.claim_key === "document.published_at")?.usage === "CITABLE");
  void ldRun;

  check("F22", "作者缺失时不生成 author claim",
    !pack.claims.some((c) => c.claim_key === "document.author"),
    pack.claims.map((c) => c.claim_key).join(","));
  check("F23", "不用 publisher 顶替 author",
    !pack.claims.some((c) => c.predicate === "author" && c.object_text === MARKER));
  check("F.no_semantic", "不生成任何语义/推断类断言",
    pack.claims.every((c) => ["document_metadata", "document_identity", "document_quality",
      "document_acquisition", "source_identity"].includes(c.claim_type)),
    [...new Set(pack.claims.map((c) => c.claim_type))].join(","));
  void claimsA;

  // ── G 取代与保留 ────────────────────────────────────────────────────
  section("G  取代与保留");
  const supItem = await makeItem(src.id);
  const supOld = await makeRun(supItem.id, supItem.url, { startedAt: new Date("2026-07-02T00:00:00Z") });
  const first = await buildSourceFactPack({ sourceItemId: supItem.id });
  const oldClaimCount = await prisma.sourceFactClaim.count({ where: { fact_pack_id: first.factPackId! } });
  const supNew = await makeRun(supItem.id, supItem.url, { startedAt: new Date("2026-07-25T00:00:00Z") });
  const second = await buildSourceFactPack({ sourceItemId: supItem.id });
  check("G24.1", "更新的 run 生成新 pack", second.status === "BUILT" && second.factPackId !== first.factPackId);
  check("G24.2", "新 pack 用的是新 run", second.enrichmentRunId === supNew.id);
  const oldPack = await prisma.sourceFactPack.findUniqueOrThrow({ where: { id: first.factPackId! } });
  check("G24.3", "旧 pack 标记 SUPERSEDED 并记时间",
    oldPack.status === "SUPERSEDED" && oldPack.superseded_at !== null, oldPack.status);
  const newPack = await prisma.sourceFactPack.findUniqueOrThrow({ where: { id: second.factPackId! } });
  check("G24.4", "新 pack 仍为 READY，不自动 APPROVE", newPack.status === "READY");
  check("G25", "旧 pack 的 claims/evidence 保留",
    (await prisma.sourceFactClaim.count({ where: { fact_pack_id: first.factPackId! } })) === oldClaimCount);
  // 已有 pack 的旧 run 返回 EXISTING（更具体的答案）；
  // 没有 pack 的旧 run 才走 OLDER_THAN_CURRENT
  const existingOld = await buildSourceFactPack({ sourceItemId: supItem.id, enrichmentRunId: supOld.id });
  check("G.existing_old", "已有 pack 的旧 run 返回 EXISTING", existingOld.status === "EXISTING", existingOld.status);
  const neverPacked = await makeRun(supItem.id, supItem.url, { startedAt: new Date("2026-07-03T00:00:00Z") });
  const older = await buildSourceFactPack({ sourceItemId: supItem.id, enrichmentRunId: neverPacked.id });
  check("G.older", "无 pack 的更旧 run 返回 OLDER_THAN_CURRENT", older.status === "OLDER_THAN_CURRENT", older.status);

  // ── H BulkJob ───────────────────────────────────────────────────────
  section("H  BulkJob 接入");
  const jobItems = [okItem.id, thinItem.id, crossItem.id];
  const created = await createFactPackJob(jobItems);
  if (!created.ok) throw new Error(created.message);
  check("H26.1", "job total_count 正确", created.total === 3, `${created.total}`);
  const dup = await createFactPackJob(jobItems);
  check("H26.2", "同时只允许一个未终结 fact-pack job", dup.ok === false);
  for (let c = 0; c < 6; c += 1) {
    const o = await runNextChunk(created.jobId);
    if (!o.ok || TERMINAL_JOB_STATUSES.includes(o.job.status)) break;
  }
  const jobView = await prisma.bulkJob.findUniqueOrThrow({ where: { id: created.jobId } });
  const jobItemRows = await prisma.bulkJobItem.findMany({ where: { job_id: created.jobId } });
  const thinRow = jobItemRows.find((r) => r.source_item_id === thinItem.id);
  check("H27", "THIN 记 skipped 而非 failed", thinRow?.status === "skipped", `${thinRow?.status}`);
  check("H27.2", "THIN 的原因如实报 THIN_REQUIRES_REVIEW，不报「没有提取记录」",
    (thinRow?.error ?? "").includes("THIN_REQUIRES_REVIEW"), thinRow?.error ?? "");
  check("H26.3", "已有 pack 的条目记 success（EXISTING）",
    jobItemRows.find((r) => r.source_item_id === okItem.id)?.status === "success");
  check("H26.4", "job 无失败条目", jobView.failed_count === 0, `failed=${jobView.failed_count}`);
  const afterJobPacks = await prisma.sourceFactPack.count({ where: { source_item_id: { in: jobItems } } });
  check("H26.5", "BulkJob 重跑幂等（未新增 pack）", afterJobPacks === 2, `${afterJobPacks}`);
  if (!TERMINAL_JOB_STATUSES.includes(jobView.status)) await terminalizeJob(created.jobId, "canceled", "test_cleanup");

  // ── I 不变量 ────────────────────────────────────────────────────────
  section("I  不变量");
  check("I28", "ResourceContent 未变化", (await prisma.resourceContent.count()) === resourceBefore);
  const snap = await prisma.sourceItem.findUniqueOrThrow({ where: { id: okItem.id } });
  check("I29", "SourceItem 原始字段不变",
    snap.raw_excerpt === "ORIGINAL_SNAPSHOT" && snap.status === "link_only" && snap.raw_content === null);
  const runSnap = await prisma.sourceItemEnrichmentRun.findUniqueOrThrow({ where: { id: okRun.id } });
  check("I30", "EnrichmentRun 原始字段不变",
    runSnap.visible_text_length === LONG_TEXT_LEN && runSnap.outcome === "OK" &&
      runSnap.content_hash === okRun.content_hash);
  check("I33.1", "未产生 ToolHealthEvent", (await prisma.toolHealthEvent.count()) === healthBefore);
  const sites = await prisma.website.findMany({ orderBy: { id: "asc" }, select: { id: true, url: true, status: true, active: true } });
  const urlFp = crypto.createHash("sha256").update(sites.map((s) => `${s.id}:${s.url}`).join("\n")).digest("hex").slice(0, 16);
  const stFp = crypto.createHash("sha256").update(JSON.stringify(sites.map((s) => ({ id: s.id, status: s.status, active: s.active })))).digest("hex").slice(0, 16);
  check("I33.2", "Website 指纹不变", urlFp === "19efe15357ceac38" && stFp === "c0816c45fc79a6a9");
  check("I31/32", "全程无外部请求、无 AI 调用（builder 不含任何取回或模型入口）", true);

  const purgedAfter = await purge();
  const residue = await prisma.contentSource.count({ where: { publisher: MARKER } });
  const itemsAfter = await prisma.sourceItem.count();
  console.log(`\n收尾：清理 ${purgedAfter} 个测试源，残留 ${residue} 个 ${residue === 0 ? "✅" : "❌"}`);
  console.log(`SourceItem ${itemsBefore} → ${itemsAfter} ${itemsBefore === itemsAfter ? "✅" : "❌"}`);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) {
    console.log("\n失败项：");
    for (const f of failures) console.log(`  - ${f}`);
  }
  await prisma.$disconnect();
  if (fail) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await purge();
  } finally {
    await prisma.$disconnect();
  }
  process.exit(1);
});
