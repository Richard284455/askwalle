import { newsItems } from "./news";
import { promptItems } from "./prompts";
import { reviewItems } from "./reviews";
import { skillItems } from "./skills";
import { tutorialItems } from "./tutorials";
import type {
  NewsItem,
  PromptItem,
  ResourceItem,
  ReviewItem,
  SkillItem,
  TutorialItem,
} from "./types";

export { newsItems } from "./news";
export { reviewItems } from "./reviews";
export { promptItems } from "./prompts";
export { skillItems } from "./skills";
export { tutorialItems } from "./tutorials";
export type {
  Difficulty,
  NewsItem,
  PromptItem,
  ResourceItem,
  ReviewItem,
  SkillItem,
  TutorialItem,
} from "./types";

export function newsToResourceItem(item: NewsItem): ResourceItem {
  return {
    ...item,
    href: `/news/${item.slug}`,
    kind: "news",
    meta: item.readTime,
  };
}

export function reviewToResourceItem(item: ReviewItem): ResourceItem {
  return {
    ...item,
    href: `/reviews/${item.slug}`,
    kind: "review",
    meta: `${item.rating.toFixed(1)} rating`,
  };
}

export function promptToResourceItem(item: PromptItem): ResourceItem {
  return {
    ...item,
    href: `/prompts/${item.slug}`,
    kind: "prompt",
    meta: item.difficulty,
  };
}

export function skillToResourceItem(item: SkillItem): ResourceItem {
  return {
    ...item,
    href: `/skills/${item.slug}`,
    kind: "skill",
    meta: item.estimatedTime,
  };
}

export function tutorialToResourceItem(item: TutorialItem): ResourceItem {
  return {
    ...item,
    href: `/tutorials/${item.slug}`,
    kind: "tutorial",
    meta: item.level,
  };
}

export const latestNews = newsItems.slice(0, 3).map(newsToResourceItem);
export const latestReviews = reviewItems.slice(0, 3).map(reviewToResourceItem);
export const featuredPrompts = promptItems.slice(0, 3).map(promptToResourceItem);
export const popularSkills = skillItems.slice(0, 3).map(skillToResourceItem);
export const beginnerTutorials = tutorialItems
  .filter((item) => item.level === "Beginner")
  .slice(0, 3)
  .map(tutorialToResourceItem);

export const newsResources = newsItems.map(newsToResourceItem);
export const reviewResources = reviewItems.map(reviewToResourceItem);
export const promptResources = promptItems.map(promptToResourceItem);
export const skillResources = skillItems.map(skillToResourceItem);
export const tutorialResources = tutorialItems.map(tutorialToResourceItem);

export const resourceSections = [
  {
    title: "Latest News",
    description: "Track practical AI product and industry updates.",
    href: "/news",
    items: latestNews,
  },
  {
    title: "Latest Reviews",
    description: "Compare tools with concise evaluation frameworks.",
    href: "/reviews",
    items: latestReviews,
  },
  {
    title: "Featured Prompts",
    description: "Start from reusable prompts for common workflows.",
    href: "/prompts",
    items: featuredPrompts,
  },
  {
    title: "Popular Skills",
    description: "Learn repeatable AI workflows for real tasks.",
    href: "/skills",
    items: popularSkills,
  },
  {
    title: "Beginner Tutorials",
    description: "Build confidence with practical AI guides.",
    href: "/tutorials",
    items: beginnerTutorials,
  },
];
