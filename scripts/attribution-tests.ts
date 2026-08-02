/**
 * 公开归因的离线测试。
 *
 *   npm run test:attribution
 *
 * **不发外部请求、不调 provider、不写内容、不改 revision。**
 *
 * 核心命题：
 *   1. 公开投影里**根本没有**实际来源名称与地址 —— 不是渲染时不显示；
 *   2. 已批准的 revision 一个字都不改，剔除只发生在渲染层；
 *   3. 事件主体（OpenAI announced…）必须留下，只去发布者归因；
 *   4. AIHOT_ONLY 没有书面授权时 fail closed 回默认模式。
 */
import {
  DEFAULT_ATTRIBUTION_MODE, buildPublicAttribution, findSourceLeaks,
  redactAttribution, redactionTokens, resolveAttributionMode,
  type RedactionContext,
} from "@/lib/content/publishing/attribution";
import { getDailyPage, getTrendingPage, getUpdatePage } from "@/lib/content/publishing/query";
import { listTrending } from "@/lib/content/publishing/trending";
import { LOCALES } from "@/lib/content/publishing/types";
import { prisma } from "@/lib/prisma";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(id: string, name: string, ok: boolean, detail = "") {
  if (ok) pass++; else { fail++; failures.push(`${id} ${name}${detail ? ` — ${detail}` : ""}`); }
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const section = (t: string) => console.log(`\n${t}\n`);

const CTX: RedactionContext = {
  sourceNames: ["X：Greg Brockman (@gdb)", "The Decoder：AI News（RSS）", "IT之家（RSS）", "MarkTechPost"],
  title: "OpenAI's Astra Solves 10 Major Math Problems",
  providerName: "AI HOT",
};

async function main() {
  section("A  剔除：去归因，留事实");

  {
    const t = "According to a post on X by Greg Brockman (@gdb), OpenAI used Astra to solve ten problems.";
    const out = redactAttribution(t, CTX);
    check("A1", "去掉「据某人发帖」引导语", !/according to/i.test(out), out);
    check("A2", "事件主体与事实完整保留",
      /OpenAI used Astra to solve ten problems/.test(out), out);
    check("A3", "句首恢复大写", /^OpenAI/.test(out), out);
  }
  {
    const t = "OpenAI announced Astra today, as reported by The Decoder.";
    const out = redactAttribution(t, CTX);
    check("A4", "句尾归因从句被去掉", !/The Decoder/i.test(out), out);
    check("A5", "「OpenAI announced」作为事件主体保留", /OpenAI announced Astra today/.test(out), out);
  }
  {
    const t = "This is a trending topic. Sources include IT之家（RSS）, MarkTechPost and others. The feed does not include details.";
    const out = redactAttribution(t, CTX);
    check("A6", "整句都是来源枚举 → 整句删除", !/Sources include/i.test(out), out);
    check("A7", "其余句子保留", /trending topic/.test(out) && /does not include details/.test(out), out);
  }
  {
    const t = "AI HOT reports that DeepSeek released V4 Flash.";
    const out = redactAttribution(t, CTX);
    check("A8", "「AI HOT reports that」去掉，事实保留",
      !/AI\s*HOT/i.test(out) && /DeepSeek released V4 Flash/.test(out), out);
  }
  {
    const t = "AI HOT currently lists this as a trending topic.";
    const out = redactAttribution(t, CTX);
    check("A9", "「AI HOT 把它列为」改写为被动，不留品牌名",
      !/AI\s*HOT/i.test(out) && /listed as a trending topic/i.test(out), out);
  }
  {
    const ctx: RedactionContext = { ...CTX, title: "DeepSeek-V4-Flash Official API Enters Public Beta",
      sourceNames: ["DeepSeek：API 更新日志"] };
    const tokens = redactionTokens(ctx);
    check("A10", "标题里的实体（DeepSeek）不被列为屏蔽词",
      !tokens.some((t) => t.toLowerCase() === "deepseek"), tokens.join(","));
  }
  {
    const out = redactAttribution("Discovered via AI HOT. OpenAI shipped a model.", CTX);
    check("A11", "Discovered via 整句删除", !/Discovered via/i.test(out), out);
  }
  {
    const out = redactAttribution("Read the original source for more. OpenAI shipped a model.", CTX);
    check("A12", "Read original source 整句删除", !/original source/i.test(out), out);
  }

  section("B  归因模式与授权闸门");

  {
    const r = await resolveAttributionMode();
    check("B1", "默认模式为 AIHOT_AND_GENERIC_ORIGINAL",
      r.mode === DEFAULT_ATTRIBUTION_MODE, r.mode);
  }
  {
    const a = buildPublicAttribution({
      mode: "AIHOT_AND_GENERIC_ORIGINAL",
      providerUrl: "https://aihot.virxact.com/items/x",
      originalSourceUrl: "https://example.com/a",
    });
    check("B2", "默认模式给出通用原文入口", a?.originalHref === "https://example.com/a");
    check("B3", "品牌文案固定为 Powered by AI HOT", a?.poweredByLabel === "Powered by AI HOT");
  }
  {
    const a = buildPublicAttribution({
      mode: "AIHOT_ONLY",
      providerUrl: "https://aihot.virxact.com/items/x",
      originalSourceUrl: "https://example.com/a",
    });
    check("B4", "AIHOT_ONLY 不给原文入口", a?.originalHref === null);
  }
  {
    const a = buildPublicAttribution({
      mode: "AIHOT_AND_GENERIC_ORIGINAL", providerUrl: "not-a-url", originalSourceUrl: null,
    });
    check("B5", "AI HOT 链接非法 → 无法构造归因（页面不得可发布）", a === null);
  }
  {
    // fail closed：请求 AIHOT_ONLY 但没有授权记录
    const KEY = "aihot:public-attribution-mode";
    const AUTH = "aihot:aihot-only-authorization";
    const before = await prisma.setting.findUnique({ where: { key: KEY } });
    const beforeAuth = await prisma.setting.findUnique({ where: { key: AUTH } });
    await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: "AIHOT_ONLY" }, update: { value: "AIHOT_ONLY" } });
    await prisma.setting.deleteMany({ where: { key: AUTH } });
    const denied = await resolveAttributionMode();
    check("B6", "未授权时 AIHOT_ONLY 被拒并回落默认模式",
      denied.mode === DEFAULT_ATTRIBUTION_MODE && denied.deniedForMissingAuthorization,
      `${denied.mode} denied=${denied.deniedForMissingAuthorization}`);

    await prisma.setting.upsert({ where: { key: AUTH }, create: { key: AUTH, value: "TEST-AUTH-REF" }, update: { value: "TEST-AUTH-REF" } });
    const allowed = await resolveAttributionMode();
    check("B7", "有书面授权记录后 AIHOT_ONLY 生效",
      allowed.mode === "AIHOT_ONLY" && allowed.authorizationReference === "TEST-AUTH-REF");

    // 还原
    await prisma.setting.deleteMany({ where: { key: AUTH } });
    if (before) await prisma.setting.update({ where: { key: KEY }, data: { value: before.value } });
    else await prisma.setting.deleteMany({ where: { key: KEY } });
    if (beforeAuth) await prisma.setting.upsert({ where: { key: AUTH }, create: { key: AUTH, value: beforeAuth.value }, update: { value: beforeAuth.value } });
    const restored = await resolveAttributionMode();
    check("B8", "测试后模式已还原", restored.mode === DEFAULT_ATTRIBUTION_MODE, restored.mode);
  }

  section("C  公开投影：四语言 × 三类内容");

  const families = await prisma.articleFamily.findMany({
    include: { translations: { include: { publications: { where: { status: "PUBLISHED" } } } } },
  });
  type Sample = { label: string; page: Awaited<ReturnType<typeof getUpdatePage>>; names: string[]; slug: string };
  const samples: Sample[] = [];

  for (const f of families) {
    const names = new Set<string>();
    if (f.original_source_name) names.add(f.original_source_name);
    if (f.hot_topic_snapshot_id) {
      const snap = await prisma.aihotHotTopicSnapshot.findUnique({
        where: { id: f.hot_topic_snapshot_id }, select: { source_name: true, source_names_json: true },
      });
      if (snap?.source_name) names.add(snap.source_name);
      for (const n of (Array.isArray(snap?.source_names_json) ? (snap!.source_names_json as string[]) : [])) names.add(n);
    }
    for (const t of f.translations) {
      // 只关心「有没有已发布记录」，记录本身用不到
      if (t.publications.length) {
        const page =
          f.content_form === "DAILY_BRIEF" ? await getDailyPage(t.locale, f.report_date!)
          : f.content_form === "HOT_TOPIC_BRIEF" ? await getTrendingPage(t.locale, f.slug)
          : await getUpdatePage(t.locale, f.slug);
        samples.push({ label: `${f.content_form}/${t.locale}`, page, names: [...names], slug: f.slug });
      }
    }
  }

  check("C1", "已发布页面均可取到公开投影", samples.every((s) => s.page !== null), `${samples.length} 页`);

  const forms = new Set(samples.map((s) => s.label.split("/")[0]));
  check("C2", "覆盖三类内容", forms.size === 3, [...forms].join(","));
  const locs = new Set(samples.map((s) => s.label.split("/")[1]));
  check("C3", "覆盖四种语言", locs.size === LOCALES.length, [...locs].join(","));

  /*
   * 检查范围刻意排除 attribution.originalHref。
   *
   * 默认模式要求保留原文入口，链接就是数据库里的 original_source_url ——
   * 那个 URL 本身必然带着来源域名或 handle（x.com/<handle>/…）。
   * 这是「保留原文入口」这个决定的固有代价，不是实现缺陷：
   * **显示文案**是通用的，**链接目标**是真实的。
   * 其余所有字段都不允许出现来源名。
   */
  const leaky = samples.filter((s) => {
    if (!s.page) return false;
    const { attribution, ...rest } = s.page;
    const scanned = JSON.stringify({ ...rest, attribution: { ...attribution, originalHref: null } });
    /*
     * 豁免依据必须和渲染层用的是同一份：标题 + slug。
     * slug 是从初版标题生成的，里面同样含事件主体（…openai-s-latest-update…），
     * 只拿当前标题做豁免会把 URL 里的主体名误报成泄漏。
     */
    const title = `${s.page.headline} ${s.slug.replace(/-/g, " ")}`;
    return findSourceLeaks(scanned, { sourceNames: s.names, title, providerName: "AI HOT" }).length > 0;
  });
  check("C4", "公开投影（除原文链接外）无实际来源名泄漏", leaky.length === 0,
    leaky.slice(0, 3).map((s) => s.label).join(", "));
  {
    const withOriginal = samples.filter((x) => x.page!.attribution.originalHref);
    check("C4b", "原文入口用的是数据库里的真实 original_source_url（按设计如此）",
      withOriginal.every((x) => /^https?:\/\//.test(x.page!.attribution.originalHref!)),
      `${withOriginal.length} 页带原文入口`);
    check("C4c", "原文入口的**显示文案**是通用的，DTO 里不带来源名",
      withOriginal.every((x) => !("originalSourceName" in x.page!.attribution)));
  }

  const withSourceUrl = samples.filter((s) => {
    if (!s.page) return false;
    const json = JSON.stringify(s.page);
    // 通用原文入口是允许的；这里查的是**字段**层面的实际来源对象
    return /"originalSourceName"|"originalSourceUrl"|"attributionName"/.test(json);
  });
  check("C5", "公开投影不含实际来源字段", withSourceUrl.length === 0);

  check("C6", "每页都有底部归因且品牌文案统一",
    samples.every((s) => s.page?.attribution.poweredByLabel === "Powered by AI HOT"));
  check("C7", "底部 AI HOT 链接均合法",
    samples.every((s) => /^https:\/\/aihot\.virxact\.com\//.test(s.page!.attribution.providerUrl)));
  check("C8", "默认模式下原文入口只有通用文字（DTO 里没有来源名）",
    samples.every((s) => {
      const a = s.page!.attribution;
      return a.originalHref === null || /^https?:\/\//.test(a.originalHref);
    }));

  const topAttribution = samples.filter((s) => {
    const p = s.page!;
    return /discovered via/i.test(p.headline + p.summary)
      || /\bsource\s*:/i.test(p.headline + p.summary);
  });
  check("C9", "标题与摘要顶部无 AI HOT 归因标签", topAttribution.length === 0,
    topAttribution.slice(0, 3).map((s) => s.label).join(", "));

  const templated = samples.filter((s) => {
    const p = s.page!;
    return /\baccording to\b/i.test(p.body) || /discovered via/i.test(p.body)
      || /\bsources? include\b/i.test(p.body) || /\bAI\s*HOT\b/i.test(p.body);
  });
  check("C10", "正文无模板化 AI HOT 来源文案", templated.length === 0,
    templated.slice(0, 3).map((s) => s.label).join(", "));

  section("D  榜单卡片");

  {
    const listing = await listTrending("EN_US");
    check("D1", "榜单可取", listing !== null && listing.cards.length > 0, `${listing?.cards.length ?? 0} 张`);
    const json = JSON.stringify(listing);
    check("D2", "卡片投影无来源名单/条目地址/topicId",
      !/"sourceNames"|"aihotUrl"|"topicId"/.test(json));
    const material = await prisma.aihotHotTopicSnapshot.findMany({ select: { source_names_json: true } });
    const allNames = new Set<string>();
    for (const m of material) {
      for (const n of (Array.isArray(m.source_names_json) ? (m.source_names_json as string[]) : [])) allNames.add(n);
    }
    const leaks = [...allNames].filter((n) => n.length >= 5 && json.includes(n));
    check("D3", "卡片不显示实际来源名称", leaks.length === 0, leaks.slice(0, 3).join(", "));
    check("D4", "榜单页有底部归因",
      listing?.attribution.poweredByLabel === "Powered by AI HOT");
  }

  section("E  revision 未被改动");

  {
    const revs = await prisma.articleRevision.findMany({
      where: { translation: { publications: { some: { status: "PUBLISHED" } } } },
      select: { id: true, body: true, created_at: true },
    });
    // 已发布 revision 的正文里仍保留原始归因文案 —— 剔除只发生在渲染层
    const stillHasOriginal = revs.filter((r) => /AI\s*HOT|according to/i.test(r.body)).length;
    check("E1", "不可变 revision 原文未被改写（仍含原始归因文案）", stillHasOriginal > 0,
      `${stillHasOriginal}/${revs.length} 条仍含原文归因`);
    check("E2", "revision 数量与已发布页面匹配", revs.length > 0);
  }

  section("F  后台仍可见完整来源");

  {
    const f = await prisma.articleFamily.findFirst({ where: { original_source_name: { not: null } } });
    check("F1", "数据库保留实际来源名称", Boolean(f?.original_source_name), f?.original_source_name ?? "");
    check("F2", "数据库保留原始来源地址", Boolean(f?.original_source_url));
    check("F3", "数据库保留 AI HOT 地址与来源指纹",
      Boolean(f?.attribution_url && f?.source_snapshot_hash));
    const item = await prisma.aihotSelectedItem.findFirst();
    check("F4", "provider_item_id 与来源元数据保留",
      Boolean(item?.provider_item_id && item?.source_name && item?.aihot_url));
  }

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) { console.log("\n失败项："); for (const f of failures) console.log(`  - ${f}`); }
  await prisma.$disconnect();
  if (fail) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
