/**
 * 多语言人工审核与受控发布的离线测试。
 *
 *   npm run test:publish
 *
 * **不发外部请求、不调 provider、不发布真实内容。**
 * 用带标记的临时 family 跑真实 Prisma 路径，跑完清理干净。
 *
 * 核心命题：
 *   1. 同一 revision 重复发布**不会**产生第二条记录；
 *   2. 未发布的内容公开侧一律读不到；
 *   3. 十项检查没全过就不能标 APPROVED；出了新 revision，旧批准立即失效；
 *   4. 热点素材只够标题加计数时必须拦下；
 *   5. 内容重复**不是**拒绝发布的理由。
 */
import type { DraftLanguage } from "@prisma/client";

import {
  hotTopicFactFingerprint, hotTopicUnitKey, loadAllLatestMaterial, loadHotTopicMaterial,
} from "@/lib/content/publishing/eligibility";
import { checkHotTopicBrief } from "@/lib/content/multilingual/hot-topic-qa";
import {
  HOT_TOPIC_FORBIDDEN_CODES, HOT_TOPIC_WORD_BAND,
  type ContentUnitInput, type DraftContent,
} from "@/lib/content/multilingual/types";
import { listTrending } from "@/lib/content/publishing/trending";
import { publishedMetadata } from "@/lib/content/publishing/metadata";
import { preflight, publicationIdempotencyKey, publishTranslation } from "@/lib/content/publishing/publish";
import {
  deriveSections, getDailyPage, getUpdatePage, listPublishedPaths, type PublishedPage,
} from "@/lib/content/publishing/query";
import { recordReview } from "@/lib/content/publishing/review";
import {
  ALL_CHECKS_PASS, failedChecks, LOCALES, LOCALE_HREFLANG, LOCALE_SEGMENT,
  absoluteUrl, localeFromSegment, publicPath, slugify,
} from "@/lib/content/publishing/types";
import { prisma } from "@/lib/prisma";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(id: string, name: string, ok: boolean, detail = "") {
  if (ok) pass++; else { fail++; failures.push(`${id} ${name}${detail ? ` — ${detail}` : ""}`); }
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const section = (t: string) => console.log(`\n${t}\n`);

const MARKER = "__pubtest__";

async function purge(): Promise<number> {
  const fams = await prisma.articleFamily.findMany({
    where: { unit_key: { startsWith: MARKER } }, select: { id: true },
  });
  if (!fams.length) return 0;
  const ids = fams.map((f) => f.id);
  const ts = await prisma.articleTranslation.findMany({ where: { family_id: { in: ids } }, select: { id: true } });
  const tids = ts.map((t) => t.id);
  if (tids.length) {
    await prisma.articlePublication.deleteMany({ where: { translation_id: { in: tids } } });
    await prisma.translationReview.deleteMany({ where: { translation_id: { in: tids } } });
    await prisma.articleRevision.deleteMany({ where: { translation_id: { in: tids } } });
  }
  await prisma.articleTranslation.deleteMany({ where: { family_id: { in: ids } } });
  await prisma.articleFamily.deleteMany({ where: { id: { in: ids } } });
  return fams.length;
}

let seq = 0;
/**
 * 测试用 family 必须挂在**真实存在**的 AI HOT 来源上。
 * 凭空造一个没有来源行的 family，预检会正当地判 SOURCE_ROW_MISSING ——
 * 那是它该做的事，不是缺陷。
 */
async function anchorItem() {
  const it = await prisma.aihotSelectedItem.findFirst({ select: { id: true, source_snapshot_hash: true } });
  if (!it) throw new Error("库中没有 AI HOT 精选，测试无法构造真实来源锚点");
  return it;
}

async function makeFamily(opts: { form?: "MULTILINGUAL_NEWS_BRIEF" | "DAILY_BRIEF"; qa?: "PASSED" | "NEEDS_REWRITE" } = {}) {
  seq++;
  const form = opts.form ?? "MULTILINGUAL_NEWS_BRIEF";
  const anchor = await anchorItem();
  const family = await prisma.articleFamily.create({
    data: {
      unit_key: `${MARKER}${seq}`,
      content_kind: form === "DAILY_BRIEF" ? "DAILY" : "SELECTED",
      content_form: form,
      selected_item_id: anchor.id,
      slug: `pubtest-${seq}`,
      report_date: form === "DAILY_BRIEF" ? `2020-01-${String(seq).padStart(2, "0")}` : null,
      source_snapshot_hash: anchor.source_snapshot_hash,
      attribution_name: "AI HOT",
      attribution_url: `https://aihot.virxact.com/items/pubtest${seq}`,
      original_source_name: "Example Source",
      original_source_url: "https://example.com/a",
      category_slug: "Models",
    },
  });
  const created: { locale: DraftLanguage; translationId: number; revisionId: number }[] = [];
  for (const locale of LOCALES) {
    const t = await prisma.articleTranslation.create({ data: { family_id: family.id, locale } });
    const r = await prisma.articleRevision.create({
      data: {
        translation_id: t.id, revision_number: 1,
        headline: `Headline ${locale} ${seq}`,
        summary: `Summary ${locale}`,
        body: form === "DAILY_BRIEF"
          ? `Lead ${locale}\n\n## Sec A\nbody a\n\n## Sec B\nbody b`
          : `Body ${locale} mentions Example Source.`,
        source_input_hash: `sih${seq}`,
        qa_verdict: opts.qa ?? "PASSED",
      },
    });
    await prisma.articleTranslation.update({ where: { id: t.id }, data: { current_revision_id: r.id } });
    created.push({ locale, translationId: t.id, revisionId: r.id });
  }
  return { family, created };
}

async function approveAll(created: { locale: DraftLanguage; translationId: number; revisionId: number }[]) {
  for (const c of created) {
    await recordReview({
      translationId: c.translationId, revisionId: c.revisionId, reviewer: "test",
      decision: "APPROVED", checklist: ALL_CHECKS_PASS, issueCategories: ["NO_ISSUE"],
    });
  }
}

async function main() {
  await purge();

  section("A  路由与 locale");

  check("A1", "四种 locale 各有 URL 片段",
    LOCALE_SEGMENT.EN_US === "en" && LOCALE_SEGMENT.ES_ES === "es"
    && LOCALE_SEGMENT.PT_BR === "pt-br" && LOCALE_SEGMENT.JA_JP === "ja");
  check("A2", "片段可反查 locale", localeFromSegment("pt-br") === "PT_BR" && localeFromSegment("ja") === "JA_JP");
  check("A3", "未知片段返回 null（不猜）", localeFromSegment("fr") === null && localeFromSegment("") === null);
  check("A4", "精选路径", publicPath({ locale: "EN_US", contentForm: "MULTILINGUAL_NEWS_BRIEF", slug: "x" }) === "/en/updates/x");
  check("A5", "热点路径带 trending 段",
    publicPath({ locale: "ES_ES", contentForm: "HOT_TOPIC_BRIEF", slug: "x" }) === "/es/updates/trending/x");
  check("A6", "日报路径用日期",
    publicPath({ locale: "JA_JP", contentForm: "DAILY_BRIEF", slug: "", reportDate: "2026-08-01" }) === "/ja/briefings/daily/2026-08-01");
  check("A7", "日报缺日期直接报错，不生成半截路径", (() => {
    try { publicPath({ locale: "EN_US", contentForm: "DAILY_BRIEF", slug: "x" }); return false; } catch { return true; }
  })());
  check("A8", "四种语言共用同一 slug（hreflang 只换前缀）",
    LOCALES.map((l) => publicPath({ locale: l, contentForm: "MULTILINGUAL_NEWS_BRIEF", slug: "same" }))
      .every((p) => p.endsWith("/updates/same")));

  section("B  slug");

  check("B1", "英文标题生成可读 slug", slugify("OpenAI's Astra Solves 10 Problems") === "openai-s-astra-solves-10-problems");
  check("B2", "带后缀避免撞车", slugify("Same Title", "abc123").endsWith("-abc123"));
  check("B3", "长度受限", slugify("x".repeat(200)).length <= 70);
  check("B4", "空标题有兜底", slugify("！！！").length > 0);

  section("C  canonical / hreflang");

  const fakePage = (locale: DraftLanguage, published: DraftLanguage[]): PublishedPage => ({
    locale, path: publicPath({ locale, contentForm: "MULTILINGUAL_NEWS_BRIEF", slug: "s" }),
    canonical: absoluteUrl(publicPath({ locale, contentForm: "MULTILINGUAL_NEWS_BRIEF", slug: "s" })),
    headline: "H", summary: "S", body: "B", sections: null, contentForm: "MULTILINGUAL_NEWS_BRIEF",
    categorySlug: "Models", hotTopicMode: null,
    attribution: {
      poweredByLabel: "Powered by AI HOT" as const,
      providerUrl: "https://aihot.virxact.com/items/x", originalHref: "https://example.com/a",
    },
    sourcePublishedAt: new Date("2026-08-01"), sitePublishedAt: new Date("2026-08-01"),
    alternates: published.map((l) => ({
      locale: l, hreflang: LOCALE_HREFLANG[l],
      href: absoluteUrl(publicPath({ locale: l, contentForm: "MULTILINGUAL_NEWS_BRIEF", slug: "s" })),
    })),
    xDefault: published.includes("EN_US")
      ? absoluteUrl(publicPath({ locale: "EN_US", contentForm: "MULTILINGUAL_NEWS_BRIEF", slug: "s" })) : null,
  });
  {
    const m = publishedMetadata(fakePage("ES_ES", LOCALES));
    check("C1", "self-canonical 指向自己（不指向英文）",
      m.alternates?.canonical === "https://askwalle.com/es/updates/s", String(m.alternates?.canonical));
    const langs = m.alternates?.languages as Record<string, string>;
    check("C2", "四种语言 hreflang 齐全",
      LOCALES.every((l) => langs[LOCALE_HREFLANG[l]]), Object.keys(langs).join(","));
    check("C3", "x-default 指向 en-US", langs["x-default"] === "https://askwalle.com/en/updates/s");
    check("C4", "标记为可收录", (m.robots as { index?: boolean })?.index === true);
  }
  {
    // 只发布了两种语言时，不能给另外两种编造互链
    const m = publishedMetadata(fakePage("EN_US", ["EN_US", "JA_JP"]));
    const langs = m.alternates?.languages as Record<string, string>;
    check("C5", "未发布的语言不写进 hreflang（否则是死链）",
      !langs[LOCALE_HREFLANG.ES_ES] && !langs[LOCALE_HREFLANG.PT_BR] && Boolean(langs[LOCALE_HREFLANG.JA_JP]));
  }
  {
    const m = publishedMetadata(fakePage("JA_JP", ["JA_JP"]));
    const langs = m.alternates?.languages as Record<string, string>;
    check("C6", "英文未发布时不给 x-default（不随便指一个）", langs["x-default"] === undefined);
  }

  section("D  日报分栏还原");

  {
    const d = deriveSections("Lead para\n\n## Alpha\na body\n\n## Beta\nb body");
    check("D1", "导语与栏目都被还原", d?.length === 3 && d![0].label === "" && d![1].label === "Alpha" && d![2].label === "Beta");
    check("D2", "栏目顺序保持输入顺序", d![1].label === "Alpha" && d![2].label === "Beta");
  }
  check("D3", "无标记的正文不强行分栏", deriveSections("just one paragraph") === null);
  check("D4", "译文里的西语栏目同样能还原",
    (deriveSections("Intro\n\n## Noticias de la industria\ntexto")?.length ?? 0) === 2);

  section("E  人工审核");

  {
    const { family, created } = await makeFamily();
    const en = created[0];
    const bad = { ...ALL_CHECKS_PASS, numbers_consistent: false };
    const r = await recordReview({
      translationId: en.translationId, revisionId: en.revisionId, reviewer: "t",
      decision: "APPROVED", checklist: bad, issueCategories: ["NO_ISSUE"],
    });
    check("E1", "十项没全过不能标 APPROVED", !r.ok, r.ok ? "竟然通过了" : r.reason.slice(0, 60));
    check("E2", "failedChecks 能列出未过项", failedChecks(bad).length === 1);

    const r2 = await recordReview({
      translationId: en.translationId, revisionId: en.revisionId, reviewer: "t",
      decision: "APPROVED", checklist: ALL_CHECKS_PASS, issueCategories: ["TRUE_FACT_DRIFT"],
    });
    check("E3", "存在实质问题分类时不能 APPROVED", !r2.ok);

    const r3 = await recordReview({
      translationId: en.translationId, revisionId: en.revisionId, reviewer: "",
      decision: "APPROVED", checklist: ALL_CHECKS_PASS, issueCategories: ["NO_ISSUE"],
    });
    check("E4", "必须记录审核人身份", !r3.ok);

    const other = await makeFamily();
    const r4 = await recordReview({
      translationId: en.translationId, revisionId: other.created[0].revisionId, reviewer: "t",
      decision: "APPROVED", checklist: ALL_CHECKS_PASS, issueCategories: ["NO_ISSUE"],
    });
    check("E5", "审核结论不能记到别人的 revision 上", !r4.ok);

    const r5 = await recordReview({
      translationId: en.translationId, revisionId: en.revisionId, reviewer: "alice",
      decision: "APPROVED", checklist: ALL_CHECKS_PASS, issueCategories: ["NO_ISSUE"], notes: "ok",
    });
    check("E6", "合规审核被记录", r5.ok);
    const saved = await prisma.translationReview.findFirst({
      where: { translation_id: en.translationId }, orderBy: { id: "desc" },
    });
    check("E7", "保存的是完整记录而非一个布尔",
      Boolean(saved?.reviewer && saved?.reviewed_at && saved?.decision && saved?.checklist_json && saved?.issue_categories_json));

    // 出了新 revision，旧批准必须失效
    const rev2 = await prisma.articleRevision.create({
      data: { translation_id: en.translationId, revision_number: 2, headline: "H2", summary: "S2",
        body: "B2", source_input_hash: "sih2", qa_verdict: "PASSED" },
    });
    await prisma.articleTranslation.update({
      where: { id: en.translationId }, data: { current_revision_id: rev2.id, approved_revision_id: null },
    });
    const pre = await preflight(family.id);
    check("E8", "新 revision 未重审时不可发布",
      pre!.issues.some((i) => i.code === "NOT_APPROVED"), pre!.issues.map((i) => i.code).join(","));
  }

  section("F  预检");

  {
    const { family } = await makeFamily({ qa: "NEEDS_REWRITE" });
    const pre = await preflight(family.id);
    check("F1", "QA 未通过 → 不可发布", !pre!.ok && pre!.issues.some((i) => i.code === "NOT_APPROVED" || i.code === "QA_NOT_PASSED"));
  }
  {
    const { family, created } = await makeFamily();
    await approveAll(created);
    const pre = await preflight(family.id);
    check("F2", "四语言齐备且已批准 → 可发布", pre!.ok, pre!.issues.map((i) => i.code).join(","));
    check("F3", "预检给出四条目标路径", pre!.targets.length === 4);
    check("F4", "预检是只读的（未产生发布记录）",
      (await prisma.articlePublication.count({ where: { translation_id: { in: created.map((c) => c.translationId) } } })) === 0);
    check("F5", "预检带出聚类计数供比对", typeof pre!.clusteringCounters.runs === "number");

    await prisma.articleFamily.update({ where: { id: family.id }, data: { source_snapshot_hash: "changed-since-freeze" } });
    const pre2 = await preflight(family.id);
    check("F6", "来源快照变了 → 拦下", pre2!.issues.some((i) => i.code === "SOURCE_SNAPSHOT_CHANGED"),
      pre2!.issues.map((i) => i.code).join(","));

    await prisma.articleFamily.update({ where: { id: family.id }, data: { attribution_url: "not-a-url" } });
    const pre3 = await preflight(family.id);
    check("F7", "归因链接非法 → 拦下", pre3!.issues.some((i) => i.code === "ATTRIBUTION_URL_INVALID"));
  }

  section("G  发布幂等");

  {
    const { created } = await makeFamily();
    await approveAll(created);
    const t = created[0];
    const path = "/en/updates/pubtest-idem";
    const k1 = publicationIdempotencyKey(t.translationId, t.revisionId);
    const k2 = publicationIdempotencyKey(t.translationId, t.revisionId);
    check("G1", "幂等键可复现（不含时间戳/随机数）", k1 === k2 && k1.length === 40);
    check("G2", "不同 revision 幂等键不同",
      publicationIdempotencyKey(t.translationId, t.revisionId + 1) !== k1);

    const a = await publishTranslation({ translationId: t.translationId, revisionId: t.revisionId, locale: "EN_US", path });
    check("G3", "首次发布成功", a.status === "PUBLISHED");
    const b = await publishTranslation({ translationId: t.translationId, revisionId: t.revisionId, locale: "EN_US", path });
    check("G4", "同一 revision 重复发布返回 ALREADY_PUBLISHED", b.status === "ALREADY_PUBLISHED");
    check("G5", "重复发布未创建第二条记录",
      (await prisma.articlePublication.count({ where: { translation_id: t.translationId } })) === 1);

    // 并发：同时打三发，只能有一条落库
    const [x, y, z] = await Promise.all([
      publishTranslation({ translationId: t.translationId, revisionId: t.revisionId, locale: "EN_US", path }),
      publishTranslation({ translationId: t.translationId, revisionId: t.revisionId, locale: "EN_US", path }),
      publishTranslation({ translationId: t.translationId, revisionId: t.revisionId, locale: "EN_US", path }),
    ]);
    check("G6", "并发重复请求不产生第二条记录",
      (await prisma.articlePublication.count({ where: { translation_id: t.translationId } })) === 1);
    check("G7", "并发结果都不是失败",
      [x, y, z].every((r) => r.status !== "FAILED"), [x, y, z].map((r) => r.status).join(","));

    // 同一 locale 内路径唯一
    const other = created[1];
    const clash = await publishTranslation({
      translationId: other.translationId, revisionId: other.revisionId, locale: "EN_US", path,
    });
    check("G8", "同一 locale 内 slug 唯一（第二个译本抢同路径失败）", clash.status === "FAILED");
  }

  section("H  公开可见性");

  {
    const { family, created } = await makeFamily();
    await approveAll(created);
    check("H1", "未发布 → 公开侧读不到", (await getUpdatePage("EN_US", family.slug)) === null);

    const t = created.find((c) => c.locale === "EN_US")!;
    await publishTranslation({
      translationId: t.translationId, revisionId: t.revisionId, locale: "EN_US",
      path: publicPath({ locale: "EN_US", contentForm: "MULTILINGUAL_NEWS_BRIEF", slug: family.slug }),
    });
    const page = await getUpdatePage("EN_US", family.slug);
    check("H2", "已发布 → 读得到", page !== null);
    check("H3", "只发了英文时，其余语言仍读不到",
      (await getUpdatePage("ES_ES", family.slug)) === null);
    check("H4", "公开数据里不含 QA / 内部字段",
      page !== null && !("qaIssues" in page) && !("sourceInputHash" in page) && !("originDraftId" in page));
    check("H5", "底部归因齐备且不含实际来源名",
      Boolean(page!.attribution?.providerUrl) && page!.attribution.poweredByLabel === "Powered by AI HOT"
      && !("originalSourceName" in page!) && !("attributionName" in page!));
    check("H6", "sitemap 只收已发布路径", (await listPublishedPaths()).some((p) => p.path.includes(family.slug)));

    const drafted = await makeFamily();
    check("H7", "草稿家族不出现在 sitemap 中",
      !(await listPublishedPaths()).some((p) => p.path.includes(drafted.family.slug)));
    check("H8", "非法日期的日报路径直接返回 null", (await getDailyPage("EN_US", "not-a-date")) === null);
  }

  section("I  热点：不再有信息量门禁");

  {
    const all = await loadAllLatestMaterial();
    check("I1", "每个 topic 都能载入素材（不因信息少而失败）", all.length > 0, `${all.length} 个热点`);
    check("I2", "每个热点都被判定为 SIGNAL 或 ENRICHED",
      all.every((m) => m.mode === "SIGNAL" || m.mode === "ENRICHED"),
      all.map((m) => m.mode).join(","));
    check("I3", "只有标题与计数时判为 SIGNAL 而不是拒绝",
      all.filter((m) => !m.apiSummary && m.relatedItems.length === 0).every((m) => m.mode === "SIGNAL"));
    check("I4", "有摘要或关联精选时判为 ENRICHED",
      all.filter((m) => m.apiSummary || m.relatedItems.length > 0).every((m) => m.mode === "ENRICHED"));
    check("I5", "身份键按 topic 而非按快照（同一热点始终同一单元）",
      all.every((m) => hotTopicUnitKey(m.topicId) === `topic:${m.topicId}`)
      && !hotTopicUnitKey("abc").includes(":", 6 + 3));
    check("I6", "不存在的快照返回 null（数据缺陷，不是信息量判断）",
      (await loadHotTopicMaterial(-1)) === null);
  }

  section("K  热点简报 QA");

  {
    const material = await loadAllLatestMaterial();
    const m = material[0];
    if (!m) {
      check("K0", "（库中无热点，跳过热点 QA 测试）", true);
    } else {
      const base: ContentUnitInput = {
        contentKind: "HOT_TOPIC", contentForm: "HOT_TOPIC_BRIEF",
        unitKey: hotTopicUnitKey(m.topicId),
        selectedItemId: null, hotTopicSnapshotId: m.snapshotId, dailyReportId: null,
        title: m.title, sourceText: m.title, sections: [],
        categorySlug: "Trending", sourceSnapshotHash: m.snapshotHash,
        attributionName: "AI HOT", attributionUrl: m.aihotUrl,
        originalSourceName: m.representativeSourceName, originalSourceUrl: m.originalUrl,
        publishedAt: m.latestAt,
        facts: [{ label: "涉及来源数", value: String(m.sourceCount) }],
        hotTopic: {
          mode: "SIGNAL", topicId: m.topicId, rank: m.rank,
          sourceCount: m.sourceCount, signalCount: m.signalCount,
          sourceNames: m.sourceNames, capturedAt: m.capturedAt, latestAt: m.latestAt,
        },
      };
      const good: DraftContent = {
        headline: "Trending signal",
        summary: `AI HOT currently lists this as a trending topic across ${m.sourceCount} sources.`,
        body: `AI HOT currently lists this as a trending topic. The topic is being tracked across ${m.sourceCount} sources with ${m.signalCount} signals. The available feed does not include further event details.`,
      };
      const r = checkHotTopicBrief(good, base);
      check("K1", "如实转述计数的 SIGNAL 简报通过", r.verdict === "PASSED",
        r.issues.map((i) => `${i.code}:${i.detail}`).join(" | ").slice(0, 160));

      const wrongCount = { ...good, body: good.body.replace(String(m.sourceCount), String((m.sourceCount ?? 0) + 7)) };
      check("K2", "来源计数写错 → HOT_TOPIC_SOURCE_COUNT_MISMATCH",
        checkHotTopicBrief(wrongCount, base).issues.some((i) => i.code === "HOT_TOPIC_SOURCE_COUNT_MISMATCH"));

      // 用登记过的实体做「凭空冒出来」的样本：普通英文词组成的名字查不到，
      // 那条边界另有 I5b 记录
      const invented = { ...good, body: good.body + " Additional coverage came from Nvidia." };
      check("K3", "编造来源名 → HOT_TOPIC_SOURCE_NAME_MISMATCH",
        checkHotTopicBrief(invented, base).issues.some((i) => i.code === "HOT_TOPIC_SOURCE_NAME_MISMATCH"));

      const wrongRank = { ...good, body: good.body + ` It is ranked number ${(m.rank ?? 1) + 40} on the board.` };
      check("K4", "名次写错 → HOT_TOPIC_RANK_MISMATCH",
        checkHotTopicBrief(wrongRank, base).issues.some((i) => i.code === "HOT_TOPIC_RANK_MISMATCH"));

      const day = m.capturedAt.toISOString().slice(0, 10);
      const timeWrong = { ...good, body: good.body + ` The product was launched on ${day}.` };
      check("K5", "把抓取时间写成事件发生时间 → HOT_TOPIC_TIME_MISREPRESENTED",
        checkHotTopicBrief(timeWrong, base).issues.some((i) => i.code === "HOT_TOPIC_TIME_MISREPRESENTED"));

      const noFraming = { headline: "Major release lands", summary: "A major release landed today.", body: "A major release landed today. It changes the market significantly for everyone involved." };
      check("K6", "SIGNAL 未自报家门 → HOT_TOPIC_TIME_MISREPRESENTED",
        checkHotTopicBrief(noFraming, base).issues.some((i) => i.code === "HOT_TOPIC_TIME_MISREPRESENTED"));

      const tooLong = { ...good, body: good.body + " " + "word".repeat(1) + " filler".repeat(HOT_TOPIC_WORD_BAND.SIGNAL.max + 20) };
      check("K7", "SIGNAL 超出词数带 → HOT_TOPIC_UNSUPPORTED_DETAIL",
        checkHotTopicBrief(tooLong, base).issues.some((i) => i.code === "HOT_TOPIC_UNSUPPORTED_DETAIL"));

      const extraNum = { ...good, body: good.body + " The model has 671B parameters." };
      check("K8", "补充 API 没给的参数 → 被拦下",
        checkHotTopicBrief(extraNum, base).issues.some(
          (i) => i.code === "HOT_TOPIC_UNSUPPORTED_DETAIL" || i.code === "HOT_TOPIC_SOURCE_COUNT_MISMATCH"));

      const allIssues = [good, wrongCount, invented, wrongRank, timeWrong, noFraming, tooLong, extraNum]
        .flatMap((d) => checkHotTopicBrief(d, base).issues.map((i) => i.code as string));
      check("K9", "热点 QA 永不产出已取消的门禁类结论",
        !allIssues.some((c) => (HOT_TOPIC_FORBIDDEN_CODES as readonly string[]).includes(c)),
        [...new Set(allIssues)].join(","));
      check("K10", "空字段 → EMPTY_FIELD",
        checkHotTopicBrief({ ...good, body: "" }, base).issues.some((i) => i.code === "EMPTY_FIELD"));
    }
  }

  section("L  热点榜单与幂等");

  {
    const material = await loadAllLatestMaterial();
    const listing = await listTrending("EN_US");
    const cards = listing!.cards;
    check("L1", "每个最新热点都有一张卡片", cards.length === material.length, `${cards.length}/${material.length}`);
    check("L2", "卡片不含实际来源名与条目地址（公开投影里就没有）",
      cards.every((c) => !("sourceNames" in c) && !("aihotUrl" in c) && !("topicId" in c)
        && c.capturedAt instanceof Date));
    check("L3", "卡片按名次升序", cards.every((c, i) => i === 0 || (cards[i - 1].rank ?? 999) <= (c.rank ?? 999)));
    check("L4", "未发布的语言不给简报入口（不做死链）",
      cards.every((c) => c.briefHref === null || c.briefHref.startsWith("/en/")));
    check("L4b", "榜单页有底部归因", listing!.attribution.poweredByLabel === "Powered by AI HOT");

    if (material[0]) {
      const m = material[0];
      const fp1 = hotTopicFactFingerprint(m);
      const fp2 = hotTopicFactFingerprint({ ...m, rank: (m.rank ?? 1) + 10 });
      check("L5", "仅排名变化不改变事实指纹（不触发重写）", fp1 === fp2);
      const fp3 = hotTopicFactFingerprint({ ...m, sourceCount: (m.sourceCount ?? 0) + 1 });
      check("L6", "来源数变化改变事实指纹", fp1 !== fp3);
      const fp4 = hotTopicFactFingerprint({ ...m, sourceNames: [...m.sourceNames, "New Source"] });
      check("L7", "来源名单变化改变事实指纹", fp1 !== fp4);
      const fp5 = hotTopicFactFingerprint({ ...m, title: m.title + " 追加" });
      check("L8", "标题变化改变事实指纹", fp1 !== fp5);
    }
  }

  section("J  产品边界");

  {
    // 两个内容完全相同的 family 都必须能发布 —— 重复不是拒绝理由
    const a = await makeFamily();
    const b = await makeFamily();
    await approveAll(a.created);
    await approveAll(b.created);
    const pa = await preflight(a.family.id);
    const pb = await preflight(b.family.id);
    check("J1", "内容重复的两个单元都可发布（重复不是拒绝理由）", pa!.ok && pb!.ok);
    check("J2", "预检不产出去重/事件类结论",
      ![...pa!.issues, ...pb!.issues].some((i) => /DUPLICATE|SINGLE_SOURCE|NOT_EXTERNALLY_VERIFIED|LOW_IMPORTANCE/.test(i.code)));
  }
  {
    const before = await prisma.eventClusteringRun.count();
    const { family, created } = await makeFamily();
    await approveAll(created);
    await preflight(family.id);
    check("J3", "审核与预检不触碰 event clustering", (await prisma.eventClusteringRun.count()) === before);
  }

  const purged = await purge();
  const residue = await prisma.articleFamily.count({ where: { unit_key: { startsWith: MARKER } } });
  console.log(`\n收尾：清理 ${purged} 个测试 family，残留 ${residue} 个 ${residue === 0 ? "✅" : "❌"}`);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) { console.log("\n失败项："); for (const f of failures) console.log(`  - ${f}`); }
  await prisma.$disconnect();
  if (fail) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  try { await purge(); } finally { await prisma.$disconnect(); }
  process.exit(1);
});
