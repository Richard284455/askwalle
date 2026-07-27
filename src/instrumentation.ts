// Next.js 启动钩子：每个服务进程只执行一次
export async function register() {
  // 只在 Node 运行时启动后台 worker（edge / 构建期不启）
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startJobWorker } = await import("@/lib/website/job-worker");
  startJobWorker();

  // 定时任务在这里注册（以前在 app/layout.tsx 的渲染路径里，不可靠）。
  // 生产才启：开发热重载会反复触发 register，定时任务没有意义还会干扰。
  if (process.env.NODE_ENV === "production") {
    const { startCronJobs } = await import("@/lib/tasks/cron");
    startCronJobs();
  }
}
