import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, BarChart3, Heart } from "lucide-react";
import { prisma } from "@/lib/db/db";
import { Badge } from "@/ui/common/badge";
import { Button } from "@/ui/common/button";
import { Card } from "@/ui/common/card";
import { WebsiteThumbnail } from "@/components/website/website-thumbnail";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface CategoryPageProps {
  params: Promise<{
    slug: string;
  }>;
}

export async function generateMetadata({ params }: CategoryPageProps) {
  const { slug } = await params;
  const category = await prisma.category.findUnique({
    where: { slug },
    select: { name: true },
  });

  if (!category) {
    return {
      title: "Category Not Found",
    };
  }

  return {
    title: `${category.name} AI Tools`,
    description: `Browse ${category.name} AI tools and discover useful products for your workflow.`,
  };
}

export default async function CategoryPage({ params }: CategoryPageProps) {
  const { slug } = await params;
  const category = await prisma.category.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      websites: {
        where: {
          status: "approved",
        },
        orderBy: [{ visits: "desc" }, { likes: "desc" }],
        select: {
          id: true,
          title: true,
          url: true,
          description: true,
          category_id: true,
          thumbnail: true,
          thumbnail_base64: true,
          active: true,
          status: true,
          visits: true,
          likes: true,
        },
      },
    },
  });

  if (!category) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-background">
      <section className="border-b border-border/70 bg-gradient-to-b from-muted/40 via-background to-background">
        <div className="container mx-auto px-4 py-10 md:py-14">
          <Button asChild variant="ghost" size="sm" className="-ml-3 mb-5 gap-2">
            <Link href="/categories">
              <ArrowLeft className="h-4 w-4" />
              All categories
            </Link>
          </Button>
          <div className="max-w-3xl">
            <Badge variant="outline" className="mb-4 bg-background px-3 py-1">
              {category.websites.length} tools
            </Badge>
            <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
              {category.name} AI Tools
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground md:text-lg">
              Browse curated AI tools in {category.name}. Compare popular
              options by visits and likes, then open the tool that fits your
              workflow.
            </p>
          </div>
        </div>
      </section>

      <main className="container mx-auto px-4 py-10 md:py-12">
        {category.websites.length === 0 ? (
          <div className="rounded-lg border bg-card p-10 text-center">
            <h2 className="text-lg font-semibold">No tools yet</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              This category does not have approved tools yet.
            </p>
            <Button asChild className="mt-5">
              <Link href="/submit">Submit Tool</Link>
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {category.websites.map((website) => (
              <Card
                key={website.id}
                className="group flex min-h-[176px] flex-col rounded-lg border-border/70 p-3 transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md"
              >
                <div className="flex items-start gap-3">
                  <WebsiteThumbnail
                    url={website.url}
                    thumbnail={website.thumbnail}
                    thumbnail_base64={website.thumbnail_base64}
                    title={website.title}
                    className="h-11 w-11 shrink-0 rounded-md"
                  />
                  <div className="min-w-0 flex-1">
                    <h2 className="line-clamp-1 text-sm font-semibold group-hover:text-primary">
                      {website.title}
                    </h2>
                    <Badge variant="secondary" className="mt-1 px-2 py-0 text-[11px]">
                      {category.name}
                    </Badge>
                  </div>
                </div>
                <p className="mt-3 line-clamp-2 min-h-[40px] text-xs leading-5 text-muted-foreground">
                  {website.description}
                </p>
                <div className="mt-auto flex items-center justify-between border-t border-border/60 pt-3">
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <BarChart3 className="h-3.5 w-3.5" />
                      {website.visits}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Heart className="h-3.5 w-3.5" />
                      {website.likes}
                    </span>
                  </div>
                  <Button asChild size="sm" className="h-8 gap-1.5 px-2.5 text-xs">
                    <a href={website.url} target="_blank" rel="noopener noreferrer">
                      Visit
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
