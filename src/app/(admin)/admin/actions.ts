import { prisma } from "@/lib/db/db";

export async function getWebsites() {
  try {
    const websites = await prisma.website.findMany({
      /*
       * **不要取 thumbnail_base64。**
       *
       * 那一列是内联的 base64 图片：429 行里它一个人就占 3.4MB（全表 3.6MB 的 95%），
       * 整表查询要跑 112 秒，一条连接被它占满两分钟。连接池只有 5 条，
       * 再来一两个并发请求就全被它拖住，其余查询直接 P2024 超时 ——
       * 表现出来就是「登录之后后台打不开」，看着像登录坏了，其实是这一列。
       *
       * 而且这些字节**根本没人用**：WebsiteThumbnail 虽然声明了
       * thumbnail_base64 这个 prop，函数体里把它解构掉之后从头到尾没有引用，
       * 图片实际走的是 thumbnailCacheMap。取回来只是白花两分钟再扔掉。
       *
       * 用 omit 而不是 select：列表用到的字段很多，用 select 逐个列举，
       * 以后加字段忘了同步就会缺数据；omit 只排除这一列，其余照旧。
       */
      omit: { thumbnail_base64: true },
      orderBy: {
        created_at: "desc",
      },
    });
    return websites;
  } catch (error) {
    console.error("Error fetching websites:", error);
    return [];
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
