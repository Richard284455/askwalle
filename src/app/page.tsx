import { prisma } from "@/lib/db/db";
import HomePage from "@/app/home-page";
import { cachedPrismaQuery } from "@/lib/db/cache";
import type { Category, Website } from "@/lib/types";
import {
  getHomepageResourcePreviews,
  resourceContentToResourceItem,
} from "@/lib/resources/resource-content";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Home() {
  const startTime = Date.now();

  let categoriesData: Category[] = [];
  let websitesData: Website[] = [];
  let resourcePreviews = {
    latestNews: [],
    latestReviews: [],
    featuredPrompts: [],
    popularSkills: [],
    beginnerTutorials: [],
  };

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
        slug: true,
        url: true,
        description: true,
        category_id: true,
        thumbnail: true,
        status: true,
        visits: true,
        likes: true,
        active: true,
        created_at: true,
      },
    });

    const previews = await getHomepageResourcePreviews(3);
    resourcePreviews = {
      latestNews: previews.latestNews.map(resourceContentToResourceItem),
      latestReviews: previews.latestReviews.map(resourceContentToResourceItem),
      featuredPrompts: previews.featuredPrompts.map(resourceContentToResourceItem),
      popularSkills: previews.popularSkills.map(resourceContentToResourceItem),
      beginnerTutorials: previews.beginnerTutorials.map(resourceContentToResourceItem),
    };
  } catch (error) {
    console.warn(
      "[Home] Public homepage data unavailable; rendering fallback content."
    );
  }

  const endTime = Date.now();
  console.log(`数据加载耗时: ${endTime - startTime}ms`);

  // 预处理数据，减少客户端计算
  const preFilteredWebsites = websitesData.map((website) => ({
    ...website,
    created_at:
      website.created_at instanceof Date
        ? website.created_at.toISOString()
        : website.created_at,
    searchText: `${website.title.toLowerCase()} ${website.description.toLowerCase()}`,
  }));

  return (
    <HomePage
      initialWebsites={preFilteredWebsites}
      initialCategories={categoriesData}
      resourcePreviews={resourcePreviews}
    />
  );
}
