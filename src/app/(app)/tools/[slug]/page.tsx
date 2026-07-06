import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  Compass,
  ExternalLink,
  Heart,
  Plus,
} from "lucide-react";
import { prisma } from "@/lib/prisma";
import WebsiteGrid from "@/components/website/website-grid";
import { ToolVisitButton } from "@/components/website/tool-visit-button";
import { WebsiteThumbnail } from "@/components/website/website-thumbnail";
import {
  createToolSlug,
  getToolIdFromSlug,
  TOOL_INDEX_LETTERS,
} from "@/lib/website/tool-index";
import { thumbnailCacheMap } from "@/lib/website/thumbnail-cache-map";
import { Badge } from "@/ui/common/badge";
import { Button } from "@/ui/common/button";
import { Card } from "@/ui/common/card";
import type { Category, Website } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface ToolsSlugPageProps {
  params: Promise<{
    slug: string;
  }>;
}

function normalizeLetter(value: string) {
  return value.trim().charAt(0).toUpperCase();
}

function isLetterSlug(value: string) {
  return value.trim().length === 1 && TOOL_INDEX_LETTERS.includes(normalizeLetter(value));
}

function formatDate(value?: Date | string | null) {
  if (!value) return "Not specified";

  return new Date(value).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function toPublicWebsite(website: Website & { created_at?: Date | string }) {
  return {
    ...website,
    created_at:
      website.created_at instanceof Date
        ? website.created_at.toISOString()
        : website.created_at,
  };
}

function truncateDescription(value?: string | null, maxLength = 155) {
  if (!value) return "Explore AI tool details, category, usage notes, and related tools on AskWalle AI Hub.";

  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) return normalized;

  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function getCachedThumbnailImage(website: {
  url: string;
  thumbnail: string | null;
}) {
  const keys = [
    website.thumbnail,
    website.url,
    getFaviconUrl(website.url),
    getIconHorseUrl(website.url),
  ].filter((key): key is string => Boolean(key));

  for (const key of keys) {
    const cachedPath = thumbnailCacheMap[key];

    if (cachedPath) return cachedPath;
  }

  return undefined;
}

function getFaviconUrl(value: string) {
  try {
    return new URL("/favicon.ico", value).toString();
  } catch {
    return "";
  }
}

function getIconHorseUrl(value: string) {
  try {
    const hostname = new URL(value).hostname;
    return `https://icon.horse/icon/${hostname}`;
  } catch {
    return "";
  }
}

const getApprovedWebsiteById = cache(async (id: number) => {
  return prisma.website.findFirst({
    where: {
      id,
      status: "approved",
    },
    select: {
      ...websiteSelect,
      category: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  });
});

export async function generateMetadata({
  params,
}: ToolsSlugPageProps): Promise<Metadata> {
  const { slug } = await params;

  if (isLetterSlug(slug)) {
    const letter = normalizeLetter(slug);
    return {
      title: `${letter} AI Tools - AskWalle AI Hub`,
      description: `Browse approved AI tools starting with ${letter}.`,
    };
  }

  const id = getToolIdFromSlug(slug);

  if (!id) {
    return {
      title: "AI Tool Details | AskWalle AI Hub",
      description: "Explore AI tool details, category, usage notes, and related tools on AskWalle AI Hub.",
    };
  }

  const website = await getApprovedWebsiteById(id);

  if (!website) {
    return {
      title: "AI Tool Details | AskWalle AI Hub",
      description: "Explore AI tool details, category, usage notes, and related tools on AskWalle AI Hub.",
    };
  }

  const title = `${website.title} - AI Tool Details | AskWalle AI Hub`;
  const description = truncateDescription(website.description);
  const image = getCachedThumbnailImage(website);

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      ...(image
        ? {
            images: [
              {
                url: image,
                alt: `${website.title} thumbnail`,
              },
            ],
          }
        : {}),
    },
  };
}

export default async function ToolsSlugPage({ params }: ToolsSlugPageProps) {
  const { slug } = await params;

  if (isLetterSlug(slug)) {
    return <ToolsLetterPage slug={slug} />;
  }

  return <ToolDetailPage slug={slug} />;
}

async function ToolsLetterPage({ slug }: { slug: string }) {
  const letter = normalizeLetter(slug);
  let websites: Website[] = [];
  let categories: Category[] = [];

  try {
    const [websiteData, categoryData] = await Promise.all([
      prisma.website.findMany({
        where: {
          status: "approved",
          title: {
            startsWith: letter,
            mode: "insensitive",
          },
        },
        orderBy: {
          title: "asc",
        },
        select: websiteSelect,
      }),
      prisma.category.findMany({
        orderBy: {
          name: "asc",
        },
        select: {
          id: true,
          name: true,
          slug: true,
        },
      }),
    ]);

    websites = websiteData.map(toPublicWebsite);
    categories = categoryData;
  } catch (error) {
    console.warn("[ToolsLetterPage] Public tools letter data unavailable.");
  }

  return (
    <div className="min-h-screen bg-background">
      <section className="border-b border-border/70 bg-gradient-to-b from-muted/40 via-background to-background">
        <div className="container mx-auto px-4 py-8 md:py-12">
          <Button asChild variant="ghost" size="sm" className="-ml-3 mb-5 gap-2">
            <Link href="/tools">
              <ArrowLeft className="h-4 w-4" />
              Back to A-Z index
            </Link>
          </Button>

          <div className="mx-auto max-w-4xl text-center">
            <Badge variant="outline" className="mb-4 bg-background px-3 py-1">
              Letter {letter}
            </Badge>
            <h1 className="text-3xl font-semibold tracking-normal md:text-5xl">
              {letter} AI Tools
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-muted-foreground md:text-base">
              Explore approved AI tools whose names start with {letter}.
            </p>
          </div>
        </div>
      </section>

      <main className="container mx-auto px-4 py-8 md:py-10">
        <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-medium uppercase text-primary">
              A-Z index
            </p>
            <h2 className="mt-1 text-2xl font-semibold">
              {websites.length} tools starting with {letter}
            </h2>
          </div>
          <Button asChild variant="outline" size="sm" className="w-full md:w-auto">
            <Link href="/submit" className="gap-2">
              <Plus className="h-4 w-4" />
              Submit Tool
            </Link>
          </Button>
        </div>

        {websites.length > 0 ? (
          <WebsiteGrid websites={websites} categories={categories} />
        ) : (
          <Card className="rounded-lg px-5 py-12 text-center shadow-sm">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Compass className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-lg font-semibold">
              No tools found for {letter}
            </h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              Approved tools starting with this letter will appear here once
              they are available.
            </p>
            <Button asChild className="mt-5">
              <Link href="/tools">View all tools</Link>
            </Button>
          </Card>
        )}
      </main>
    </div>
  );
}

async function ToolDetailPage({ slug }: { slug: string }) {
  const id = getToolIdFromSlug(slug);

  if (!id) {
    notFound();
  }

  let website:
    | (Website & {
        category: Category | null;
        created_at: Date | string;
      })
    | null = null;
  let relatedTools: Website[] = [];
  let categories: Category[] = [];

  try {
    website = await getApprovedWebsiteById(id);

    if (!website) {
      notFound();
    }

    const [relatedData, categoryData] = await Promise.all([
      prisma.website.findMany({
        where: {
          status: "approved",
          category_id: website.category_id,
          id: {
            not: website.id,
          },
        },
        orderBy: [{ visits: "desc" }, { likes: "desc" }],
        take: 6,
        select: websiteSelect,
      }),
      prisma.category.findMany({
        where: {
          id: website.category_id,
        },
        select: {
          id: true,
          name: true,
          slug: true,
        },
      }),
    ]);

    relatedTools = relatedData.map(toPublicWebsite);
    categories = categoryData;
  } catch (error) {
    console.warn("[ToolDetailPage] Public tool detail data unavailable.");
    notFound();
  }

  const category = website.category;
  const categoryHref = category ? `/categories/${category.slug}` : "/categories";

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-background">
      <section className="border-b border-border/70 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_58%,#f1f5f9_100%)] dark:bg-[linear-gradient(180deg,hsl(var(--background))_0%,hsl(var(--card))_100%)]">
        <div className="container mx-auto px-4 py-8 md:py-12">
          <nav className="mb-6 flex flex-wrap items-center gap-2 text-sm text-slate-500 dark:text-muted-foreground">
            <Link href="/" className="hover:text-primary">
              Home
            </Link>
            <span>/</span>
            <Link href="/tools" className="hover:text-primary">
              AI Tools
            </Link>
            <span>/</span>
            <Link href={categoryHref} className="hover:text-primary">
              {category?.name || "Category"}
            </Link>
            <span>/</span>
            <span className="text-slate-950 dark:text-foreground">{website.title}</span>
          </nav>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
            <div className="rounded-xl border border-border/80 bg-white p-5 shadow-sm shadow-slate-900/[0.04] dark:bg-card md:p-6">
              <div className="flex flex-col gap-5 sm:flex-row">
                <WebsiteThumbnail
                  url={website.url}
                  thumbnail={website.thumbnail}
                  thumbnail_base64={website.thumbnail_base64}
                  title={website.title}
                  className="h-20 w-20 shrink-0 rounded-xl border border-border/80 bg-white shadow-sm dark:bg-background"
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap gap-2">
                    <Badge
                      variant="secondary"
                      className="bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground"
                    >
                      {category?.name || "Uncategorized"}
                    </Badge>
                    <Badge variant="outline" className="gap-1.5 border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Approved
                    </Badge>
                    <Badge variant="outline" className="border-border/80 bg-white/70 dark:bg-background/60">
                      {website.active ? "Website reachable" : "Status unknown"}
                    </Badge>
                  </div>
                  <h1 className="mt-4 text-3xl font-semibold tracking-normal text-slate-950 md:text-5xl dark:text-foreground">
                    {website.title}
                  </h1>
                  <p className="mt-4 max-w-3xl text-sm leading-6 text-slate-600 md:text-base dark:text-muted-foreground">
                    {website.description}
                  </p>
                  <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                    <ToolVisitButton
                      websiteId={website.id}
                      url={website.url}
                      className="gap-2 shadow-sm shadow-primary/20"
                    />
                    <Button asChild variant="outline" size="lg" className="bg-white/70 dark:bg-background/60">
                      <Link href={categoryHref}>Browse category</Link>
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <Card className="rounded-xl border-border/80 bg-white p-4 shadow-sm shadow-slate-900/[0.04] dark:bg-card">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-semibold text-slate-950 dark:text-foreground">
                  Quick info
                </h2>
                <Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary">
                  Directory listing
                </Badge>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <Metric label="Visits" value={website.visits.toLocaleString()} icon={BarChart3} />
                <Metric label="Likes" value={website.likes.toLocaleString()} icon={Heart} />
              </div>
              <div className="mt-4 space-y-3 border-t border-border/60 pt-4">
                <InfoRow label="Category" value={category?.name || "Uncategorized"} />
                <InfoRow label="Added date" value={formatDate(website.created_at)} />
                <InfoRow
                  label="Website status"
                  value={website.active ? "Reachable" : "Status unknown"}
                />
                <InfoRow label="Pricing" value="Not specified" />
              </div>
              <ToolVisitButton
                websiteId={website.id}
                url={website.url}
                size="default"
                className="mt-5 w-full gap-2 shadow-sm shadow-primary/20"
              />
            </Card>
          </div>
        </div>
      </section>

      <main className="container mx-auto space-y-10 px-4 py-8 md:py-10">
        <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-6">
            <DetailSection title={`What is ${website.title}?`}>
              <p>
                {website.title} is listed in AskWalle AI Hub as an approved AI
                tool in the {category?.name || "Uncategorized"} category. The
                directory description says: {website.description}
              </p>
              <p className="mt-3">
                This overview uses existing directory metadata only. Verify
                current features, pricing, availability, and terms on the
                official website before adopting the tool.
              </p>
            </DetailSection>

            <DetailSection title="How to use">
              <ol className="space-y-3">
                {[
                  "Open the official website using the Visit Website button.",
                  "Review the tool's current features, pricing, account requirements, and usage limits.",
                  "Try the tool with a small, low-risk workflow before using it for important work.",
                  "Compare the output with related tools in the same category before deciding.",
                ].map((step, index) => (
                  <li key={step} className="flex gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-semibold text-primary">
                      {index + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </DetailSection>
          </div>

          <Card className="h-fit rounded-xl border-border/80 bg-white p-4 shadow-sm shadow-slate-900/[0.04] dark:bg-card">
            <h2 className="font-semibold text-slate-950 dark:text-foreground">
              Evaluation notes
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-muted-foreground">
              AskWalle lists this tool for discovery and comparison. Product
              capabilities can change, so use the official site as the source
              of truth before buying or deploying it.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-4 w-full bg-white/70 dark:bg-background/60">
              <Link href={categoryHref}>Browse more in category</Link>
            </Button>
          </Card>
        </section>

        <section>
          <SectionHeader
            eyebrow="Related tools"
            title={`More ${category?.name || "AI"} tools`}
            description="Explore other approved AI tools from the same category."
          />
          {relatedTools.length > 0 ? (
            <WebsiteGrid websites={relatedTools} categories={categories} />
          ) : (
            <Card className="mt-5 rounded-lg border-border/80 bg-white p-8 text-center text-sm text-slate-600 shadow-sm shadow-slate-900/[0.03] dark:bg-card dark:text-muted-foreground">
              No related tools are available in this category yet.
            </Card>
          )}
        </section>

        <section className="overflow-hidden rounded-xl border border-primary/15 bg-[linear-gradient(135deg,#ffffff_0%,#eff6ff_55%,#eef2ff_100%)] px-5 py-8 shadow-sm shadow-slate-900/[0.04] dark:bg-[linear-gradient(135deg,hsl(var(--card))_0%,hsl(var(--background))_100%)] md:px-8 md:py-10">
          <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-white px-3 py-1 text-sm font-medium text-primary shadow-sm dark:bg-card">
                <ExternalLink className="h-3.5 w-3.5" />
                Official website
              </div>
              <h2 className="text-2xl font-semibold text-slate-950 md:text-3xl dark:text-foreground">
                Ready to evaluate {website.title}?
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 md:text-base dark:text-muted-foreground">
                Visit the official site to verify current product details, then
                compare it with more tools in {category?.name || "this category"}.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <ToolVisitButton
                websiteId={website.id}
                url={website.url}
                className="gap-2 shadow-sm shadow-primary/20"
              />
              <Button asChild variant="outline" size="lg" className="gap-2 bg-white/70 dark:bg-background/60">
                <Link href={categoryHref}>
                  Browse category
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof BarChart3;
}) {
  return (
    <div className="rounded-lg border border-border/80 bg-slate-50 p-3 dark:bg-background">
      <div className="flex items-center gap-2 text-slate-500 dark:text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span className="text-xs">{label}</span>
      </div>
      <p className="mt-2 text-lg font-semibold text-slate-950 dark:text-foreground">
        {value}
      </p>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-2 last:border-0 last:pb-0">
      <span className="text-sm text-slate-500 dark:text-muted-foreground">
        {label}
      </span>
      <span className="text-right text-sm font-medium text-slate-950 dark:text-foreground">
        {value}
      </span>
    </div>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="rounded-xl border-border/80 bg-white p-5 shadow-sm shadow-slate-900/[0.03] dark:bg-card">
      <h2 className="text-xl font-semibold text-slate-950 dark:text-foreground">
        {title}
      </h2>
      <div className="mt-3 text-sm leading-7 text-slate-600 dark:text-muted-foreground">
        {children}
      </div>
    </Card>
  );
}

function SectionHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-normal text-primary">
        {eyebrow}
      </p>
      <h2 className="mt-1 text-2xl font-semibold tracking-normal text-slate-950 md:text-3xl dark:text-foreground">
        {title}
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 md:text-base dark:text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

const websiteSelect = {
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
  created_at: true,
} as const;
