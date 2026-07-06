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

interface SkillDetailPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: SkillDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  const resource = await getResourceBySlug("SKILL", slug);

  return {
    title: resource ? `${resource.title} - Skills Library` : "Skills Library",
    description: resource?.summary ?? "Skills library from AskWalle AI Hub.",
  };
}

export default async function SkillDetailPage({ params }: SkillDetailPageProps) {
  const { slug } = await params;
  const resource = await getResourceBySlug("SKILL", slug);

  if (!resource) {
    notFound();
  }

  const item = resourceContentToDetailItem(resource);
  const outcome = item.outcome || item.summary;
  const relatedTools = item.relatedTools?.length
    ? item.relatedTools
    : ["An AI assistant", "A document editor", "Your source material"];
  const promptTemplates = [
    `Help me practice this workflow: ${item.title}. Ask me for the missing context first.`,
    `Review my current ${item.category.toLowerCase()} workflow and identify the highest-leverage AI assistance points.`,
    `Turn these notes into a checklist for ${outcome.toLowerCase()}`,
  ];
  const commonMistakes = [
    "Starting with a broad task instead of a narrow workflow.",
    "Skipping quality checks after the AI produces a polished answer.",
    "Using automation before the manual workflow is understood.",
  ];

  return (
    <ResourceDetailLayout
      item={item}
      backHref="/skills"
      backLabel="Back to skills"
      eyebrow="Skills Library"
      meta={
        <>
          <span className="rounded-full border border-border/80 bg-white px-3 py-1 dark:bg-card">{item.difficulty}</span>
          <span className="rounded-full border border-border/80 bg-white px-3 py-1 dark:bg-card">{item.estimatedTime || "Skill guide"}</span>
        </>
      }
      sidebar={
        <Card className="rounded-xl border-border/80 bg-white p-4 shadow-sm shadow-slate-900/[0.03] dark:bg-card">
          <h2 className="font-semibold text-slate-950 dark:text-foreground">
            Tools needed
          </h2>
          <div className="mt-3 text-sm leading-6 text-slate-600 dark:text-muted-foreground">
            <BulletList items={relatedTools} />
          </div>
        </Card>
      }
    >
      <DetailCard title="Outcome">
        <p>{outcome}</p>
      </DetailCard>
      <DetailCard title="Step-by-step workflow">
        <NumberedList items={item.steps || []} />
      </DetailCard>
      <DetailCard title="How to practice">
        <p>{item.analysis}</p>
      </DetailCard>
      {item.detailSections.map((section) => (
        <DetailCard key={section.heading} title={section.heading}>
          <p>{section.body}</p>
        </DetailCard>
      ))}
      <DetailCard title="Prompt templates">
        <BulletList items={promptTemplates} />
      </DetailCard>
      <DetailCard title="Common mistakes">
        <BulletList items={commonMistakes} />
      </DetailCard>
    </ResourceDetailLayout>
  );
}
