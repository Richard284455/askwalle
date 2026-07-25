// Next.js 启动钩子：每个服务进程只执行一次
export async function register() {
  // 只在 Node 运行时启动后台 worker（edge / 构建期不启）
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startJobWorker } = await import("@/lib/website/job-worker");
  startJobWorker();
}
