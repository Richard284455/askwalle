/**
 * AI HOT 多语言内容闭环的离线测试。
 *
 *   npm run test:aihot
 *
 * **不发任何外部请求**（HTTP 全部走注入的 fixture 传输层），
 * **不调用 provider**，**不写库**，**不发布**。
 *
 * 核心命题：
 *   1. 客户端遵守 ETag / 429 Retry-After / 5xx 退避，且 304 绝不写库；
 *   2. 产出里的数字、日期、型号、专名必须能在 AI HOT 输入里找到；
 *   3. 译文只准复述母版，不准增减事实 —— 跨语言的数字写法差异不算漂移；
 *   4. 重复内容**不是**拒绝理由，DUPLICATE_EVENT 之类永不阻断。
 */
import { fetchAihot, parseRetryAfter, type AihotTransport } from "@/lib/content/aihot/client";
import { ingestDaily, ingestHotTopics, ingestSelected } from "@/lib/content/aihot/ingest";
import {
  dailyReportHash, hotTopicHash, httpUrlOrNull, isReportDate, itemIdFromAihotUrl,
  mapCategory, selectedItemHash, type AihotItemDto,
} from "@/lib/content/aihot/types";
import { aliasesOf, entityPresent, normalizeForEntityMatch } from "@/lib/content/multilingual/entity-alias";
import {
  dateCovered, dateKeys, modelTokens, normModel, numberSet, parseNumber, properTokens,
} from "@/lib/content/multilingual/linguistics";
import { checkMasterFaithfulness, checkTranslationDrift } from "@/lib/content/multilingual/qa";
import { buildMasterPrompt, buildTranslationPrompt, parseDraft } from "@/lib/content/multilingual/generate";
import {
  BLOCKING_CODES, NEVER_BLOCKING_CODES, bodyLimitFor, isBlocking, materialChars,
  type ContentUnitInput, type DraftContent,
} from "@/lib/content/multilingual/types";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(id: string, name: string, ok: boolean, detail = "") {
  if (ok) pass++; else { fail++; failures.push(`${id} ${name}${detail ? ` — ${detail}` : ""}`); }
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const section = (t: string) => console.log(`\n${t}\n`);

/** 记录所有 QA 产出的问题码，收尾时验证「永不阻断」的四个码从未出现 */
const allEmittedCodes = new Set<string>();
function recordCodes(issues: { code: string }[]) { for (const i of issues) allEmittedCodes.add(i.code); }

// ── fixture 传输层 ────────────────────────────────────────────────────────

type Step = { status: number; headers?: Record<string, string>; body?: unknown | string };
function scripted(steps: Step[]): { transport: AihotTransport; calls: () => number; seen: Record<string, string>[] } {
  let i = 0;
  const seen: Record<string, string>[] = [];
  const transport: AihotTransport = async ({ headers }) => {
    seen.push(headers);
    const s = steps[Math.min(i, steps.length - 1)];
    i++;
    if (s.status === 0) throw new Error("模拟网络中断");
    return {
      status: s.status,
      headers: s.headers ?? {},
      text: typeof s.body === "string" ? s.body : JSON.stringify(s.body ?? {}),
    };
  };
  return { transport, calls: () => i, seen };
}
const noWait = async () => {};

// ── fixture 数据 ──────────────────────────────────────────────────────────

const ITEM: AihotItemDto = {
  id: "cmtest0001aaaa",
  title: "谷歌 DeepMind 发布 Lyria 3.5 音乐生成模型",
  originalTitle: "Google DeepMind ships Lyria 3.5",
  summary: "谷歌 DeepMind 于 2026 年 7 月 31 日发布 Lyria 3.5，训练数据规模达到 4000 万首曲目。计划在第三季度向开发者开放 API。",
  source: { name: "X：阿易 AI Notes (@AYi_AInotes)" },
  links: { aihot: "https://aihot.virxact.com/items/cmtest0001aaaa", original: "https://x.com/AYi_AInotes/status/2083401614623133921" },
  publishedAt: "2026-07-31T03:57:07.000Z",
  discoveredAt: "2026-07-31T03:59:07.489Z",
  category: "ai-models",
  score: 75,
  selected: true,
  attribution: { name: "AI HOT", url: "https://aihot.virxact.com/items/cmtest0001aaaa" },
};

const UNIT: ContentUnitInput = {
  contentKind: "SELECTED",
  contentForm: "MULTILINGUAL_NEWS_BRIEF",
  unitKey: "selected:cmtest0001aaaa",
  selectedItemId: 1, hotTopicSnapshotId: null, dailyReportId: null,
  title: ITEM.title,
  sourceText: `${ITEM.title}\n原标题：${ITEM.originalTitle}\n${ITEM.summary}`,
  sections: [],
  categorySlug: "Models",
  sourceSnapshotHash: "hash0001",
  attributionName: "AI HOT",
  attributionUrl: "https://aihot.virxact.com/items/cmtest0001aaaa",
  originalSourceName: "X：阿易 AI Notes (@AYi_AInotes)",
  originalSourceUrl: "https://x.com/AYi_AInotes/status/2083401614623133921",
  publishedAt: new Date("2026-07-31T03:57:07.000Z"),
  facts: [{ label: "原始来源", value: "X：阿易 AI Notes (@AYi_AInotes)" }, { label: "AI HOT 分类", value: "ai-models" }],
};

/** 母版**不带发布者归因** —— 出处只在页面底部声明 */
const MASTER: DraftContent = {
  headline: "Google DeepMind Ships Lyria 3.5 Music Model",
  summary: "Google DeepMind released Lyria 3.5 on July 31, 2026.",
  body: "Google DeepMind released Lyria 3.5 on July 31, 2026. The model was trained on 40 million tracks. The team plans to open API access to developers in the third quarter.",
};

const clone = (d: DraftContent, patch: Partial<DraftContent>): DraftContent => ({ ...d, ...patch });

async function main() {
  section("A  API 客户端：条件请求与退避");

  {
    const { transport } = scripted([{ status: 200, headers: { etag: 'W/"v1"' }, body: { items: [] } }]);
    const r = await fetchAihot("/api/v1/hot-topics", { transport, wait: noWait });
    check("A1", "200 返回数据并带回 ETag", r.ok && r.status === 200 && r.etag === 'W/"v1"');
  }
  {
    const { transport, seen } = scripted([{ status: 304 }]);
    const r = await fetchAihot("/api/v1/hot-topics", { transport, wait: noWait, etag: 'W/"v1"' });
    check("A2", "304 不返回数据（调用方无从写库）", r.ok && r.status === 304 && r.data === null);
    check("A3", "带 etag 时发出 If-None-Match", seen[0]?.["If-None-Match"] === 'W/"v1"');
  }
  {
    const { transport, seen } = scripted([{ status: 200, body: {} }]);
    await fetchAihot("/api/v1/hot-topics", { transport, wait: noWait });
    check("A4", "无 etag 时不发 If-None-Match", seen[0]?.["If-None-Match"] === undefined);
  }
  {
    const waited: number[] = [];
    const { transport, calls } = scripted([
      { status: 429, headers: { "retry-after": "2" } },
      { status: 200, body: { items: [] } },
    ]);
    const r = await fetchAihot("/api/v1/hot-topics", { transport, wait: async (ms) => { waited.push(ms); } });
    check("A5", "429 按 Retry-After 等待后重试成功", r.ok && r.status === 200 && calls() === 2);
    check("A6", "等待时长取自 Retry-After（2s）", waited[0] === 2000, `实际 ${waited[0]}`);
  }
  {
    const { transport } = scripted([{ status: 429, headers: { "retry-after": "9999" } }]);
    const r = await fetchAihot("/api/v1/hot-topics", { transport, wait: noWait });
    check("A7", "Retry-After 过长则放弃本轮，不空转", !r.ok && r.status === 429);
  }
  {
    const waited: number[] = [];
    const { transport, calls } = scripted([
      { status: 503 }, { status: 503 }, { status: 200, body: { items: [] } },
    ]);
    const r = await fetchAihot("/api/v1/hot-topics", { transport, wait: async (ms) => { waited.push(ms); } });
    check("A8", "5xx 重试直至成功", r.ok && r.status === 200 && calls() === 3);
    check("A9", "5xx 退避是指数增长", waited.length === 2 && waited[1] === waited[0] * 2, waited.join("/"));
  }
  {
    const { transport, calls } = scripted([{ status: 500 }]);
    const r = await fetchAihot("/api/v1/hot-topics", { transport, wait: noWait, maxAttempts: 3 });
    check("A10", "5xx 耗尽重试后失败", !r.ok && calls() === 3);
  }
  {
    const { transport, calls } = scripted([{ status: 404 }]);
    const r = await fetchAihot("/api/v1/hot-topics", { transport, wait: noWait });
    check("A11", "4xx 不重试（请求写错了，重试没有意义）", !r.ok && calls() === 1);
    check("A12", "4xx 失败原因不回显响应体", !r.ok && !/requestId|detail/.test(r.reason));
  }
  {
    const { transport, calls } = scripted([{ status: 200, body: "{ 这不是 JSON" }]);
    const r = await fetchAihot("/api/v1/hot-topics", { transport, wait: noWait });
    check("A13", "响应非 JSON 时失败且不重试", !r.ok && calls() === 1);
  }
  {
    const { transport, calls } = scripted([{ status: 0 }, { status: 200, body: { items: [] } }]);
    const r = await fetchAihot("/api/v1/hot-topics", { transport, wait: noWait });
    check("A14", "网络异常后重试", r.ok && calls() === 2);
  }
  {
    const { transport, calls } = scripted([{ status: 200, body: {} }]);
    const r = await fetchAihot("/api/public/items", { transport, wait: noWait });
    check("A15", "拒绝非 v1 端点（旧 /api/public/* 不可用）", !r.ok && calls() === 0);
  }
  {
    /*
     * 用**固定**的 now，不用 Date.now()。
     * HTTP 日期只精确到秒，toUTCString() 会把毫秒截掉；now 取实时值时，
     * 跨过秒边界就会少算最多 999ms —— 这条断言因此会偶发性变红，
     * 而偶发变红的测试最终等于没有测试。
     */
    const now = Date.parse("2026-08-02T00:00:00.000Z");
    const at = new Date(now + 5000).toUTCString();
    check("A16", "Retry-After 支持 HTTP 日期", parseRetryAfter(at, now) === 5000,
      String(parseRetryAfter(at, now)));
    check("A16b", "HTTP 日期已过期时按 0 处理（不出现负等待）",
      parseRetryAfter(new Date(now - 10_000).toUTCString(), now) === 0);
  }
  check("A17", "Retry-After 缺失返回 null", parseRetryAfter(undefined) === null);

  section("B  链接与标识");

  check("B1", "合法 https 链接通过", httpUrlOrNull("https://aihot.virxact.com/items/abc") !== null);
  check("B2", "GUID 不得当链接", httpUrlOrNull("cms9udxq00qybro9kc2il6w0c") === null);
  check("B3", "UUID 不得当链接", httpUrlOrNull("550e8400-e29b-41d4-a716-446655440000") === null);
  check("B4", "hash 不得当链接", httpUrlOrNull("d41d8cd98f00b204e9800998ecf8427e") === null);
  check("B5", "相对路径不得当链接", httpUrlOrNull("/items/abc") === null);
  check("B6", "javascript: 协议被拒", httpUrlOrNull("javascript:alert(1)") === null);
  check("B7", "无点主机名被拒", httpUrlOrNull("https://localhost/items") === null);
  check("B8", "从条目页地址解析条目 ID",
    itemIdFromAihotUrl("https://aihot.virxact.com/items/cmtest0001aaaa") === "cmtest0001aaaa");
  check("B9", "非条目页地址解析为 null",
    itemIdFromAihotUrl("https://aihot.virxact.com/daily/2026-08-01") === null);

  section("C  分类映射");

  check("C1", "ai-models → Models", mapCategory("ai-models") === "Models");
  check("C2", "ai-products → Products", mapCategory("ai-products") === "Products");
  check("C3", "industry → Business & Industry", mapCategory("industry") === "Business & Industry");
  check("C4", "paper → Research", mapCategory("paper") === "Research");
  check("C5", "tip → Tutorials / Opinions", mapCategory("tip") === "Tutorials / Opinions");
  check("C6", "未知分类不猜，返回 null", mapCategory("something-new") === null);

  section("D  内容指纹");

  check("D1", "同内容指纹稳定", selectedItemHash(ITEM) === selectedItemHash({ ...ITEM }));
  check("D2", "标题变化 → 指纹变化", selectedItemHash({ ...ITEM, title: "别的标题" }) !== selectedItemHash(ITEM));
  check("D3", "摘要变化 → 指纹变化", selectedItemHash({ ...ITEM, summary: "别的摘要" }) !== selectedItemHash(ITEM));
  check("D4", "discoveredAt 不参与指纹（否则每轮都算新版本）",
    selectedItemHash({ ...ITEM, discoveredAt: "2030-01-01T00:00:00.000Z" }) === selectedItemHash(ITEM));
  {
    const t = { id: "t1", title: "热点", sourceCount: 14, signalCount: 27, sourceNames: ["a", "b"], links: { aihot: "https://aihot.virxact.com/items/t1" }, latestAt: "2026-08-01T00:00:00.000Z" };
    check("D5", "热点信号数变化 → 新快照", hotTopicHash({ ...t, signalCount: 28 }) !== hotTopicHash(t));
    check("D6", "热点内容不变 → 同一快照", hotTopicHash({ ...t }) === hotTopicHash(t));
  }
  {
    const d = { date: "2026-08-01", generatedAt: "2026-08-01T00:00:44.798Z", links: { aihot: "https://aihot.virxact.com/daily/2026-08-01" }, sections: [{ label: "模型", items: [{ title: "A", summary: "s" }] }] };
    check("D7", "日报栏目变化 → 指纹变化",
      dailyReportHash({ ...d, sections: [{ label: "模型", items: [{ title: "B", summary: "s" }] }] }) !== dailyReportHash(d));
  }
  check("D8", "日报日期格式校验", isReportDate("2026-08-01") && !isReportDate("2026/08/01") && !isReportDate("latest"));

  section("E  跨语言数字");

  check("E1", "英文 $40 million = 4e7", parseNumber("$40 million", "EN_US") === 4e7);
  check("E2", "中文 4000万 = 4e7", parseNumber("4000万", "SOURCE") === 4e7);
  check("E3", "日文 4000万 = 4e7", parseNumber("4000万", "JA_JP") === 4e7);
  check("E4", "日文 1億 = 1e8", parseNumber("1億", "JA_JP") === 1e8);
  check("E5", "西语 1.500 是一千五（点是千分位）", parseNumber("1.500", "ES_ES") === 1500);
  check("E6", "西语 1,5 是 1.5（逗号是小数点）", parseNumber("1,5", "ES_ES") === 1.5);
  check("E7", "英语 1,500 是一千五", parseNumber("1,500", "EN_US") === 1500);
  check("E8", "西语 billón = 1e12（不是 1e9）", parseNumber("1 billón", "ES_ES") === 1e12);
  check("E9", "西语 mil millones = 1e9", parseNumber("2 mil millones", "ES_ES") === 2e9);
  check("E10", "巴葡 bilhão = 1e9", parseNumber("1 bilhão", "PT_BR") === 1e9);
  check("E11", "百分比不参与数量级换算", parseNumber("40%", "EN_US") === 40);
  check("E12", "中文来源与英文母版数量级可比",
    numberSet("训练数据 4000 万首", "SOURCE").has(4e7) && numberSet("40 million tracks", "EN_US").has(4e7));

  section("F  跨语言日期");

  check("F1", "ISO 日期", dateKeys("2026-08-01").has("2026-08-01"));
  check("F2", "英文 August 1, 2026", dateKeys("August 1, 2026").has("2026-08-01"));
  check("F3", "中日文 2026年8月1日", dateKeys("2026年8月1日").has("2026-08-01"));
  check("F4", "西语 1 de agosto de 2026", dateKeys("1 de agosto de 2026").has("2026-08-01"));
  check("F5", "巴葡 1 de agosto de 2026", dateKeys("publicado em 1 de agosto de 2026").has("2026-08-01"));
  check("F6", "只有月日：8月1日", dateKeys("8月1日").has("--08-01"));
  check("F7", "精度降低算被覆盖（少写年份不是失真）",
    dateCovered("2026-08-01", new Set(["--08-01"])));
  check("F8", "月日可匹配到完整日期", dateCovered("--08-01", new Set(["2026-08-01"])));
  check("F9", "不同日期不算覆盖", !dateCovered("2026-08-02", new Set(["2026-08-01"])));

  section("G  型号与专名");

  check("G1", "GPT-5.6 被识别为型号", modelTokens("GPT-5.6 released").includes("GPT-5.6"));
  check("G2", "Lyria 3.5 被识别为型号", modelTokens("Lyria 3.5 model").includes("Lyria 3.5"));
  check("G3", "v1.2.3 被识别", modelTokens("upgrade to v1.2.3").includes("v1.2.3"));
  check("G4", "普通句子不被误判成型号",
    modelTokens("picks 12 Horizon projects at 25 sites on July 22").length === 0,
    modelTokens("picks 12 Horizon projects at 25 sites on July 22").join(","));
  check("G5", "不换行连字符 U+2011 与 ASCII 视为同一型号",
    normModel("GPT‑5.5") === normModel("GPT-5.5"));
  check("G6", "连续两个大写词算专名", properTokens("Google DeepMind shipped it").includes("Google DeepMind"));
  check("G7", "句首 The + 单词不算专名（剥掉功能词后不足两词）",
    !properTokens("The Company said so.").some((p) => /company/i.test(p)),
    properTokens("The Company said so.").join(","));
  check("G8", "According 开头不被当专名",
    !properTokens("According To Reuters").includes("According To"));
  check("G9", "Department of Energy 保留连接词",
    properTokens("the Department of Energy said").some((p) => /Department of Energy/.test(p)));
  // 首轮 canary 实测：中文来源写「前三」，英文母版写 Top-3，被当成型号误报
  check("G10", "Top-3 不是型号（普通词 + 数字）",
    modelTokens("Claims Top-3 Open-Source Spot").length === 0,
    modelTokens("Claims Top-3 Open-Source Spot").join(","));
  check("G11", "Part-2 / Level-4 同样不算型号",
    modelTokens("Part-2 and Level-4").length === 0);
  check("G12", "真型号不受影响", modelTokens("DeepSeek V4 Flash and GPT-5.6").includes("GPT-5.6"));

  section("H  实体别名（中文来源 → 英文母版）");

  check("H1", "谷歌 ↔ Google", aliasesOf("Google").includes("谷歌"));
  check("H2", "英伟达 ↔ Nvidia", aliasesOf("英伟达").includes("Nvidia"));
  check("H3", "别名命中中文语料",
    entityPresent("Google", normalizeForEntityMatch("谷歌发布了新模型")));
  check("H4", "未登记实体不误判为命中",
    !entityPresent("Acme Robotics", normalizeForEntityMatch("谷歌发布了新模型")));

  section("I  母版忠实度 QA");

  {
    const r = checkMasterFaithfulness(MASTER, UNIT);
    recordCodes(r.issues);
    check("I1", "忠实母版通过（中文来源→英文母版不误报）",
      r.verdict === "PASSED", r.issues.map((i) => `${i.code}:${i.detail}`).join(" | ").slice(0, 200));
  }
  {
    const r = checkMasterFaithfulness(clone(MASTER, { body: MASTER.body + " The round raised $250 million." }), UNIT);
    recordCodes(r.issues);
    check("I2", "凭空多出的金额 → NUMBER_MISMATCH", r.issues.some((i) => i.code === "NUMBER_MISMATCH"));
  }
  {
    const r = checkMasterFaithfulness(clone(MASTER, { body: MASTER.body + " A follow-up lands on March 4, 2027." }), UNIT);
    recordCodes(r.issues);
    check("I3", "凭空多出的日期 → DATE_MISMATCH", r.issues.some((i) => i.code === "DATE_MISMATCH"));
  }
  {
    const r = checkMasterFaithfulness(clone(MASTER, { body: MASTER.body.replace("Lyria 3.5", "Lyria 4.0") }), UNIT);
    recordCodes(r.issues);
    check("I4", "型号被改写 → MODEL_MISMATCH", r.issues.some((i) => i.code === "MODEL_MISMATCH"));
  }
  {
    const r = checkMasterFaithfulness(clone(MASTER, { body: MASTER.body + " NeuralWorks Labs confirmed the deal." }), UNIT);
    recordCodes(r.issues);
    check("I5", "凭空多出的机构（驼峰名）→ ENTITY_MISMATCH", r.issues.some((i) => i.code === "ENTITY_MISMATCH"));
    // 能力边界写成断言，免得后来的人以为这条闸门是全覆盖的
    const plain = checkMasterFaithfulness(clone(MASTER, { body: MASTER.body + " Global Robotics Alliance confirmed the deal." }), UNIT);
    check("I5b", "【已知边界】全是普通英文词的编造短语查不到（跨语言无法与概念译名区分）",
      !plain.issues.some((i) => i.code === "ENTITY_MISMATCH"));
  }
  {
    // 规则已反转：正文里出现发布者归因才是问题，缺少归因反而是正确的
    const r = checkMasterFaithfulness(
      clone(MASTER, { body: MASTER.body + " According to AYi_AInotes, more details are coming." }), UNIT);
    recordCodes(r.issues);
    check("I6", "正文出现发布者归因 → ATTRIBUTION_MISMATCH",
      r.issues.some((i) => i.code === "ATTRIBUTION_MISMATCH"));
    const clean = checkMasterFaithfulness(MASTER, UNIT);
    check("I6b", "不带发布者归因的母版通过", clean.verdict === "PASSED",
      clean.issues.map((i) => i.code).join(","));
  }
  {
    const planUnit: ContentUnitInput = { ...UNIT, sourceText: "谷歌 DeepMind 计划在 9 月发布 Lyria 4.0。" };
    const r = checkMasterFaithfulness(
      clone(MASTER, { summary: "Google DeepMind has released Lyria 4.0.", body: "Google DeepMind has released Lyria 4.0, according to AYi_AInotes." }), planUnit);
    recordCodes(r.issues);
    check("I7", "把计划写成已完成 → MODALITY_UPGRADE", r.issues.some((i) => i.code === "MODALITY_UPGRADE"));
  }
  {
    const r = checkMasterFaithfulness(MASTER, UNIT);
    check("I8", "来源同时含「已发布」与「计划」时不误报情态升级",
      !r.issues.some((i) => i.code === "MODALITY_UPGRADE"));
  }
  {
    const r = checkMasterFaithfulness(clone(MASTER, { body: "x".repeat(1300) }), UNIT);
    recordCodes(r.issues);
    check("I9", "正文超长 → UNSUPPORTED_DETAIL", r.issues.some((i) => i.code === "UNSUPPORTED_DETAIL"));
  }
  {
    const r = checkMasterFaithfulness(MASTER, { ...UNIT, attributionUrl: "cmtest0001aaaa" });
    recordCodes(r.issues);
    check("I10", "归因链接是 GUID → SOURCE_LINK_INVALID", r.issues.some((i) => i.code === "SOURCE_LINK_INVALID"));
  }
  {
    const r = checkMasterFaithfulness(clone(MASTER, { body: "" }), UNIT);
    recordCodes(r.issues);
    check("I11", "正文为空 → EMPTY_FIELD", r.issues.some((i) => i.code === "EMPTY_FIELD"));
  }
  {
    const r = checkMasterFaithfulness(
      clone(MASTER, { body: MASTER.body.replace("Google DeepMind", "Google DeepMind and Microsoft") }), UNIT);
    recordCodes(r.issues);
    check("I12", "别名表让「谷歌」不误报，但真新增的微软要报",
      r.issues.some((i) => i.code === "ENTITY_MISMATCH" && /Microsoft/i.test(i.detail)),
      r.issues.map((i) => i.code).join(","));
  }

  {
    /*
     * 首轮 canary 实测的误报：来源是中文「在 Artificial Analysis 智能指数上得分 50」，
     * 母版忠实地译成 "Artificial Analysis Intelligence Index"。
     * Intelligence / Index 这些被翻译过来的普通名词永远不会逐字出现在中文语料里 ——
     * 拿它们当「凭空引入的实体」，等于要求模型不许翻译名词。
     */
    const cnUnit: ContentUnitInput = {
      ...UNIT,
      sourceText: "DeepSeek 发布开源模型 DeepSeek V4 Flash 0731，在 Artificial Analysis 智能指数上得分 50，位列开源模型前三。",
      originalSourceName: "X：Artificial Analysis (@ArtificialAnlys)",
    };
    const draft: DraftContent = {
      headline: "DeepSeek V4 Flash 0731 Released as Open Weights",
      summary: "DeepSeek released the model, according to Artificial Analysis.",
      body: "According to Artificial Analysis, DeepSeek released DeepSeek V4 Flash 0731. The model scores 50 on the Artificial Analysis Intelligence Index, placing it among the top three open-source models.",
    };
    const r = checkMasterFaithfulness(draft, cnUnit);
    recordCodes(r.issues);
    check("I13", "被翻译的普通名词复合短语不算新增实体",
      !r.issues.some((i) => i.code === "ENTITY_MISMATCH"),
      r.issues.map((i) => `${i.code}:${i.snippet ?? ""}`).join(" | ").slice(0, 160));
    check("I14", "同一稿不再把 Top-3 当型号误报",
      !r.issues.some((i) => i.code === "MODEL_MISMATCH"),
      r.issues.map((i) => i.code).join(","));
  }

  section("J  译文漂移 QA");

  const ES: DraftContent = {
    headline: "Google DeepMind lanza Lyria 3.5",
    summary: "Google DeepMind lanzó Lyria 3.5 el 31 de julio de 2026.",
    body: "Google DeepMind lanzó Lyria 3.5 el 31 de julio de 2026. El modelo se entrenó con 40 millones de pistas. El equipo planea abrir el acceso a la API en el tercer trimestre.",
  };
  {
    const r = checkTranslationDrift(MASTER, ES, "ES_ES", UNIT);
    recordCodes(r.issues);
    check("J1", "忠实西语译文通过", r.verdict === "PASSED", r.issues.map((i) => i.detail).join(" | ").slice(0, 200));
  }
  {
    const JA: DraftContent = {
      headline: "Google DeepMindがLyria 3.5を公開",
      summary: "Google DeepMindは2026年7月31日にLyria 3.5を公開した。",
      body: "Google DeepMindは2026年7月31日にLyria 3.5を公開した。このモデルは4000万曲で学習された。第3四半期に開発者向けAPIを公開する計画だ。",
    };
    const r = checkTranslationDrift(MASTER, JA, "JA_JP", UNIT);
    recordCodes(r.issues);
    check("J2", "日语译文用 4000万 表达 40 million 不算漂移",
      r.verdict === "PASSED", r.issues.map((i) => i.detail).join(" | ").slice(0, 200));
  }
  {
    const bad = clone(ES, { body: ES.body.replace("40 millones", "400 millones") });
    const r = checkTranslationDrift(MASTER, bad, "ES_ES", UNIT);
    recordCodes(r.issues);
    check("J3", "数值被放大 → TRANSLATION_FACT_DRIFT", r.issues.some((i) => i.code === "TRANSLATION_FACT_DRIFT"));
  }
  {
    const bad = clone(ES, { body: ES.body.replace("40 millones de pistas", "muchas pistas") });
    const r = checkTranslationDrift(MASTER, bad, "ES_ES", UNIT);
    recordCodes(r.issues);
    check("J4", "数值被丢掉 → TRANSLATION_FACT_DRIFT", r.issues.some((i) => i.code === "TRANSLATION_FACT_DRIFT"));
  }
  {
    const bad = clone(ES, { body: ES.body.replace("Lyria 3.5", "Lyria 3.6") });
    const r = checkTranslationDrift(MASTER, bad, "ES_ES", UNIT);
    recordCodes(r.issues);
    check("J5", "型号被改 → TRANSLATION_FACT_DRIFT", r.issues.some((i) => i.code === "TRANSLATION_FACT_DRIFT"));
  }
  {
    const bad = clone(ES, { body: ES.body.replace("el 31 de julio de 2026", "el 1 de agosto de 2026") });
    const r = checkTranslationDrift(MASTER, bad, "ES_ES", UNIT);
    recordCodes(r.issues);
    check("J6", "日期被改 → TRANSLATION_FACT_DRIFT", r.issues.some((i) => i.code === "TRANSLATION_FACT_DRIFT"));
  }
  {
    // 规则已反转：译者自行补上的发布者归因才是问题
    const bad = clone(ES, { body: ES.body + " Según AYi_AInotes, hay más detalles." });
    const r = checkTranslationDrift(MASTER, bad, "ES_ES", UNIT);
    recordCodes(r.issues);
    check("J7", "译文添加发布者归因 → ATTRIBUTION_MISMATCH",
      r.issues.some((i) => i.code === "ATTRIBUTION_MISMATCH"));
  }
  {
    const bad = clone(ES, { body: ES.body + " El proyecto también contó con Nvidia." });
    const r = checkTranslationDrift(MASTER, bad, "ES_ES", UNIT);
    recordCodes(r.issues);
    check("J8", "译文凭空多出机构 → ENTITY_MISMATCH", r.issues.some((i) => i.code === "ENTITY_MISMATCH"));
  }
  {
    const r = checkTranslationDrift(MASTER, clone(ES, { body: "" }), "ES_ES", UNIT);
    recordCodes(r.issues);
    check("J9", "译文正文为空 → EMPTY_FIELD", r.issues.some((i) => i.code === "EMPTY_FIELD"));
  }
  {
    // 英文 1 billion 在巴葡是 1 bilhão；若误译成西语式 billón 就是 1000 倍失真
    const m: DraftContent = { headline: "Training Scale", summary: "AYi_AInotes reported a 1 billion track corpus.",
      body: "AYi_AInotes reported Google DeepMind trained on 1 billion tracks." };
    const ptGood: DraftContent = { headline: "Escala de treinamento", summary: "AYi_AInotes relatou um corpus de 1 bilhão de faixas.",
      body: "AYi_AInotes informou que o Google DeepMind treinou com 1 bilhão de faixas." };
    const r = checkTranslationDrift(m, ptGood, "PT_BR", UNIT);
    recordCodes(r.issues);
    check("J10", "巴葡 bilhão 正确对应 billion", !r.issues.some((i) => i.code === "TRANSLATION_FACT_DRIFT"),
      r.issues.map((i) => i.detail).join(" | ").slice(0, 160));
  }
  {
    const m: DraftContent = { headline: "Training Scale", summary: "AYi_AInotes reported a 1 billion track corpus.",
      body: "AYi_AInotes reported Google DeepMind trained on 1 billion tracks." };
    const esBad: DraftContent = { headline: "Escala de entrenamiento", summary: "AYi_AInotes informó un corpus de 1 billón de pistas.",
      body: "AYi_AInotes informó que Google DeepMind entrenó con 1 billón de pistas." };
    const r = checkTranslationDrift(m, esBad, "ES_ES", UNIT);
    recordCodes(r.issues);
    check("J11", "西语误用 billón（1e12）表示 billion（1e9）被抓出",
      r.issues.some((i) => i.code === "TRANSLATION_FACT_DRIFT"));
  }

  section("K  提示词约束");

  {
    const p = buildMasterPrompt(UNIT);
    check("K1", "母版提示词要求英文输出", /英文（en-US）|英文/.test(p) && /"headline"/.test(p));
    check("K2", "母版提示词禁止引入新事实", /不得引入材料中没有的任何事实/.test(p));
    check("K3", "母版提示词禁止把计划写成已完成", /不得把计划、预期写成已经完成的事实/.test(p));
    check("K4", "母版提示词带上 AI HOT 归因地址", p.includes(UNIT.attributionUrl));
  }
  {
    const p = buildTranslationPrompt(MASTER, "ES_ES", UNIT);
    check("K5", "译文提示词以母版为输入（不是原始来源）", p.includes(MASTER.body));
    check("K6", "译文提示词点名西语 billón 陷阱", /billón es 10\^12|billón/.test(p));
    check("K7", "译文提示词要求型号原样保留", /原样保留/.test(p));
  }
  {
    const daily: ContentUnitInput = {
      ...UNIT, contentForm: "DAILY_BRIEF", contentKind: "DAILY",
      sections: [{ label: "模型发布", items: [{ title: "A", summary: "s", sourceName: "n", url: null }] }],
    };
    const p = buildMasterPrompt(daily);
    check("K8", "日报提示词要求保留栏目顺序与数量", /保留输入栏目的原始顺序与数量/.test(p));
    check("K9", "日报提示词要求输出 sections", /"sections"/.test(p));
  }
  {
    const ht = {
      mode: "SIGNAL" as const, topicId: "t1", rank: 2, sourceCount: 14, signalCount: 27,
      sourceNames: ["A", "B"], capturedAt: new Date("2026-08-01"), latestAt: new Date("2026-08-01"),
    };
    const signal: ContentUnitInput = {
      ...UNIT, contentForm: "HOT_TOPIC_BRIEF", contentKind: "HOT_TOPIC", hotTopic: ht,
    };
    const p = buildMasterPrompt(signal);
    check("K10", "SIGNAL 提示词要求自报「这是榜单信号」", /实时热点信号简报/.test(p) && /trending topic/.test(p));
    check("K11", "SIGNAL 提示词逐条禁止补充技术/商业/背景细节",
      /严禁/.test(p) && /技术细节/.test(p) && /商业影响/.test(p) && /事件背景/.test(p));
    check("K11b", "SIGNAL 提示词给出词数带", /80–180 词/.test(p));
    const enriched = buildMasterPrompt({ ...signal, hotTopic: { ...ht, mode: "ENRICHED" } });
    check("K11c", "ENRICHED 提示词用更宽的词数带且仍禁止外推",
      /150–350 词/.test(enriched) && /不得推断影响力/.test(enriched));
    check("K11d", "两种模式的提示词不同", p !== enriched);
  }

  {
    /*
     * 日报的内容主要在分栏里，导语只有一两句。
     * 分栏若不并进正文，占产出九成的文字就完全绕过了忠实度检查。
     */
    const raw = JSON.stringify({
      headline: "AI HOT Daily", summary: "Lead sentence.", body: "Short lead.",
      sections: [
        { label: "Model Releases", body: "DeepSeek shipped a 284B parameter model." },
        { label: "Industry", body: "Regulators published new transparency rules." },
      ],
    });
    const d = parseDraft(raw);
    check("K12", "分栏内容并入正文（否则 QA 查不到栏目里的事实）",
      !!d && d.body.includes("284B") && d.body.includes("transparency rules"),
      `正文 ${d?.body.length ?? 0} 字符`);
    check("K13", "分栏结构同时另存供排版", (d?.sections?.length ?? 0) === 2);
    check("K14", "导语仍保留在正文开头", !!d && d.body.startsWith("Short lead."));
  }

  section("L  入库（注入 fixture，不写库）");

  {
    const { transport } = scripted([{ status: 200, headers: { etag: 'W/"a"' }, body: { items: [ITEM, { ...ITEM, id: "cmtest0002bbbb" }] } }]);
    const r = await ingestSelected({ transport, wait: noWait, ignoreEtag: true, dryRun: true });
    check("L1", "精选取回并计数", r.status === "OK" && r.fetched === 2 && r.created === 2);
  }
  {
    const bad = { ...ITEM, links: { aihot: "cmtest0001aaaa", original: null }, attribution: null };
    const { transport } = scripted([{ status: 200, body: { items: [bad] } }]);
    const r = await ingestSelected({ transport, wait: noWait, ignoreEtag: true, dryRun: true });
    check("L2", "归因链接非法的条目被跳过而不是入库",
      r.created === 0 && r.skipped.some((s) => /归因链接/.test(s.reason)));
  }
  {
    const { transport } = scripted([{ status: 304 }]);
    const r = await ingestSelected({ transport, wait: noWait, dryRun: true });
    check("L3", "304 → NOT_MODIFIED 且零写入", r.status === "NOT_MODIFIED" && r.created === 0 && r.updated === 0);
  }
  {
    const { transport } = scripted([{ status: 200, body: { items: [{ id: "t1", title: "热点一", links: { aihot: "https://aihot.virxact.com/items/t1" }, sourceCount: 14, signalCount: 27, sourceNames: ["a"], latestAt: "2026-08-01T00:00:00.000Z" }] } }]);
    const r = await ingestHotTopics({ transport, wait: noWait, ignoreEtag: true, dryRun: true });
    check("L4", "热点取回成功", r.status === "OK" && r.fetched === 1);
  }
  {
    const body = { report: { date: "2026-08-01", generatedAt: "2026-08-01T00:00:44.798Z",
      links: { aihot: "https://aihot.virxact.com/daily/2026-08-01" },
      attribution: { name: "AI HOT", url: "https://aihot.virxact.com/daily/2026-08-01" },
      sections: [
        { label: "模型发布/更新", items: [{ title: "A", summary: "sa", links: { aihot: "https://aihot.virxact.com/items/i1" } }] },
        { label: "行业动态", items: [{ title: "B", summary: "sb", links: { aihot: "https://aihot.virxact.com/items/i2" } }] },
      ] } };
    const { transport } = scripted([{ status: 200, body }]);
    const r = await ingestDaily({ transport, wait: noWait, ignoreEtag: true, dryRun: true });
    check("L5", "日报取回成功", r.status === "OK" && r.fetched === 1);
  }
  {
    const { transport } = scripted([{ status: 200, body: { report: { date: "latest" } } }]);
    const r = await ingestDaily({ transport, wait: noWait, ignoreEtag: true, dryRun: true });
    check("L6", "日报日期非法则拒绝入库", r.status === "FAILED");
  }

  section("N  篇幅上限按素材量成比例");

  {
    /*
     * 中文素材 → 英文母版的字符膨胀比实测 1.61~3.17（中位 2.30）。
     * 固定字符上限在跨语言链路上是错的度量单位 —— 卡住的是中英换算，不是编造。
     */
    const small: ContentUnitInput = { ...UNIT, sourceText: "短".repeat(50), facts: [], sections: [] };
    const large: ContentUnitInput = { ...UNIT, sourceText: "长".repeat(400), facts: [], sections: [] };
    check("N1", "素材多 → 上限高", bodyLimitFor(large) > bodyLimitFor(small),
      `${bodyLimitFor(small)} → ${bodyLimitFor(large)}`);
    check("N2", "素材极少时仍有地板（不至于连一句都写不下）", bodyLimitFor(small) >= 400);
    check("N3", "精选上限有天花板", bodyLimitFor({ ...UNIT, sourceText: "长".repeat(9999) }) <= 1800);
  }
  {
    const daily: ContentUnitInput = {
      ...UNIT, contentForm: "DAILY_BRIEF", contentKind: "DAILY",
      sourceText: "素".repeat(4068), facts: [], sections: [],
    };
    const limit = bodyLimitFor(daily);
    check("N4", "4068 字符中文素材的日报上限容得下实测篇幅（5644）",
      limit >= 5644, `上限 ${limit}`);
    check("N5", "日报倍率压在实测中位（2.30）以下，必须比照直译写更短",
      limit < Math.round(4068 * 2.3), `上限 ${limit} < ${Math.round(4068 * 2.3)}`);
  }
  {
    const topic: ContentUnitInput = {
      ...UNIT, contentForm: "HOT_TOPIC_BRIEF", contentKind: "HOT_TOPIC",
      sourceText: "DeepSeek-V4-Flash 正式版 API 上线公测",
      facts: [{ label: "来源名单", value: "A、B、C、D、E、F、G、H" }, { label: "涉及来源数", value: "14" }],
      sections: [],
    };
    check("N6", "热点素材计入结构化字段", materialChars(topic) > topic.sourceText.length);
    check("N7", "热点上限收得最紧（API 不提供热点摘要）", bodyLimitFor(topic) <= 900);
  }

  section("M  产品边界：永不阻断的判断");

  check("M1", "阻断码齐备（10 个通用 + 5 个热点专属）", BLOCKING_CODES.length === 15,
    String(BLOCKING_CODES.length));
  check("M1b", "五个热点专属阻断码都在列",
    ["HOT_TOPIC_UNSUPPORTED_DETAIL", "HOT_TOPIC_SOURCE_COUNT_MISMATCH", "HOT_TOPIC_SOURCE_NAME_MISMATCH",
     "HOT_TOPIC_RANK_MISMATCH", "HOT_TOPIC_TIME_MISREPRESENTED"]
      .every((c) => (BLOCKING_CODES as string[]).includes(c)));
  for (const c of NEVER_BLOCKING_CODES) {
    check(`M2-${c}`, `${c} 不阻断`, !isBlocking(c));
  }
  check("M3", "QA 从未产出「重复/单一来源/未经外部验证/重要性低」这类结论",
    !NEVER_BLOCKING_CODES.some((c) => allEmittedCodes.has(c)),
    [...allEmittedCodes].join(","));
  {
    // 内容与既有草稿完全重复 —— 仍然必须通过
    const r = checkMasterFaithfulness(MASTER, UNIT);
    const again = checkMasterFaithfulness(MASTER, UNIT);
    check("M4", "同一份内容重复生成不被拒绝（重复不是拒绝理由）",
      r.verdict === "PASSED" && again.verdict === "PASSED");
  }

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (failures.length) { console.log("\n失败项："); for (const f of failures) console.log(`  - ${f}`); }
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
