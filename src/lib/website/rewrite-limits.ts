/**
 * 改写批次的规模上限。单独成文件是为了让客户端组件（向导）也能引用 ——
 * tool-rewrite-batch.ts 里有 prisma 与 provider 调用，不能进客户端包。
 */

// 单批次条数上限：由用户在向导里自定义，这里只兜住极端值。
// 直连改写走后台任务分块执行（每块 1 条），批次多大都不会撑爆单个请求；
// 真正的约束是一次性投入的 AI 费用，所以上限给到 500 由人自己判断。
export const BATCH_LIMIT_MAX = 500;

// 同步直连提交（submitRewriteBatch 的 direct 分支）在一个 HTTP 请求里跑完所有
// 条目。批次上限放宽到 500 后，这条老路径会必然超时 —— 超过这个规模强制走
// 后台任务（/submit-job），而不是让请求挂死。
export const SYNC_DIRECT_MAX = 20;
