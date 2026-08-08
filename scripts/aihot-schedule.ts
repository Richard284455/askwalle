/**
 * AI HOT 定时任务的手动/外部触发入口。
 *
 *   npm run aihot:schedule                        # 三类各跑一轮
 *   npm run aihot:schedule -- --task hot-topics   # 只跑热点
 *   npm run aihot:schedule -- --dry-run           # 只取不写、不调 provider
 *   npm run aihot:schedule -- --max-units 3       # 限制本轮生成的内容单元数
 *   npm run aihot:schedule -- --retry-failed      # 忽略失败冷却，立刻重试卡住的单元
 *   npm run aihot:schedule -- --runs 10           # 只看最近的运行审计，不执行
 *
 * 进程内 cron 之外还留这个入口，是因为多实例部署时常常改用外部调度。
 * 租约保证两边同时来也只有一个能推进。
 *
 * **线上就是走这条路。** 站点部署在无服务器平台上，那里的函数有硬性时长
 * 上限（Hobby 60 秒），而实测单个内容单元要 65–245 秒 —— 一个都放不下。
 * 所以调度交给 GitHub Actions（见 .github/workflows/aihot-schedule.yml），
 * 由它按节奏跑这个脚本；平台那边只服务页面。
 *
 * 会发布：自动审核判过之后就上线。发布数与「有意发布数」逐轮对账，
 * 对不上记 UNEXPECTED_PUBLICATION。
 */
import type { AihotTaskType } from "@prisma/client";

import { ALL_TASKS, recentRuns, runScheduledTask, TASK_SCHEDULE } from "@/lib/content/aihot/scheduler";
import { residualLeases } from "@/lib/content/aihot/lease";
import { prisma } from "@/lib/prisma";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

const TASK_ALIAS: Record<string, AihotTaskType> = {
  selected: "SELECTED", "hot-topics": "HOT_TOPICS", hot: "HOT_TOPICS", daily: "DAILY",
  // 未筛选流也要能单独触发 —— 它的周期由接口窗口决定，与另外三类不同步
  "items-all": "ITEMS_ALL", items: "ITEMS_ALL", all: "ITEMS_ALL",
};

function parseTasks(): AihotTaskType[] {
  const raw = val("--task");
  if (!raw) return ALL_TASKS;
  const t = TASK_ALIAS[raw.trim().toLowerCase()];
  if (!t) {
    console.error(`未知任务 "${raw}"，可选：${Object.keys(TASK_ALIAS).join(" / ")}`);
    process.exit(1);
  }
  return [t];
}

async function showRuns() {
  const limit = Number(val("--runs") ?? 20);
  const runs = await recentRuns(undefined, limit);
  console.log(`最近 ${runs.length} 轮运行\n`);
  for (const r of runs) {
    console.log(
      `  ${r.started_at.toISOString().slice(0, 19)}  ${r.task_type.padEnd(10)} ${r.status.padEnd(14)} ` +
      `${String(r.duration_ms ?? "-").padStart(6)}ms  取${r.fetched} 新${r.created} 改${r.updated} 复用${r.reused} ` +
      `304=${r.not_modified} provider=${r.provider_calls} 版本+${r.revisions_created} 入队${r.queued_for_review}` +
      (r.lease_conflict ? "  [租约冲突]" : "") +
      (r.error_code ? `  [${r.error_code}]` : "")
    );
    if (r.message) console.log(`      ${r.message}`);
  }
  const residual = await residualLeases();
  console.log(`\n未释放租约：${residual.length ? residual.map((l) => `${l.task_type}@${l.locked_by}`).join(", ") : "无"}`);
}

async function main() {
  if (has("--runs")) { await showRuns(); return; }

  const tasks = parseTasks();
  const dryRun = has("--dry-run");
  const maxUnits = val("--max-units") ? Number(val("--max-units")) : undefined;

  console.log(`AI HOT 定时任务${dryRun ? "（dry-run）" : ""}：${tasks.join(" / ")}\n`);

  let failed = 0;
  for (const t of tasks) {
    console.log(`── ${t}（${TASK_SCHEDULE[t].label}，${TASK_SCHEDULE[t].cron}）──`);
    const r = await runScheduledTask(t, {
      dryRun, maxUnits,
      // 冷却是给自动调度用的；人手点重试时不该被它挡住
      failureCooldownMs: has("--retry-failed") ? 0 : undefined,
    });
    const mark = r.status === "OK" ? "✅" : r.status === "NOT_MODIFIED" ? "＝"
      : r.status === "SKIPPED_LOCKED" ? "⏭" : "❌";
    console.log(`  ${mark} ${r.status}  ${r.durationMs}ms  run #${r.runId ?? "-"}`);
    console.log(`     抓取：取 ${r.fetched} · 新 ${r.created} · 改 ${r.updated} · 复用 ${r.reused} · 304 ${r.notModified} · 429 ${r.rateLimited} · 5xx ${r.serverError}`);
    console.log(`     生成：候选 ${r.unitsConsidered} · 新生成 ${r.unitsGenerated} · 幂等复用 ${r.unitsReused} · provider 调用 ${r.providerCalls} · QA 通过 ${r.qaPassed} / 未过 ${r.qaFailed}`);
    console.log(`     入队：家族 ${r.familiesTouched} · 新 revision ${r.revisionsCreated} · 待审 ${r.queuedForReview} · 发布 ${r.publicationsCreated}（必须为 0）`);
    if (r.message) console.log(`     ${r.message}`);
    for (const d of r.details) {
      console.log(`     · ${d.unitKey.padEnd(32)} ${d.generateStatus.padEnd(10)} provider=${d.providerCalls} 冻结=${d.freezeStatus ?? "-"} 新版本=${d.revisionsCreated}`);
    }
    if (r.status === "FAILED") failed++;
  }

  const residual = await residualLeases();
  console.log(`\n未释放租约：${residual.length ? residual.map((l) => `${l.task_type}@${l.locked_by}`).join(", ") : "无"}`);
  if (residual.length) failed++;

  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
