import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  BulletList,
  DetailCard,
  NumberedList,
  ResourceDetailLayout,
} from "@/components/resources/resource-detail-layout";
import { Card } from "@/ui/common/card";
import {
  getResourceBySlug,
  resourceContentToDetailItem,
} from "@/lib/resources/resource-content";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface TutorialDetailPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: TutorialDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  const resource = await getResourceBySlug("TUTORIAL", slug);

  return {
    title: resource ? `${resource.title} - AI Tutorials` : "AI Tutorials",
    description: resource?.summary ?? "AI tutorials from AskWalle AI Hub.",
  };
}

export default async function TutorialDetailPage({
  params,
}: TutorialDetailPageProps) {
  const { slug } = await params;
  const resource = await getResourceBySlug("TUTORIAL", slug);

  if (!resource) {
    notFound();
  }

  const item = resourceContentToDetailItem(resource);
  const outcome = item.outcome || item.summary;
  const prerequisites = [
    "A real task or workflow to test against.",
    "Access to the AI tool or assistant you want to use.",
    "A few minutes to review and edit the output critically.",
  ];
  const nextSteps = [
    "Save the workflow as a reusable checklist.",
    "Test the same process on one more example.",
    "Compare the result with a manual version before relying on it.",
  ];

  return (
    <ResourceDetailLayout
      item={item}
      backHref="/tutorials"
      backLabel="Back to tutorials"
      eyebrow="AI Tutorial"
      meta={
        <>
          <span className="rounded-full border border-border/80 bg-white px-3 py-1 dark:bg-card">{item.level}</span>
          <span className="rounded-full border border-border/80 bg-white px-3 py-1 dark:bg-card">{item.estimatedTime || "Tutorial"}</span>
        </>
      }
      sidebar={
        <Card className="rounded-xl border-border/80 bg-white p-4 shadow-sm shadow-slate-900/[0.03] dark:bg-card">
          <h2 className="font-semibold text-slate-950 dark:text-foreground">
            Learning goal
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-muted-foreground">
            {outcome}
          </p>
        </Card>
      }
    >
      <DetailCard title="Learning goal">
        <p>{outcome}</p>
      </DetailCard>
      <DetailCard title="Prerequisites">
        <BulletList items={prerequisites} />
      </DetailCard>
      <DetailCard title="Steps">
        <NumberedList items={item.steps || []} />
      </DetailCard>
      <DetailCard title="Guide notes">
        <p>{item.analysis}</p>
      </DetailCard>
      {item.detailSections.map((section) => (
        <DetailCard key={section.heading} title={section.heading}>
          <p>{section.body}</p>
        </DetailCard>
      ))}
      <DetailCard title="Next steps">
        <BulletList items={nextSteps} />
      </DetailCard>
    </ResourceDetailLayout>
  );
}
