import type { ReviewItem } from "./types";

export const reviewItems: ReviewItem[] = [
  {
    title: "AI writing assistant review checklist",
    slug: "ai-writing-assistant-review-checklist",
    summary:
      "A structured way to compare drafting quality, editing control, tone options, and collaboration fit.",
    category: "Writing",
    tags: ["writing", "editing", "content"],
    publishedAt: "2026-07-02",
    sourceName: "AskWalle Reviews",
    sourceUrl: "https://askwalle.local/reviews/writing-assistant-checklist",
    rating: 4.4,
    bestFor: "Content teams that need faster first drafts and clearer edits.",
    pros: ["Strong outline generation", "Useful rewrite controls", "Easy team adoption"],
    cons: ["Needs human fact checking", "Brand voice setup takes time"],
    analysis:
      "The strongest writing assistants should be judged on controllability, not just fluent output. Teams need tools that preserve facts, accept editing constraints, and adapt to repeatable style rules.",
    detailSections: [
      {
        heading: "Review criteria",
        body: "Score tools on outline quality, revision controls, factual discipline, collaboration, export flow, and how easily a team can enforce voice guidelines.",
      },
      {
        heading: "Best-fit workflow",
        body: "Use AI to produce rough structures and alternatives, then keep final judgment with editors who understand audience, claims, and brand standards.",
      },
    ],
    sources: [
      {
        title: "AskWalle original review framework",
        url: "https://askwalle.local/reviews/writing-assistant-checklist",
        publisher: "AskWalle",
        accessedAt: "2026-07-05",
      },
    ],
  },
  {
    title: "AI coding assistant evaluation framework",
    slug: "ai-coding-assistant-evaluation-framework",
    summary:
      "Compare coding tools by context handling, test support, privacy options, and refactor quality.",
    category: "Coding",
    tags: ["coding", "testing", "developer tools"],
    publishedAt: "2026-06-30",
    sourceName: "AskWalle Reviews",
    sourceUrl: "https://askwalle.local/reviews/coding-assistant-framework",
    rating: 4.6,
    bestFor: "Developers comparing AI support for real repository work.",
    pros: ["Clear context criteria", "Good test workflow coverage", "Practical privacy checks"],
    cons: ["Requires hands-on trial", "Scores vary by codebase size"],
    analysis:
      "Coding assistants should be tested inside the actual repository. Generic examples rarely reveal whether a tool can respect local patterns, run tests, and avoid broad unrelated rewrites.",
    detailSections: [
      {
        heading: "Review criteria",
        body: "Evaluate repository context, diff quality, testing suggestions, explanation clarity, security posture, and ability to work within existing conventions.",
      },
      {
        heading: "Best-fit workflow",
        body: "Use the assistant for scoped changes, bug triage, test ideas, and unfamiliar code explanation. Keep review discipline around generated edits.",
      },
    ],
    sources: [
      {
        title: "AskWalle original coding review framework",
        url: "https://askwalle.local/reviews/coding-assistant-framework",
        publisher: "AskWalle",
        accessedAt: "2026-07-05",
      },
    ],
  },
  {
    title: "Image generation tool review scorecard",
    slug: "image-generation-tool-scorecard",
    summary:
      "A practical scorecard for prompt control, style consistency, editing features, and export quality.",
    category: "Image",
    tags: ["image", "creative", "design"],
    publishedAt: "2026-06-25",
    sourceName: "AskWalle Reviews",
    sourceUrl: "https://askwalle.local/reviews/image-generation-scorecard",
    rating: 4.2,
    bestFor: "Designers testing AI image tools for campaign and concept work.",
    pros: ["Useful quality rubric", "Includes editing checks", "Works for brand tests"],
    cons: ["Licensing still needs review", "Subjective style scoring"],
    analysis:
      "Image tools are most useful when they support iteration, not just first-pass novelty. Review them by how well they preserve direction across revisions.",
    detailSections: [
      {
        heading: "Review criteria",
        body: "Test prompt adherence, style repeatability, editing precision, commercial usage clarity, export formats, and collaboration workflow.",
      },
      {
        heading: "Best-fit workflow",
        body: "Use generated images for concepts, moodboards, variants, and rough campaign exploration before committing to final assets.",
      },
    ],
    sources: [
      {
        title: "AskWalle original image tool scorecard",
        url: "https://askwalle.local/reviews/image-generation-scorecard",
        publisher: "AskWalle",
        accessedAt: "2026-07-05",
      },
    ],
  },
  {
    title: "AI research assistant review guide",
    slug: "ai-research-assistant-review-guide",
    summary:
      "Evaluate citation handling, source traceability, synthesis quality, and export workflows.",
    category: "Research",
    tags: ["research", "citations", "analysis"],
    publishedAt: "2026-06-21",
    sourceName: "AskWalle Reviews",
    sourceUrl: "https://askwalle.local/reviews/research-assistant-guide",
    rating: 4.5,
    bestFor: "Analysts and students who need source-aware summaries.",
    pros: ["Strong source checks", "Clear synthesis criteria", "Good for briefs"],
    cons: ["Not a substitute for primary reading", "Citation formats differ"],
    analysis:
      "Research assistants should be judged by traceability. A polished summary is not enough if the user cannot inspect which source supports each claim.",
    detailSections: [
      {
        heading: "Review criteria",
        body: "Score source linking, quote handling, disagreement detection, citation exports, and the ability to separate facts from interpretation.",
      },
      {
        heading: "Best-fit workflow",
        body: "Use the tool to triage source material and create briefs, then verify important claims directly against primary materials.",
      },
    ],
    sources: [
      {
        title: "AskWalle original research assistant guide",
        url: "https://askwalle.local/reviews/research-assistant-guide",
        publisher: "AskWalle",
        accessedAt: "2026-07-05",
      },
    ],
  },
  {
    title: "AI automation platform comparison notes",
    slug: "ai-automation-platform-comparison-notes",
    summary:
      "A lightweight review of triggers, integrations, approval steps, and monitoring needs.",
    category: "Automation",
    tags: ["automation", "agents", "operations"],
    publishedAt: "2026-06-14",
    sourceName: "AskWalle Reviews",
    sourceUrl: "https://askwalle.local/reviews/automation-platform-notes",
    rating: 4.3,
    bestFor: "Operations teams testing AI-assisted workflow automation.",
    pros: ["Good integration checklist", "Includes approval controls", "Practical risk notes"],
    cons: ["Setup complexity varies", "Monitoring is often overlooked"],
    analysis:
      "AI automation platforms should be evaluated by reliability and control. A workflow that saves time but fails invisibly can create more work than it removes.",
    detailSections: [
      {
        heading: "Review criteria",
        body: "Compare trigger reliability, integrations, approval gates, logs, fallback behavior, and how easily non-developers can inspect outcomes.",
      },
      {
        heading: "Best-fit workflow",
        body: "Start with low-risk internal tasks, add human review for external actions, and monitor output quality before expanding scope.",
      },
    ],
    sources: [
      {
        title: "AskWalle original automation review notes",
        url: "https://askwalle.local/reviews/automation-platform-notes",
        publisher: "AskWalle",
        accessedAt: "2026-07-05",
      },
    ],
  },
];
