import { CronJob } from "cron";
import { updateWebsiteThumbnails } from "../utils/update-thumbnails";

// 定时任务只在 instrumentation.ts 里启动一次。
//
// 以前是在 app/layout.tsx 的模块顶层调 .start() —— 那是渲染路径，会随构建、
// 预渲染、多 worker 反复求值，既不保证启动也不保证只启动一次。
//
// 幂等标记挂 globalThis：Next 的 server 组件与 instrumentation 可能加载到不同的
// 模块实例，模块级变量挡不住重复注册（同 job-worker / provider 健康缓存的处理）。
const STARTED = Symbol.for("askwalle.cronStarted");

type CronGlobal = typeof globalThis & { [STARTED]?: boolean };

// 每天凌晨 3 点执行
export const thumbnailUpdateJob = new CronJob(
  "0 3 * * *",
  async () => {
    console.log("[cron] 开始执行缩略图更新任务");
    await updateWebsiteThumbnails();
    console.log("[cron] 缩略图更新任务完成");
  },
  null,
  false,
  "Asia/Shanghai"
);

/** 进程级幂等：重复调用只注册一次 */
export function startCronJobs(): void {
  const g = globalThis as CronGlobal;
  if (g[STARTED]) return;
  g[STARTED] = true;

  thumbnailUpdateJob.start();
  console.log(
    "[cron] 已注册定时任务: thumbnailUpdateJob (0 3 * * * Asia/Shanghai)"
  );
}
