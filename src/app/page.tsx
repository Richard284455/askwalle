import { prisma } from "@/lib/db/db";
import HomePage from "@/app/home-page";
import { cachedPrismaQuery } from "@/lib/db/cache";
import type { Category, Website } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Home() {
  const startTime = Date.now();

  let categoriesData: Category[] = [];
  let websitesData: Website[] = [];

  try {
    // 分类数据可以长时间缓存
    categoriesData = await cachedPrismaQuery(
      "all-categories",
      () =>
        prisma.category.findMany({
          select: {
            id: true,
            name: true,
            slug: true,
          },
        }),
      { ttl: 604800 } // 1周缓存（秒）
    );

    // 网站数据不缓存或短缓存，确保 active 状态实时更新
    // 由于 serverless 环境下内存缓存不生效，这里直接查询数据库
    websitesData = await prisma.website.findMany({
      where: { status: "approved" },
      orderBy: {
        created_at: "desc",
      },
      select: {
        id: true,
        title: true,
        url: true,
        description: true,
        category_id: true,
        thumbnail: true,
        thumbnail_base64: true,
        status: true,
        visits: true,
        likes: true,
        active: true,
      },
    });
  } catch (error) {
    console.error(
      "[Home] Database query failed while loading public homepage data."
    );
  }

  const endTime = Date.now();
  console.log(`数据加载耗时: ${endTime - startTime}ms`);

  // 预处理数据，减少客户端计算
  const preFilteredWebsites = websitesData.map((website) => ({
    ...website,
    searchText: `${website.title.toLowerCase()} ${website.description.toLowerCase()}`,
  }));

  return (
    <HomePage
      initialWebsites={preFilteredWebsites}
      initialCategories={categoriesData}
    />
  );
}
