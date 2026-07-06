import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowUpRight, Newspaper } from "lucide-react";
import {
  BulletList,
  DetailCard,
  ResourceDetailLayout,
} from "@/components/resources/resource-detail-layout";
import { Button } from "@/ui/common/button";
import { Card } from "@/ui/common/card";
import {
  getResourceBySlug,
  resourceContentToDetailItem,
} from "@/lib/resources/resource-content";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface NewsDetailPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: NewsDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  const resource = await getResourceBySlug("NEWS", slug);

  return {
    title: resource ? `${resource.title} - AI News` : "AI News",
    description: resource?.summary ?? "AI news from AskWalle AI Hub.",
  };
}

export default async function NewsDetailPage({ params }: NewsDetailPageProps) {
  const { slug } = await params;
  const resource = await getResourceBySlug("NEWS", slug);

  if (!resource) {
    notFound();
  }

  const item = resourceContentToDetailItem(resource);
  const takeaways = [
    item.analysis,
    `Primary category: ${item.category}.`,
    "Use the source link for verification before making product or policy decisions.",
  ];

  return (
    <ResourceDetailLayout
      item={item}
      backHref="/news"
      backLabel="Back to AI News"
      eyebrow="AI News"
      meta={<span className="rounded-full border border-border/80 bg-white px-3 py-1 dark:bg-card">{item.readTime || "News brief"}</span>}
      sidebar={
        <Card className="rounded-xl border-border/80 bg-white p-4 shadow-sm shadow-slate-900/[0.03] dark:bg-card">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Newspaper className="h-5 w-5" />
            </span>
            <div>
              <h2 className="font-semibold text-slate-950 dark:text-foreground">
                Original brief
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-muted-foreground">
                This page contains AskWalle original summary and analysis with
                source attribution. It does not copy the full external article.
              </p>
            </div>
          </div>
          {item.sourceUrl ? (
            <Button asChild variant="outline" size="sm" className="mt-4 w-full bg-white/70 dark:bg-background/60">
              <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="gap-2">
                Visit source
                <ArrowUpRight className="h-4 w-4" />
              </a>
            </Button>
          ) : null}
        </Card>
      }
    >
      <DetailCard title="Key takeaways">
        <BulletList items={takeaways} />
      </DetailCard>
      <DetailCard title="Analysis">
        <p>{item.analysis}</p>
      </DetailCard>
      {item.detailSections.map((section) => (
        <DetailCard key={section.heading} title={section.heading}>
          <p>{section.body}</p>
        </DetailCard>
      ))}
      <DetailCard title="Impact">
        <p>
          This update matters for teams comparing AI tools because it changes
          what they should evaluate: workflow fit, verification, governance,
          and long-term operational control.
        </p>
      </DetailCard>
    </ResourceDetailLayout>
  );
}
