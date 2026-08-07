// Next.js 启动钩子：每个服务进程只执行一次
export async function register() {
  // 只在 Node 运行时启动后台 worker（edge / 构建期不启）
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startJobWorker } = await import("@/lib/website/job-worker");
  startJobWorker();

  /*
   * 定时任务在这里注册（以前在 app/layout.tsx 的渲染路径里，不可靠）。
   * 生产才启：开发热重载会反复触发 register，定时任务没有意义还会干扰。
   *
   * **无服务器平台上不注册。** 那里没有常驻进程：函数实例随时被冻结、
   * 回收，`cron` 包的定时器活不到下一次触发，等于永远不会跑；
   * 而每次冷启动又会重新注册一遍，偶尔真的撞上一次触发的话，
   * 就是一次没人预期到的运行。那边改由平台的 Cron 打
   * /api/cron/aihot 来推进 —— 租约仍然是并发收敛的唯一依据，
   * 所以两条路径即使同时存在也不会重复干活，但没必要留着这份不确定。
   */
  if (process.env.NODE_ENV === "production" && !process.env.VERCEL) {
    const { startCronJobs } = await import("@/lib/tasks/cron");
    startCronJobs();
  }
}
