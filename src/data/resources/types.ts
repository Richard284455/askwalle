export type ResourceKind = "news" | "review" | "prompt" | "skill" | "tutorial";

export type Difficulty = "Beginner" | "Intermediate" | "Advanced";

export interface ResourceSource {
  title: string;
  url: string;
  publisher: string;
  accessedAt: string;
}

export interface DetailSection {
  heading: string;
  body: string;
}

export interface BaseResourceItem {
  title: string;
  slug: string;
  summary: string;
  category: string;
  tags: string[];
  publishedAt: string;
  analysis: string;
  detailSections: DetailSection[];
  sources?: ResourceSource[];
}

export interface ResourceItem extends BaseResourceItem {
  href: string;
  kind: ResourceKind;
  meta: string;
  sourceName?: string;
  sourceUrl?: string;
}

export interface NewsItem extends BaseResourceItem {
  sourceName: string;
  sourceUrl: string;
  readTime: string;
  sources: ResourceSource[];
}

export interface ReviewItem extends BaseResourceItem {
  sourceName: string;
  sourceUrl: string;
  rating: number;
  bestFor: string;
  pros: string[];
  cons: string[];
  sources: ResourceSource[];
}

export interface PromptItem extends BaseResourceItem {
  difficulty: Difficulty;
  useCase: string;
  promptText: string;
  exampleInput: string;
  adaptationTips: string[];
}

export interface SkillItem extends BaseResourceItem {
  difficulty: Difficulty;
  estimatedTime: string;
  steps: string[];
  relatedTools: string[];
  outcome: string;
}

export interface TutorialItem extends BaseResourceItem {
  level: Difficulty;
  estimatedTime: string;
  steps: string[];
  outcome: string;
  sourceName?: string;
  sourceUrl?: string;
  sources?: ResourceSource[];
}
