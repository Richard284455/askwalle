import { prisma } from "@/lib/prisma";
import { RankingsClient } from "@/components/website/rankings-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function RankingsPage() {
  const websites = await prisma.website.findMany({
    where: {
      status: "approved",
    },
    orderBy: [{ visits: "desc" }, { likes: "desc" }, { created_at: "desc" }],
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
      category: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  });

  const rankedWebsites = websites.map((website) => ({
    ...website,
    created_at: website.created_at.toISOString(),
  }));

  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-muted/20 py-8 md:py-12">
      <div className="container mx-auto px-4">
        <RankingsClient websites={rankedWebsites} />
      </div>
    </div>
  );
}
