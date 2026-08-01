import { Prisma, type DraftLanguage } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { LOCALES, slugify } from "./types";

/**
 * 把生成侧的草稿冻结成可发布的 revision。
 *
 * 两条铁律：
 *   1. **不修改草稿。** 草稿是 pipeline 的产物，这里只读它、复制一份快照。
 *   2. **不覆盖已有 revision。** 内容变了就 +1 出新版本，旧版本原样保留 ——
 *      否则「审核通过的是哪一版」「发布出去的是哪一版」都答不清楚。
 */

export type FreezeResult = {
  unitKey: string;
  familyId: number | null;
  slug: string | null;
  status: "OK" | "SKIPPED" | "FAILED";
  created: { locale: DraftLanguage; revisionId: number; revisionNumber: number }[];
  unchanged: { locale: DraftLanguage; revisionNumber: number }[];
  message: string | null;
};

/**
 * 冻结一个内容单元的四语言草稿。
 *
 * 只接受**全部四种语言都存在且 QA 通过**的单元 —— 半套语言冻进去，
 * 后面 hreflang 必然指向不存在的页面。
 */
export async function freezeUnit(unitKey: string, opts: { dryRun?: boolean } = {}): Promise<FreezeResult> {
  const base: FreezeResult = {
    unitKey, familyId: null, slug: null, status: "FAILED", created: [], unchanged: [], message: null,
  };

  const drafts = await prisma.multilingualDraft.findMany({ where: { unit_key: unitKey } });
  if (!drafts.length) return { ...base, message: "找不到该单元的草稿" };

  const byLocale = new Map<DraftLanguage, (typeof drafts)[number]>();
  for (const d of drafts) byLocale.set(d.language, d);

  const missing = LOCALES.filter((l) => !byLocale.has(l));
  if (missing.length) return { ...base, status: "SKIPPED", message: `缺少语言：${missing.join(", ")}` };

  const notPassed = LOCALES.filter((l) => {
    const d = byLocale.get(l)!;
    return d.status !== "DRAFTED" || d.qa_verdict !== "PASSED";
  });
  if (notPassed.length) {
    return { ...base, status: "SKIPPED", message: `以下语言未通过 QA 或非 DRAFTED：${notPassed.join(", ")}` };
  }

  const master = byLocale.get("EN_US")!;
  if (!master.headline) return { ...base, message: "英文母版缺少标题，无法生成 slug" };

  // slug 从英文母版标题生成；unit 尾号做后缀，避免不同单元撞车
  const suffix = unitKey.split(":").pop()!.slice(-6);
  const slug = slugify(master.headline, suffix);
  /*
   * 来源发布时间是公开页的必备字段：读者要能看出这条内容说的是什么时候的事。
   * 三类内容各取各的时间语义 —— 精选取 published_at，热点取 latest_at
   * （热点没有单一发布时刻，最新动态时间是最接近的表达），日报取 generated_at。
   */
  let reportDate: string | null = null;
  let sourcePublishedAt: Date | null = null;
  if (master.content_kind === "DAILY" && master.daily_report_id) {
    const d = await prisma.aihotDailyReport.findUnique({
      where: { id: master.daily_report_id }, select: { report_date: true, generated_at: true },
    });
    reportDate = d?.report_date ?? null;
    sourcePublishedAt = d?.generated_at ?? null;
  } else if (master.selected_item_id) {
    const s = await prisma.aihotSelectedItem.findUnique({
      where: { id: master.selected_item_id }, select: { published_at: true },
    });
    sourcePublishedAt = s?.published_at ?? null;
  } else if (master.hot_topic_snapshot_id) {
    const t = await prisma.aihotHotTopicSnapshot.findUnique({
      where: { id: master.hot_topic_snapshot_id }, select: { latest_at: true },
    });
    sourcePublishedAt = t?.latest_at ?? null;
  }

  if (opts.dryRun) {
    return { ...base, status: "OK", slug,
      message: `dry-run：4 种语言齐备且 QA 通过，slug=${slug}${reportDate ? ` date=${reportDate}` : ""}` };
  }

  const family = await prisma.articleFamily.upsert({
    where: { unit_key: unitKey },
    create: {
      unit_key: unitKey,
      content_kind: master.content_kind,
      content_form: master.content_form,
      selected_item_id: master.selected_item_id,
      hot_topic_snapshot_id: master.hot_topic_snapshot_id,
      daily_report_id: master.daily_report_id,
      slug, report_date: reportDate,
      source_snapshot_hash: master.source_snapshot_hash,
      attribution_name: master.provider_attribution_name,
      attribution_url: master.provider_attribution_url,
      original_source_name: master.original_source_name,
      original_source_url: master.original_source_url,
      category_slug: master.category_slug,
      source_published_at: sourcePublishedAt,
    },
    // slug 一旦发布就不能改（改了等于换 URL），所以更新时**不动** slug
    update: {
      source_snapshot_hash: master.source_snapshot_hash,
      attribution_url: master.provider_attribution_url,
      original_source_url: master.original_source_url,
      source_published_at: sourcePublishedAt,
    },
  });

  const created: FreezeResult["created"] = [];
  const unchanged: FreezeResult["unchanged"] = [];

  for (const locale of LOCALES) {
    const d = byLocale.get(locale)!;
    const translation = await prisma.articleTranslation.upsert({
      where: { family_id_locale: { family_id: family.id, locale } },
      create: { family_id: family.id, locale },
      update: {},
    });

    const latest = await prisma.articleRevision.findFirst({
      where: { translation_id: translation.id },
      orderBy: { revision_number: "desc" },
    });

    // 内容与最新版逐字相同就不再造新版本 —— 重复冻结不该制造版本噪声
    const same = latest
      && latest.headline === d.headline
      && latest.summary === d.summary
      && latest.body === d.body
      && latest.source_input_hash === d.source_input_hash;
    if (same) {
      unchanged.push({ locale, revisionNumber: latest.revision_number });
      await prisma.articleTranslation.update({
        where: { id: translation.id }, data: { current_revision_id: latest.id },
      });
      continue;
    }

    const rev = await prisma.articleRevision.create({
      data: {
        translation_id: translation.id,
        revision_number: (latest?.revision_number ?? 0) + 1,
        headline: d.headline ?? "",
        summary: d.summary ?? "",
        body: d.body ?? "",
        sections_json: (d.sections_json ?? Prisma.DbNull) as Prisma.InputJsonValue,
        origin_draft_id: d.id,
        source_input_hash: d.source_input_hash,
        qa_verdict: d.qa_verdict,
        qa_issues_json: (d.qa_issues_json ?? Prisma.DbNull) as Prisma.InputJsonValue,
      },
    });
    created.push({ locale, revisionId: rev.id, revisionNumber: rev.revision_number });

    /*
     * 出了新版本，旧的审核结论就不再适用 —— approved_revision_id 必须清掉。
     * 留着它，等于让上一版的批准替这一版背书。
     */
    await prisma.articleTranslation.update({
      where: { id: translation.id },
      data: {
        current_revision_id: rev.id,
        approved_revision_id: null,
        status: latest ? "SUPERSEDED" : "DRAFTED",
      },
    });
  }

  return { ...base, status: "OK", familyId: family.id, slug: family.slug, created, unchanged };
}
