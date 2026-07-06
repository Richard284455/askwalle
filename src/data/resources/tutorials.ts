import type { TutorialItem } from "./types";

export const tutorialItems: TutorialItem[] = [
  {
    title: "How to compare AI tools without overtesting",
    slug: "compare-ai-tools-without-overtesting",
    summary:
      "A lightweight method for shortlisting, testing, and deciding which AI tool is worth keeping.",
    category: "Getting Started",
    tags: ["beginner", "evaluation", "tools"],
    publishedAt: "2026-07-01",
    level: "Beginner",
    estimatedTime: "20 min",
    steps: ["Define the job", "Shortlist three tools", "Run one test task", "Score the outputs", "Pick the next action"],
    outcome: "A clear tool decision based on one practical task rather than endless exploration.",
    sourceName: "AskWalle Tutorials",
    sourceUrl: "https://askwalle.local/tutorials/compare-ai-tools",
    analysis:
      "The goal is to reduce tool fatigue. A small, realistic test reveals more than reading many feature pages.",
    detailSections: [
      {
        heading: "How to follow it",
        body: "Choose one job you need done this week. Test each candidate tool on the same input and compare output quality, effort, cost, and fit.",
      },
      {
        heading: "Completion check",
        body: "You should end with one keep, one maybe, and one reject decision, plus notes about what would change your mind.",
      },
    ],
    sources: [
      {
        title: "AskWalle original tutorial",
        url: "https://askwalle.local/tutorials/compare-ai-tools",
        publisher: "AskWalle",
        accessedAt: "2026-07-05",
      },
    ],
  },
  {
    title: "Build your first prompt testing checklist",
    slug: "first-prompt-testing-checklist",
    summary:
      "Learn how to test prompts for clarity, repeatability, factuality, and usefulness.",
    category: "Prompting",
    tags: ["prompts", "testing", "beginner"],
    publishedAt: "2026-06-29",
    level: "Beginner",
    estimatedTime: "25 min",
    steps: ["Write expected output", "Create test cases", "Run variations", "Compare failures", "Revise prompt"],
    outcome: "A reusable checklist for judging whether a prompt is ready for repeated use.",
    sourceName: "AskWalle Tutorials",
    sourceUrl: "https://askwalle.local/tutorials/prompt-testing-checklist",
    analysis:
      "Prompt testing is easier when you define failure types before generating outputs. This turns prompt writing into a repeatable quality process.",
    detailSections: [
      {
        heading: "How to follow it",
        body: "Create three test inputs, define required sections, and score each output from one to five for format, accuracy, and actionability.",
      },
      {
        heading: "Completion check",
        body: "You should know which instruction improved the output and which failure still happens.",
      },
    ],
    sources: [
      {
        title: "AskWalle original tutorial",
        url: "https://askwalle.local/tutorials/prompt-testing-checklist",
        publisher: "AskWalle",
        accessedAt: "2026-07-05",
      },
    ],
  },
  {
    title: "Create a simple AI research workflow",
    slug: "simple-ai-research-workflow",
    summary:
      "Use AI to gather notes, separate claims from evidence, and produce a short brief.",
    category: "Research",
    tags: ["research", "briefs", "analysis"],
    publishedAt: "2026-06-25",
    level: "Intermediate",
    estimatedTime: "40 min",
    steps: ["Frame the question", "Gather notes", "Ask for claims", "Verify sources", "Write summary"],
    outcome: "A compact research brief with traceable claims and practical next steps.",
    sourceName: "AskWalle Tutorials",
    sourceUrl: "https://askwalle.local/tutorials/simple-ai-research-workflow",
    analysis:
      "This workflow keeps the model focused on organizing evidence. It avoids the common mistake of asking for conclusions before source quality is clear.",
    detailSections: [
      {
        heading: "How to follow it",
        body: "Gather excerpts and notes first. Ask AI to list claims with source references before asking it to write the final brief.",
      },
      {
        heading: "Completion check",
        body: "The final brief should identify what is known, what is uncertain, and what decision the research supports.",
      },
    ],
    sources: [
      {
        title: "AskWalle original tutorial",
        url: "https://askwalle.local/tutorials/simple-ai-research-workflow",
        publisher: "AskWalle",
        accessedAt: "2026-07-05",
      },
    ],
  },
  {
    title: "Use AI to draft a useful product requirements brief",
    slug: "ai-product-requirements-brief",
    summary:
      "Turn discovery notes into goals, user stories, constraints, risks, and acceptance criteria.",
    category: "Product",
    tags: ["product", "planning", "requirements"],
    publishedAt: "2026-06-21",
    level: "Intermediate",
    estimatedTime: "35 min",
    steps: ["Paste discovery notes", "Extract goals", "Draft user stories", "List risks", "Create acceptance criteria"],
    outcome: "A product brief that is ready for team review and refinement.",
    sourceName: "AskWalle Tutorials",
    sourceUrl: "https://askwalle.local/tutorials/product-requirements-brief",
    analysis:
      "AI can speed up requirements drafting, but the value comes from exposing ambiguity and assumptions for humans to resolve.",
    detailSections: [
      {
        heading: "How to follow it",
        body: "Use real discovery notes, ask for requirements in a structured format, and separate user needs from proposed solutions.",
      },
      {
        heading: "Completion check",
        body: "Each requirement should have a user reason, acceptance criteria, and a known unresolved question if uncertainty remains.",
      },
    ],
    sources: [
      {
        title: "AskWalle original tutorial",
        url: "https://askwalle.local/tutorials/product-requirements-brief",
        publisher: "AskWalle",
        accessedAt: "2026-07-05",
      },
    ],
  },
  {
    title: "Design an AI automation with a human review step",
    slug: "ai-automation-human-review-step",
    summary:
      "Plan automations that keep humans in control of risky or customer-facing actions.",
    category: "Automation",
    tags: ["automation", "operations", "approval"],
    publishedAt: "2026-06-14",
    level: "Advanced",
    estimatedTime: "45 min",
    steps: ["Map the workflow", "Identify risk points", "Add approval gates", "Log decisions", "Monitor failures"],
    outcome: "A safer automation plan with approval points and monitoring expectations.",
    sourceName: "AskWalle Tutorials",
    sourceUrl: "https://askwalle.local/tutorials/automation-human-review",
    analysis:
      "Automation design should start with risk boundaries. Human review is most useful when placed before irreversible or external actions.",
    detailSections: [
      {
        heading: "How to follow it",
        body: "Map the workflow from trigger to final action. Mark every point where a bad output could affect a customer, payment, account, or public message.",
      },
      {
        heading: "Completion check",
        body: "The finished plan should define who approves, what evidence they see, and how failed or uncertain runs are handled.",
      },
    ],
    sources: [
      {
        title: "AskWalle original tutorial",
        url: "https://askwalle.local/tutorials/automation-human-review",
        publisher: "AskWalle",
        accessedAt: "2026-07-05",
      },
    ],
  },
];
