/**
 * AI HOT 定时运营的每日 canary 指标与硬停止条件。
 *
 *   npm run aihot:ops                 # 记录当天指标并核对硬停止条件
 *   npm run aihot:ops -- --no-record  # 只核对，不写入指标历史
 *   npm run aihot:ops -- --days       # 打印已记录的历史
 *
 * 只读库并核对：不发外部请求、不调 provider、不写内容、不发布。
 *
 * 受保护状态一律**与动态基线比对**，不写死绝对数量 ——
 * 写死的门槛会在下一次正常增长时假报失败，然后所有人开始忽略它。
 */
import type { AihotTaskType, DraftLanguage, MultilingualContentForm } from "@prisma/client";

import { residualLeases } from "@/lib/content/aihot/lease";
import { ALL_TASKS, TASK_SCHEDULE } from "@/lib/content/aihot/scheduler";
import { httpUrlOrNull } from "@/lib/content/aihot/types";
import { HOT_TOPIC_FORBIDDEN_CODES, NEVER_BLOCKING_CODES } from "@/lib/content/multilingual/types";
import { loadAllLatestMaterial } from "@/lib/content/publishing/eligibility";
import { diffProtectedState, loadProtectedBaseline, readProtectedState } from "@/lib/content/publishing/protected-baseline";
import { LOCALES, publicPath } from "@/lib/content/publishing/types";
import { prisma } from "@/lib/prisma";

const publicPathOf = (
  f: { content_form: MultilingualContentForm; slug: string; report_date: string | null },
  locale: DraftLanguage
) => publicPath({ locale, contentForm: f.content_form, slug: f.slug, reportDate: f.report_date });

const METRICS_KEY = "aihot:ops-canary-metrics";
const RECORD = !process.argv.includes("--no-record");
const SHOW_DAYS = process.argv.includes("--days");

let pass = 0, fail = 0;
const failures: string[] = [];
function gate(name: string, ok: boolean, detail = "") {
  if (ok) pass++; else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); }
  console.log(`  ${ok ? "✅" : "❌"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** 当天窗口：canary 是「每日记录」，指标口径就该是当天 */
function dayWindow(): { from: Date; to: Date; date: string } {
  const now = new Date();
  const from = new Date(now); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setDate(to.getDate() + 1);
  return { from, to, date: from.toISOString().slice(0, 10) };
}

async function showDays() {
  const row = await prisma.setting.findUnique({ where: { key: METRICS_KEY } });
  const history = row ? (JSON.parse(row.value) as Record<string, unknown>[]) : [];
  console.log(`已记录 ${history.length} 天（目标 7 天）\n`);
  for (const h of history) {
    console.log(`  ${h.date}  runs=${h.taskRuns} provider=${h.providerCalls} 新版本=${h.revisionsCreated} ` +
      `自动发布=${h.autoPublications} 429=${h.rateLimited} 5xx=${h.serverErrors} 租约冲突=${h.leaseConflicts}`);
  }
}

async function main() {
  if (SHOW_DAYS) { await showDays(); return; }

  const { from, to, date } = dayWindow();

  // ── 定时任务运行 ──
  const runs = await prisma.aihotTaskRun.findMany({
    where: { started_at: { gte: from, lt: to } },
  });
  const byTask = Object.fromEntries(ALL_TASKS.map((t) => [t, runs.filter((r) => r.task_type === t)])) as
    Record<AihotTaskType, typeof runs>;

  const sum = (rs: typeof runs, k: keyof (typeof runs)[number]) =>
    rs.reduce((n, r) => n + (Number(r[k]) || 0), 0);

  // ── 内容侧 ──
  const material = await loadAllLatestMaterial();
  const signalBriefs = material.filter((m) => m.mode === "SIGNAL").length;
  const enrichedBriefs = material.length - signalBriefs;

  const snapshots = await prisma.aihotHotTopicSnapshot.count();
  const topics = new Set((await prisma.aihotHotTopicSnapshot.findMany({ select: { topic_id: true } })).map((s) => s.topic_id)).size;
  const selectedItems = await prisma.aihotSelectedItem.count();
  const dailies = await prisma.aihotDailyReport.count();

  const drafts = await prisma.multilingualDraft.findMany({
    select: { language: true, status: true, qa_issues_json: true },
  });
  const codesOf = (raw: unknown) =>
    (Array.isArray(raw) ? (raw as { code?: string }[]) : []).map((i) => i.code ?? "");
  const issueCodes = drafts.flatMap((d) => codesOf(d.qa_issues_json));

  /*
   * 漂移分两种，硬停止只针对后一种：
   *
   *   - **被拦下的**（草稿 QA_FAILED）：确定性 QA 正常工作的证据。
   *     把它算成硬停止，等于安全网每接住一次就报一次警 ——
   *     那样的门槛只会训练所有人无视它。
   *   - **漏过去的**（草稿标成 DRAFTED 却带着漂移问题码，
   *     或已发布的那一版 revision 上记着漂移）：这才是真的出事了。
   */
  const escapedCodes = drafts
    .filter((d) => d.status === "DRAFTED")
    .flatMap((d) => codesOf(d.qa_issues_json));
  const blockedCount = issueCodes.length - escapedCodes.length;
  const tally = new Map<string, number>();
  for (const c of escapedCodes) tally.set(c, (tally.get(c) ?? 0) + 1);
  const blockedTally = new Map<string, number>();
  for (const c of issueCodes) blockedTally.set(c, (blockedTally.get(c) ?? 0) + 1);

  const families = await prisma.articleFamily.findMany({
    include: { translations: { include: { revisions: true, reviews: true, publications: true } } },
  });
  const revisions = families.reduce((n, f) => n + f.translations.reduce((m, t) => m + t.revisions.length, 0), 0);
  const reviews = families.reduce((n, f) => n + f.translations.reduce((m, t) => m + t.reviews.length, 0), 0);
  const publications = await prisma.articlePublication.count({ where: { status: "PUBLISHED" } });

  // 逐语言失败率：QA 未过 / 该语言草稿总数
  const perLocaleFailure = Object.fromEntries(LOCALES.map((l) => {
    const ds = drafts.filter((d) => d.language === l);
    const bad = ds.filter((d) => d.status !== "DRAFTED").length;
    return [l, ds.length ? Number((bad / ds.length).toFixed(3)) : 0];
  }));

  const leases = await residualLeases();

  const metrics = {
    date,
    // 抓取
    taskRuns: runs.length,
    selectedRuns: byTask.SELECTED.length,
    hotTopicRuns: byTask.HOT_TOPICS.length,
    dailyRuns: byTask.DAILY.length,
    fetched: sum(runs, "fetched"),
    ingestCreated: sum(runs, "created"),
    ingestUpdated: sum(runs, "updated"),
    ingestReused: sum(runs, "reused"),
    notModified: sum(runs, "not_modified"),
    rateLimited: sum(runs, "rate_limited"),
    serverErrors: sum(runs, "server_error"),
    taskFailures: runs.filter((r) => r.status === "FAILED").length,
    leaseConflicts: runs.filter((r) => r.lease_conflict).length,
    residualLeases: leases.length,
    maxDurationMs: runs.reduce((n, r) => Math.max(n, r.duration_ms ?? 0), 0),
    // 内容
    selectedItems, hotTopicSnapshots: snapshots, hotTopics: topics, dailies,
    signalBriefs, enrichedBriefs,
    multilingualDrafts: drafts.length,
    providerCalls: sum(runs, "provider_calls"),
    unitsGenerated: sum(runs, "units_generated"),
    idempotentReuse: sum(runs, "units_reused"),
    families: families.length,
    revisions,
    revisionsCreated: sum(runs, "revisions_created"),
    qaPassed: drafts.filter((d) => d.status === "DRAFTED").length,
    qaFailed: drafts.filter((d) => d.status === "QA_FAILED").length,
    // 审核与发布
    reviews,
    humanReviews: await prisma.translationReview.count({ where: { reviewer_type: "HUMAN" } }),
    agentReviews: await prisma.translationReview.count({ where: { reviewer_type: "AGENT" } }),
    manualPublications: publications,
    // 自动审核
    autoReviewed: sum(runs, "auto_reviewed"),
    autoApproved: sum(runs, "auto_approved"),
    autoBlocked: sum(runs, "auto_blocked"),
    llmVetoed: sum(runs, "llm_vetoed"),
    autoPublications: sum(runs, "publications_created"),
    autoPublicationsIntended: sum(runs, "publications_intended"),
    perLocaleFailure,
  };

  console.log(`AI HOT 定时运营 canary · ${date}\n`);
  console.log("一、指标");
  for (const [k, v] of Object.entries(metrics)) {
    console.log(`  ${k.padEnd(22)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
  }
  if (blockedTally.size) {
    console.log(`  QA 问题分布（含已拦下的 ${blockedCount} 项）：${[...blockedTally].map(([c, n]) => `${c}=${n}`).join(" · ")}`);
  }
  if (tally.size) console.log(`  ⚠ 漏过 QA 的问题：${[...tally].map(([c, n]) => `${c}=${n}`).join(" · ")}`);
  console.log("  调度：" + ALL_TASKS.map((t) => `${t}=${TASK_SCHEDULE[t].cron}`).join(" · "));

  console.log("\n二、硬停止条件");

  /*
   * 「定时任务一律不得发布」这条硬停止已经作废 —— 产品决定改成
   * 「自动审核通过即发布」。但它没有被删掉，只是换了口径：
   *
   *   发布记录的增量 **必须等于** 本轮有意发布的条数。
   *
   * 多出来的那些不是「自动发布」，是**绕过审核**的发布 —— 那才是真正
   * 要停机的事。把这条整个删掉，等于以后再也没人看着这条边界。
   */
  /*
   * **逐轮对账，不按天求和。**
   *
   * 求和会把「某一轮多发了 4 条」和「另一轮少发了 4 条」抵消掉，
   * 而这两件事都得有人看。逐轮比对还能直接指出是哪一轮出的问题。
   *
   * 跳过带着已废弃错误码的行：那些是改契约之前写下的运行记录，
   * 当时根本没有 publications_intended 这个概念（列默认 0）。
   * 拿新规矩去判旧记录，只会得到一条永远红、也永远修不好的告警 ——
   * 而一条修不好的告警，用不了几天就没人看了。
   */
  const RETIRED_CODE = "AUTO_PUBLICATION_DETECTED";
  const legacyRuns = runs.filter((r) => r.error_code === RETIRED_CODE);
  const mismatched = runs
    .filter((r) => r.error_code !== RETIRED_CODE)
    .filter((r) => r.publications_created !== r.publications_intended);
  gate("每一轮的发布数都等于有意发布数", mismatched.length === 0,
    mismatched.slice(0, 3).map((r) => `#${r.id} ${r.task_type} 发布${r.publications_created}/有意${r.publications_intended}`).join("；")
      || `${runs.length - legacyRuns.length} 轮全部对账一致`);
  if (legacyRuns.length) {
    console.log(`  ℹ 跳过 ${legacyRuns.length} 轮改契约之前的旧记录（错误码 ${RETIRED_CODE} 已废弃）`);
  }
  const strayRuns = runs.filter((r) => r.error_code === "UNEXPECTED_PUBLICATION");
  gate("无 UNEXPECTED_PUBLICATION 运行", strayRuns.length === 0, `${strayRuns.length} 轮`);

  /*
   * 发布出去的必须真的被审过。
   *
   * 自动审核之后这条比以前更要紧：以前发布要人点按钮，天然有人经手；
   * 现在没有任何人参与，「有没有审核记录」是唯一还能事后验证的东西。
   */
  const publishedNoReview = families.flatMap((f) => f.translations)
    .filter((t) => t.publications.some((p) => p.status === "PUBLISHED") && t.reviews.length === 0);
  gate("已发布内容均有审核记录", publishedNoReview.length === 0, `${publishedNoReview.length} 条缺审核`);

  /*
   * 闸门必须真的在拦东西。
   *
   * 这不是硬停止 —— 某一天确实可能一条都不用拦。但**长期**为 0
   * 和闸门坏掉在指标上长得一模一样，所以要打出来让人看见。
   */
  if (metrics.autoReviewed > 0 && metrics.autoBlocked === 0) {
    console.log(`  ⚠ 今日自动审核 ${metrics.autoReviewed} 次、拦下 0 次 —— 留意闸门是否失效`);
  }

  /*
   * 「相同输入重复调用 provider」的可测形式：
   * 幂等复用发生时 provider 调用必须为 0。审计里逐单元记了 providerCalls，
   * 状态为 EXISTING 却有调用，就是幂等破了。
   */
  const badReuse = runs.flatMap((r) => {
    const details = Array.isArray(r.detail_json) ? (r.detail_json as { generateStatus?: string; providerCalls?: number; unitKey?: string }[]) : [];
    return details.filter((d) => d.generateStatus === "EXISTING" && (d.providerCalls ?? 0) > 0);
  });
  gate("相同输入重复调用 provider = 0", badReuse.length === 0,
    badReuse.slice(0, 3).map((d) => d.unitKey ?? "?").join(", ") || `幂等复用 ${metrics.idempotentReuse} 次，全部零调用`);

  // 相同 revision 重复创建：同一 translation 下不允许内容与 input hash 完全一致的两版
  const dupRevisions = await prisma.$queryRawUnsafe<{ translation_id: number; n: bigint }[]>(
    `SELECT translation_id, COUNT(*) AS n FROM article_revisions
      GROUP BY translation_id, headline, summary, body, source_input_hash HAVING COUNT(*) > 1`);
  gate("相同 revision 重复创建 = 0", dupRevisions.length === 0, `${dupRevisions.length} 组重复`);

  const badAttr = families.filter((f) => !httpUrlOrNull(f.attribution_url));
  gate("无效 attribution URL = 0", badAttr.length === 0, badAttr.map((f) => f.unit_key).slice(0, 3).join(", "));

  gate("数字漂移 = 0", !tally.get("NUMBER_MISMATCH"), String(tally.get("NUMBER_MISMATCH") ?? 0));
  gate("日期漂移 = 0", !tally.get("DATE_MISMATCH"), String(tally.get("DATE_MISMATCH") ?? 0));
  gate("模型/版本漂移 = 0", !tally.get("MODEL_MISMATCH"), String(tally.get("MODEL_MISMATCH") ?? 0));
  gate("来源数量漂移 = 0", !tally.get("HOT_TOPIC_SOURCE_COUNT_MISMATCH"),
    String(tally.get("HOT_TOPIC_SOURCE_COUNT_MISMATCH") ?? 0));
  gate("热点输入之外新增事实 = 0",
    !tally.get("HOT_TOPIC_UNSUPPORTED_DETAIL") && !tally.get("UNSUPPORTED_DETAIL") && !tally.get("ENTITY_MISMATCH"),
    `hot=${tally.get("HOT_TOPIC_UNSUPPORTED_DETAIL") ?? 0} unsupported=${tally.get("UNSUPPORTED_DETAIL") ?? 0} entity=${tally.get("ENTITY_MISMATCH") ?? 0}`);
  gate("翻译事实漂移 = 0", !tally.get("TRANSLATION_FACT_DRIFT"), String(tally.get("TRANSLATION_FACT_DRIFT") ?? 0));
  gate("未出现已取消的门禁类结论",
    !issueCodes.some((c) => (HOT_TOPIC_FORBIDDEN_CODES as readonly string[]).includes(c)
      || (NEVER_BLOCKING_CODES as readonly string[]).includes(c)));

  // 日报栏目缺失或顺序改变
  const dailyFamilies = families.filter((f) => f.content_form === "DAILY_BRIEF");
  const dailySectionIssues = (tally.get("DAILY_SECTION_MISMATCH") ?? 0) + (tally.get("SECTION_COUNT_MISMATCH") ?? 0);
  gate("日报栏目缺失/顺序改变 = 0", dailySectionIssues === 0, `${dailySectionIssues}（日报家族 ${dailyFamilies.length}）`);

  /*
   * 草稿泄露到公开页：每条已发布记录都必须落在**当时被批准过**的那一版上。
   *
   * 判据是审核记录里的 approved_revision_id，不是译本上的那个同名字段 ——
   * 后者是可变指针：内容更新出新 revision 时会被**故意**清掉，
   * 好让上一版的批准不替新版背书。拿它当判据，
   * 每次正常的内容更新都会被误报成「草稿泄露」，而真的泄露反而淹没在噪声里。
   */
  const approvedRevisionIds = new Set(
    (await prisma.translationReview.findMany({
      where: { decision: "APPROVED", approved_revision_id: { not: null } },
      select: { approved_revision_id: true },
    })).map((r) => r.approved_revision_id!)
  );
  const publishedRows = await prisma.articlePublication.findMany({
    where: { status: "PUBLISHED" }, select: { revision_id: true, locale: true, path: true },
  });
  const leaked = publishedRows.filter((p) => !approvedRevisionIds.has(p.revision_id));
  gate("草稿泄露到公开页 = 0", leaked.length === 0,
    leaked.slice(0, 3).map((p) => `${p.locale}${p.path}`).join(", ") || `${publishedRows.length} 条发布记录均有对应批准记录`);

  // 已发布之后又出了新版本，是**预期**行为：新版本进队列，页面保持旧版
  const pendingUpdates = families.flatMap((f) => f.translations.filter((t) =>
    t.publications.some((p) => p.status === "PUBLISHED")
    && t.current_revision_id !== null && t.published_revision_id !== null
    && t.current_revision_id !== t.published_revision_id));
  console.log(`  ℹ  已发布内容有新版本待审：${pendingUpdates.length} 条（页面仍为已批准的旧版，非泄露）`);

  /*
   * 未发布单元的公开地址**必须取不到正文**。
   *
   * 查询层不返回未发布内容，页面因此渲染「Not found」并带 noindex ——
   * 这一条是核对那道保证还在，不是核对状态码：
   * 流式 SSR 会在 notFound() 抛出之前就把响应头发出去，
   * 所以这些地址目前返回 200 而不是 404（全站既有行为，
   * 与 /tools/<不存在> 一致）。正文没泄露，但爬虫看到的是「正常页面」。
   */
  const unpublishedFamilies = families.filter((f) =>
    f.translations.length > 0 && f.translations.every((t) => !t.publications.some((p) => p.status === "PUBLISHED")));
  const publishedPaths = new Set(publishedRows.map((p) => `${p.locale}${p.path}`));
  const exposedByPublication = unpublishedFamilies.filter((f) =>
    f.translations.some((t) => publishedPaths.has(`${t.locale}${publicPathOf(f, t.locale)}`)));
  gate("未发布单元没有对应的发布记录", exposedByPublication.length === 0,
    exposedByPublication.map((f) => f.unit_key).slice(0, 3).join(", ")
      || `未发布家族 ${unpublishedFamilies.length} 个，公开地址均无发布记录（正文取不到）`);
  console.log("  ℹ  未发布地址返回的是 noindex 的 Not found 页；受流式 SSR 限制状态码为 200（全站既有行为）");

  gate("租约全部释放", leases.length === 0,
    leases.map((l) => `${l.task_type}@${l.locked_by}`).join(", ") || "无残留");

  /*
   * 停在 RUNNING 且早已超过租约期的审计行 = worker 崩溃没被回收。
   * 下一轮同类任务会把它标成 WORKER_LOST；一直没被回收说明那一类根本没再跑起来。
   */
  const stuckRuns = runs.filter((r) =>
    r.status === "RUNNING" && Date.now() - r.started_at.getTime() > 15 * 60_000);
  gate("无长期停在 RUNNING 的运行", stuckRuns.length === 0,
    stuckRuns.map((r) => `#${r.id} ${r.task_type}`).join(", ") || "无");

  gate("AIEvent 调用 = 0（该模型不存在）", !Object.keys(prisma).some((k) => /^ai[eE]vent$/.test(k)));

  const baseline = await loadProtectedBaseline();
  const current = await readProtectedState();
  if (!baseline) {
    gate("受保护状态与基线一致", false, "尚无基线，先运行 npm run aihot:verify -- --capture-baseline");
  } else {
    const diffs = diffProtectedState(baseline, current);
    const clusteringDiffs = diffs.filter((d) => d.key.startsWith("cluster"));
    gate("event clustering 数据未变", clusteringDiffs.length === 0,
      clusteringDiffs.map((d) => `${d.key} ${d.baseline}→${d.current}`).join(" · ") || "四张表全部一致");
    gate("受保护状态整体未变", diffs.length === 0,
      diffs.map((d) => `${d.key} ${d.baseline}→${d.current}`).join(" · ") || "全部一致");
  }

  // 单日 provider 调用异常增长：与历史中位数比
  const row = await prisma.setting.findUnique({ where: { key: METRICS_KEY } });
  const history = row ? (JSON.parse(row.value) as { date: string; providerCalls: number }[]) : [];
  const past = history.filter((h) => h.date !== date).map((h) => h.providerCalls).sort((a, b) => a - b);
  if (past.length >= 3) {
    const median = past[Math.floor(past.length / 2)];
    const cap = Math.max(median * 3, median + 20);
    gate("单日 provider 调用无异常增长", metrics.providerCalls <= cap,
      `今日 ${metrics.providerCalls} · 历史中位数 ${median} · 上限 ${cap}`);
  } else {
    console.log(`  ⏭  单日 provider 调用异常增长 —— 历史样本 ${past.length} 天，不足 3 天，暂不判定`);
  }

  console.log("\n三、任务隔离");
  for (const t of ALL_TASKS) {
    const rs = byTask[t];
    const failed = rs.filter((r) => r.status === "FAILED").length;
    console.log(`  ${t.padEnd(11)} 运行 ${rs.length} · 失败 ${failed} · provider ${sum(rs, "provider_calls")} · 新版本 ${sum(rs, "revisions_created")}`);
  }
  const anyFailed = ALL_TASKS.filter((t) => byTask[t].some((r) => r.status === "FAILED"));
  const allFailed = ALL_TASKS.filter((t) => byTask[t].length > 0 && byTask[t].every((r) => r.status === "FAILED"));
  gate("单类失败未拖垮其它类", anyFailed.length === 0 || allFailed.length < ALL_TASKS.filter((t) => byTask[t].length > 0).length,
    anyFailed.length ? `失败类型：${anyFailed.join(", ")}` : "本日无失败");

  if (RECORD) {
    const hist = row ? (JSON.parse(row.value) as { date: string }[]) : [];
    const idx = hist.findIndex((h) => h.date === date);
    if (idx >= 0) hist[idx] = metrics as unknown as { date: string };
    else hist.push(metrics as unknown as { date: string });
    const trimmed = hist.slice(-30);
    await prisma.setting.upsert({
      where: { key: METRICS_KEY },
      create: { key: METRICS_KEY, value: JSON.stringify(trimmed) },
      update: { value: JSON.stringify(trimmed) },
    });
    console.log(`\n已记录 ${trimmed.length} 天指标（7 天 canary 目标；保留最近 30 天）`);
  }

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) { console.log("\n未通过："); for (const f of failures) console.log(`  - ${f}`); }
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
