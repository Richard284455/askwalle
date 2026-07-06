import type { NewsItem } from "./types";

export const newsItems: NewsItem[] = [
  {
    title: "Private AI workspaces become a standard product pattern",
    slug: "private-ai-workspaces-product-pattern",
    summary:
      "Teams are organizing prompts, documents, and internal assistants in governed workspaces for daily operations.",
    category: "Product Updates",
    tags: ["workspace", "productivity", "teams"],
    publishedAt: "2026-07-01",
    sourceName: "OpenAI News",
    sourceUrl: "https://openai.com/news/",
    readTime: "5 min read",
    analysis:
      "The important shift is not a single feature release. It is the movement from one-off chats toward shared AI workspaces where context, files, prompt patterns, and review rules live together.",
    detailSections: [
      {
        heading: "Why it matters",
        body: "Shared workspaces reduce duplicated prompting and make AI use easier to govern. Teams can preserve context, compare outputs, and create repeatable workflows instead of starting from a blank chat every time.",
      },
      {
        heading: "What to watch",
        body: "Look for permission controls, audit trails, export options, and clear boundaries between private company data and model training settings.",
      },
    ],
    sources: [
      {
        title: "OpenAI News",
        url: "https://openai.com/news/",
        publisher: "OpenAI",
        accessedAt: "2026-07-05",
      },
    ],
  },
  {
    title: "Multimodal search becomes a default AI product feature",
    slug: "multimodal-search-default-ai-product-feature",
    summary:
      "More tools now support searching across text, images, files, and screenshots as part of the same workflow.",
    category: "Product Updates",
    tags: ["multimodal", "search", "files"],
    publishedAt: "2026-06-28",
    sourceName: "Google AI Blog",
    sourceUrl: "https://blog.google/technology/ai/",
    readTime: "4 min read",
    analysis:
      "Multimodal search makes AI tools more useful for real work because people rarely store context in a single format. The winning products will make mixed inputs feel ordinary rather than special.",
    detailSections: [
      {
        heading: "Practical impact",
        body: "Teams can ask questions across screenshots, PDFs, meeting notes, and product images without manually converting everything into text first.",
      },
      {
        heading: "Evaluation note",
        body: "Test whether the tool can cite which file or image region informed an answer. Search convenience is less useful when source traceability is weak.",
      },
    ],
    sources: [
      {
        title: "AI updates from Google",
        url: "https://blog.google/technology/ai/",
        publisher: "Google",
        accessedAt: "2026-07-05",
      },
    ],
  },
  {
    title: "Open model releases widen options for small AI teams",
    slug: "open-model-releases-small-ai-teams",
    summary:
      "Open models are giving smaller teams more choices for prototyping, evaluation, and privacy-aware deployment.",
    category: "Open Source",
    tags: ["open source", "models", "deployment"],
    publishedAt: "2026-06-24",
    sourceName: "Hugging Face Blog",
    sourceUrl: "https://huggingface.co/blog",
    readTime: "6 min read",
    analysis:
      "The open model ecosystem changes the build-versus-buy conversation. Small teams can now compare hosted APIs, local inference, and hybrid setups before committing to one vendor path.",
    detailSections: [
      {
        heading: "Where open models help",
        body: "They are useful for prototyping domain workflows, running controlled evaluations, and testing privacy-sensitive use cases where hosted APIs may not fit.",
      },
      {
        heading: "Where caution is needed",
        body: "Open weights do not remove the need for safety testing, monitoring, infrastructure planning, or licensing review.",
      },
    ],
    sources: [
      {
        title: "Hugging Face Blog",
        url: "https://huggingface.co/blog",
        publisher: "Hugging Face",
        accessedAt: "2026-07-05",
      },
    ],
  },
  {
    title: "Research teams focus on evaluation quality for AI agents",
    slug: "research-teams-evaluation-quality-ai-agents",
    summary:
      "Agent benchmarks are moving beyond task completion toward reliability, traceability, and repeatable evaluation methods.",
    category: "Research",
    tags: ["research", "agents", "evaluation"],
    publishedAt: "2026-06-20",
    sourceName: "arXiv AI",
    sourceUrl: "https://arxiv.org/list/cs.AI/recent",
    readTime: "3 min read",
    analysis:
      "Agent demos can look impressive while hiding fragile behavior. Better evaluation asks whether an agent can recover from errors, explain actions, and produce consistent results across repeated tasks.",
    detailSections: [
      {
        heading: "What changed",
        body: "Evaluation is becoming more workflow-specific. A generic score is less helpful than tests that mirror the exact task, tools, and failure modes a team expects.",
      },
      {
        heading: "Decision lens",
        body: "Before adopting an agent tool, define acceptable failure behavior, required approvals, and what logs must exist for review.",
      },
    ],
    sources: [
      {
        title: "Recent Artificial Intelligence papers",
        url: "https://arxiv.org/list/cs.AI/recent",
        publisher: "arXiv",
        accessedAt: "2026-07-05",
      },
    ],
  },
  {
    title: "AI policy teams clarify rules for sensitive workflows",
    slug: "ai-policy-teams-sensitive-workflows",
    summary:
      "Regulatory guidance is pushing teams to document oversight, risk controls, and intended use for higher-impact AI systems.",
    category: "Regulation",
    tags: ["regulation", "policy", "risk"],
    publishedAt: "2026-06-12",
    sourceName: "EU AI Act Portal",
    sourceUrl: "https://artificialintelligenceact.eu/",
    readTime: "5 min read",
    analysis:
      "AI policy is becoming operational. Teams need lightweight documentation that explains what a system is for, who reviews it, and how risky outputs are handled.",
    detailSections: [
      {
        heading: "Practical takeaway",
        body: "For sensitive workflows, document the intended use, data categories, review owner, failure path, and escalation rules before deployment.",
      },
      {
        heading: "Adoption note",
        body: "A simple governance checklist can make AI tool adoption faster by resolving privacy and accountability questions earlier.",
      },
    ],
    sources: [
      {
        title: "EU Artificial Intelligence Act",
        url: "https://artificialintelligenceact.eu/",
        publisher: "Future of Life Institute",
        accessedAt: "2026-07-05",
      },
    ],
  },
];
