/**
 * 为所有 Website 幂等创建 ToolLifecycleState（A3）。
 *
 *   npx ts-node --project tsconfig.script.json scripts/init-lifecycle-states.ts          # dry-run
 *   npx ts-node --project tsconfig.script.json scripts/init-lifecycle-states.ts --apply  # 写库
 *
 * 三条刻意的约束：
 *   1. 默认 dry-run —— 写库要显式 --apply
 *   2. next_check_at 在未来 0–7 天内均匀打散，否则 3 万条会全挤在同一天到期
 *   3. 只生成候选 tier，**不**自动把前 300 条锁成 featured ——
 *      featured 意味着周期性 AI 改写 + 人工审核，那是编辑决定，不是脚本决定
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const SPREAD_DAYS = 7;
const FEATURED_CANDIDATES = 300;

function spreadNextCheck(index: number, total: number): Date {
  // 按序号线性铺开再加抖动，避免整点尖峰
  const ratio = total <= 1 ? 0 : index / total;
  const offsetMs = ratio * SPREAD_DAYS * 86_400_000 + Math.random() * 3_600_000;
  return new Date(Date.now() + offsetMs);
}

async function main() {
  const websites = await prisma.website.findMany({
    select: { id: true, visits: true },
    orderBy: [{ visits: "desc" }, { id: "asc" }],
  });

  const existing = await prisma.toolLifecycleState.findMany({
    select: { website_id: true },
  });
  const have = new Set(existing.map((e) => e.website_id));

  type Row = { website_id: number; tier: string; next_check_at: Date };
  const toCreate: Row[] = [];
  const tally = { featured_candidate: 0, standard: 0, longtail: 0 };

  websites.forEach((site, index) => {
    // 候选分层：前 N 名标 featured_candidate（**不是** featured，也不锁定）
    const tier =
      index < FEATURED_CANDIDATES && site.visits > 0
        ? "featured_candidate"
        : site.visits > 0
          ? "standard"
          : "longtail";
    tally[tier as keyof typeof tally]++;
    if (have.has(site.id)) return;
    toCreate.push({
      website_id: site.id,
      tier,
      next_check_at: spreadNextCheck(index, websites.length),
    });
  });

  console.log(`websites ${websites.length} · 已有 state ${have.size} · 待创建 ${toCreate.length}`);
  console.log(
    `候选分层: featured_candidate ${tally.featured_candidate} · standard ${tally.standard} · longtail ${tally.longtail}`
  );
  console.log("（featured_candidate 只是候选，tier_locked 一律 false，不会自动进入深度更新池）");

  // 打散校验：按天分组不应出现尖峰
  const byDay = new Map<string, number>();
  for (const row of toCreate) {
    const key = row.next_check_at.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  if (byDay.size) {
    console.log("\nnext_check_at 分布:");
    for (const [day, n] of [...byDay.entries()].sort()) console.log(`  ${day}  ${n}`);
  }

  if (!APPLY) {
    console.log("\n[dry-run] 加 --apply 才写库");
    return;
  }
  if (!toCreate.length) {
    console.log("\n无需创建");
    return;
  }

  let created = 0;
  const CHUNK = 500;
  for (let i = 0; i < toCreate.length; i += CHUNK) {
    const batch = toCreate.slice(i, i + CHUNK);
    const res = await prisma.toolLifecycleState.createMany({
      data: batch,
      skipDuplicates: true, // 幂等：重复执行不会报错也不会重复插
    });
    created += res.count;
  }

  const total = await prisma.toolLifecycleState.count();
  console.log(`\n已创建 ${created} 条，当前 state 总数 ${total}（websites ${websites.length}）`);
  if (total !== websites.length) {
    console.log("⚠ state 数与 website 数不一致，请人工核对");
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
