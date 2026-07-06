import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CopyPromptButton } from "@/components/resources/copy-prompt-button";
import {
  BulletList,
  DetailCard,
  ResourceDetailLayout,
} from "@/components/resources/resource-detail-layout";
import { Card } from "@/ui/common/card";
import {
  getResourceBySlug,
  resourceContentToDetailItem,
} from "@/lib/resources/resource-content";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PromptDetailPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: PromptDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  const resource = await getResourceBySlug("PROMPT", slug);

  return {
    title: resource ? `${resource.title} - Prompt Library` : "Prompt Library",
    description: resource?.summary ?? "Prompt library from AskWalle AI Hub.",
  };
}

export default async function PromptDetailPage({ params }: PromptDetailPageProps) {
  const { slug } = await params;
  const resource = await getResourceBySlug("PROMPT", slug);

  if (!resource) {
    notFound();
  }

  const item = resourceContentToDetailItem(resource);
  const useCase = item.useCase || item.category;
  const promptText = item.promptText || item.summary;
  const variations = [
    `Make it more concise for ${useCase.toLowerCase()}.`,
    "Ask for a table output with owner, priority, and confidence columns.",
    "Add a final section that lists assumptions and missing context.",
  ];

  return (
    <ResourceDetailLayout
      item={item}
      backHref="/prompts"
      backLabel="Back to prompts"
      eyebrow="Prompt Library"
      meta={<span className="rounded-full border border-border/80 bg-white px-3 py-1 dark:bg-card">{item.difficulty || "Prompt"}</span>}
      sidebar={
        <Card className="rounded-xl border-border/80 bg-white p-4 shadow-sm shadow-slate-900/[0.03] dark:bg-card">
          <h2 className="font-semibold text-slate-950 dark:text-foreground">
            Use case
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-muted-foreground">
            {useCase}
          </p>
          <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-muted-foreground">
            Example input: {item.exampleInput || "Add your own task context before using this prompt."}
          </p>
        </Card>
      }
    >
      <DetailCard title="Prompt text">
        <div className="rounded-xl border border-border/80 bg-slate-950 p-4 shadow-inner dark:bg-background">
          <p className="whitespace-pre-wrap font-mono text-sm leading-7 text-slate-100">
            {promptText}
          </p>
        </div>
        <div className="mt-4">
          <CopyPromptButton text={promptText} />
        </div>
      </DetailCard>
      <DetailCard title="How to use">
        <p>{item.analysis}</p>
      </DetailCard>
      {item.detailSections.map((section) => (
        <DetailCard key={section.heading} title={section.heading}>
          <p>{section.body}</p>
        </DetailCard>
      ))}
      <DetailCard title="Variations">
        <BulletList items={variations} />
      </DetailCard>
      <DetailCard title="Adaptation tips">
        <BulletList items={item.adaptationTips || []} />
      </DetailCard>
    </ResourceDetailLayout>
  );
}
