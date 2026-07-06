import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowUpRight, Star } from "lucide-react";
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

interface ReviewDetailPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: ReviewDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  const resource = await getResourceBySlug("REVIEW", slug);

  return {
    title: resource ? `${resource.title} - AI Tool Reviews` : "AI Tool Reviews",
    description: resource?.summary ?? "AI tool reviews from AskWalle AI Hub.",
  };
}

export default async function ReviewDetailPage({ params }: ReviewDetailPageProps) {
  const { slug } = await params;
  const resource = await getResourceBySlug("REVIEW", slug);

  if (!resource) {
    notFound();
  }

  const item = resourceContentToDetailItem(resource);
  const rating = item.rating ?? 0;

  return (
    <ResourceDetailLayout
      item={item}
      backHref="/reviews"
      backLabel="Back to reviews"
      eyebrow="AI Tool Review"
      meta={
        <span className="inline-flex items-center gap-1 rounded-full border border-border/80 bg-white px-3 py-1 dark:bg-card">
          <Star className="h-3.5 w-3.5 text-primary" />
          {rating > 0 ? `${rating.toFixed(1)} rating` : "Review"}
        </span>
      }
      sidebar={
        <Card className="rounded-xl border-border/80 bg-white p-4 shadow-sm shadow-slate-900/[0.03] dark:bg-card">
          <h2 className="font-semibold text-slate-950 dark:text-foreground">
            Verdict
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-muted-foreground">
            Best for: {item.bestFor || "Teams comparing AI workflow fit."}
          </p>
          <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-muted-foreground">
            This is an original AskWalle review framework. Validate current
            pricing, feature limits, and product claims on the official site.
          </p>
          {item.sourceUrl ? (
            <Button asChild size="sm" className="mt-4 w-full shadow-sm shadow-primary/20">
              <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="gap-2">
                Visit tool
                <ArrowUpRight className="h-4 w-4" />
              </a>
            </Button>
          ) : null}
        </Card>
      }
    >
      <DetailCard title="Best for">
        <p>{item.bestFor || "Teams comparing whether this type of AI tool fits their workflow."}</p>
      </DetailCard>
      <div className="grid gap-4 md:grid-cols-2">
        <DetailCard title="Pros">
          <BulletList items={item.pros || []} />
        </DetailCard>
        <DetailCard title="Cons">
          <BulletList items={item.cons || []} />
        </DetailCard>
      </div>
      <DetailCard title="Review analysis">
        <p>{item.analysis}</p>
      </DetailCard>
      {item.detailSections.map((section) => (
        <DetailCard key={section.heading} title={section.heading}>
          <p>{section.body}</p>
        </DetailCard>
      ))}
      <DetailCard title="Pricing note">
        <p>
          Pricing can change quickly. Treat this review as a workflow evaluation
          and confirm current plans, usage limits, and commercial terms directly
          with the tool provider.
        </p>
      </DetailCard>
      <DetailCard title="Final verdict">
        <p>
          Strong fit for teams that match the stated use case and are willing to
          verify output quality with a practical test before adopting it broadly.
        </p>
      </DetailCard>
    </ResourceDetailLayout>
  );
}
