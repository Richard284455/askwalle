import Link from "next/link";
import { ArrowRight, Folder, Sparkles } from "lucide-react";
import { prisma } from "@/lib/db/db";
import { Badge } from "@/ui/common/badge";
import { Button } from "@/ui/common/button";
import { Card } from "@/ui/common/card";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Find AI Tools by Category",
  description:
    "Browse AI tools by category and discover curated products for writing, coding, design, productivity, automation, and more.",
};

export default async function CategoriesPage() {
  const categories = await prisma.category.findMany({
    orderBy: {
      id: "asc",
    },
    select: {
      id: true,
      name: true,
      slug: true,
      _count: {
        select: {
          websites: true,
        },
      },
    },
  });

  const totalTools = categories.reduce(
    (total, category) => total + category._count.websites,
    0
  );

  return (
    <div className="min-h-screen bg-background">
      <section className="border-b border-border/70 bg-gradient-to-b from-muted/40 via-background to-background">
        <div className="container mx-auto px-4 py-10 md:py-14">
          <div className="max-w-3xl">
            <Badge
              variant="outline"
              className="mb-4 gap-2 border-primary/20 bg-background/80 px-3 py-1 text-primary"
            >
              <Sparkles className="h-3.5 w-3.5" />
              AI tools directory
            </Badge>
            <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
              Find AI Tools by Category
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground md:text-lg">
              Explore AI tools grouped by practical workflows, use cases, and
              product types so you can find the right tool faster.
            </p>
            <div className="mt-6 flex flex-wrap gap-3 text-sm text-muted-foreground">
              <span className="rounded-full border bg-background px-3 py-1">
                {categories.length} categories
              </span>
              <span className="rounded-full border bg-background px-3 py-1">
                {totalTools} listed tools
              </span>
            </div>
          </div>
        </div>
      </section>

      <main className="container mx-auto px-4 py-10 md:py-12">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {categories.map((category) => (
            <Link key={category.id} href={`/categories/${category.slug}`}>
              <Card className="group flex min-h-[132px] flex-col justify-between rounded-lg border-border/70 p-4 transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
                <div className="flex items-start justify-between gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Folder className="h-5 w-5" />
                  </span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
                </div>
                <div>
                  <h2 className="text-base font-semibold group-hover:text-primary">
                    {category.name}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {category._count.websites} tools
                  </p>
                </div>
              </Card>
            </Link>
          ))}
        </div>

        <div className="mt-10 rounded-lg border bg-muted/30 p-5 md:flex md:items-center md:justify-between md:p-6">
          <div>
            <h2 className="text-lg font-semibold">Want to add a new AI tool?</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Submit a tool for review and help the directory stay useful.
            </p>
          </div>
          <Button asChild className="mt-4 md:mt-0">
            <Link href="/submit">Submit Tool</Link>
          </Button>
        </div>
      </main>
    </div>
  );
}
