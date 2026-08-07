import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/db";

/**
 * 后台首页的取数。
 *
 * **筛选、计数、分页全部下推到 SQL。**
 *
 * 以前是「整表取回来，在浏览器里 filter」—— 429 行、3.6MB、112 秒，
 * 一条连接被占满两分钟，池只有 5 条，几个并发请求就把后台打成 P2024。
 * 而这一页一屏只显示几十条，其余的取回来只是为了在内存里数个数。
 *
 * 计数用 groupBy 单独算：它只回三行，不需要把行本身拉回来。
 */

/** 一页多少条。够填满一屏，又不至于让单次查询重到拖住连接 */
export const PAGE_SIZE = 24;

export type WebsiteFilter = {
  status?: string;
  categoryId?: number | null;
  /** 标题 / 网址 / 描述的模糊匹配 */
  q?: string;
  page?: number;
};

export type WebsiteListResult = {
  rows: Awaited<ReturnType<typeof queryWebsites>>;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

function buildWhere(filter: WebsiteFilter): Prisma.WebsiteWhereInput {
  const where: Prisma.WebsiteWhereInput = {};
  if (filter.status) where.status = filter.status;
  if (filter.categoryId != null) where.category_id = filter.categoryId;
  const q = filter.q?.trim();
  if (q) {
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { url: { contains: q, mode: "insensitive" } },
      { description: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

function queryWebsites(where: Prisma.WebsiteWhereInput, skip: number, take: number) {
  return prisma.website.findMany({
    where,
    /*
     * **不要取 thumbnail_base64。**
     *
     * 那一列是内联 base64 图片，429 行里它一个人就占 3.4MB（全表的 95%）。
     * 而它**根本没人渲染**：WebsiteThumbnail 声明了这个 prop，
     * 函数体里解构完就再没引用过，图片走的是 thumbnailCacheMap。
     *
     * 用 omit 而不是 select：列表用到的字段很多，select 逐个列举，
     * 以后加字段忘了同步就会缺数据；omit 只排除这一列，其余照旧。
     */
    omit: { thumbnail_base64: true },
    orderBy: { created_at: "desc" },
    skip,
    take,
  });
}

export async function getWebsites(filter: WebsiteFilter = {}): Promise<WebsiteListResult> {
  const pageSize = PAGE_SIZE;
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const where = buildWhere(filter);

  try {
    /*
     * 顺序查，不用 Promise.all —— 两条查询共用同一个池（服务端只有 5 条），
     * 并行只是把它占得更满，而这里省下的那点墙钟时间远不值一次池耗尽。
     */
    const total = await prisma.website.count({ where });
    const rows = await queryWebsites(where, (page - 1) * pageSize, pageSize);
    return {
      rows, total, page, pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  } catch (error) {
    console.error("Error fetching websites:", error);
    return { rows: [], total: 0, page, pageSize, totalPages: 1 };
  }
}

/**
 * 三个状态各有多少条。
 *
 * 单独用 groupBy 算 —— 只回三行。以前是把全表取回来再
 * `filter(...).length` 数三遍，为了三个数字付了整表的代价。
 * 注意计数**不受状态筛选影响**（否则另外两个数字永远是 0），
 * 但要跟着分类与搜索一起收窄，不然数字和列表对不上。
 */
export async function getStatusCounts(
  filter: Pick<WebsiteFilter, "categoryId" | "q"> = {}
): Promise<Record<string, number>> {
  try {
    const grouped = await prisma.website.groupBy({
      by: ["status"],
      where: buildWhere({ categoryId: filter.categoryId, q: filter.q }),
      _count: { _all: true },
    });
    const counts: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
    for (const g of grouped) counts[g.status] = g._count._all;
    return counts;
  } catch (error) {
    console.error("Error counting websites:", error);
    return { pending: 0, approved: 0, rejected: 0 };
  }
}

export async function getCategories() {
  try {
    const categories = await prisma.category.findMany({
      orderBy: {
        id: "asc",
      },
    });
    return categories;
  } catch (error) {
    console.error("Error fetching categories:", error);
    return [];
  }
}

export async function getSettings() {
  try {
    // 获取所有设置
    const settings = await prisma.setting.findMany({
      select: {
        id: true,
        key: true,
        value: true,
      },
    });

    // 转换为对象格式
    const settingsObject = settings.reduce((acc, setting) => {
      acc[setting.key] = setting.value;
      return acc;
    }, {} as Record<string, string>);

    return settingsObject;
  } catch (error) {
    console.error("Error fetching settings:", error);
    return null;
  }
}
