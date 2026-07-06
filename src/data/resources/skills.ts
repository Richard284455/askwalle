import type { SkillItem } from "./types";

export const skillItems: SkillItem[] = [
  {
    title: "AI-assisted research sprint",
    slug: "ai-assisted-research-sprint",
    summary:
      "Collect sources, extract insights, and turn findings into a decision-ready brief.",
    category: "Research",
    tags: ["research", "analysis", "briefs"],
    publishedAt: "2026-07-01",
    difficulty: "Intermediate",
    estimatedTime: "45 min",
    steps: ["Define the question", "Collect source notes", "Extract claims", "Compare evidence", "Write the brief"],
    relatedTools: ["Research assistant", "Document summarizer", "Citation manager"],
    outcome: "A concise brief with findings, confidence levels, open questions, and recommended next actions.",
    analysis:
      "This skill is about shaping messy information into a useful decision artifact while preserving uncertainty.",
    detailSections: [
      {
        heading: "How to practice",
        body: "Start with a narrow question and three to five sources. Ask AI to extract claims first, then synthesize only after you inspect the evidence.",
      },
      {
        heading: "Quality check",
        body: "Every important claim should map back to a source note. If the source trail is unclear, downgrade the confidence level.",
      },
    ],
  },
  {
    title: "Content repurposing workflow",
    slug: "content-repurposing-workflow",
    summary:
      "Turn one long-form asset into short posts, summaries, and newsletter drafts.",
    category: "Content",
    tags: ["content", "marketing", "repurposing"],
    publishedAt: "2026-06-28",
    difficulty: "Beginner",
    estimatedTime: "30 min",
    steps: ["Extract core ideas", "Choose channels", "Draft variations", "Review tone", "Schedule posts"],
    relatedTools: ["Writing assistant", "Social scheduler", "Transcript summarizer"],
    outcome: "A channel-specific content set that keeps the original idea but adapts format and tone.",
    analysis:
      "Repurposing works best when AI preserves the argument and changes the format, not when it creates generic fragments.",
    detailSections: [
      {
        heading: "How to practice",
        body: "Use one article, call transcript, or webinar outline. Ask for key ideas before asking for posts.",
      },
      {
        heading: "Quality check",
        body: "Make sure each output has a distinct audience, hook, and call to action rather than repeating the same sentence in different lengths.",
      },
    ],
  },
  {
    title: "Prompt evaluation loop",
    slug: "prompt-evaluation-loop",
    summary:
      "Improve prompts by testing outputs against clarity, accuracy, structure, and repeatability.",
    category: "Prompting",
    tags: ["prompts", "evaluation", "quality"],
    publishedAt: "2026-06-26",
    difficulty: "Beginner",
    estimatedTime: "25 min",
    steps: ["Define expected output", "Run three examples", "Score results", "Adjust instructions", "Save the best version"],
    relatedTools: ["Chat assistant", "Prompt library", "Spreadsheet"],
    outcome: "A tested prompt with clearer instructions, known limits, and repeatable output expectations.",
    analysis:
      "Prompt quality improves faster when you test against examples instead of endlessly rewriting instructions in the abstract.",
    detailSections: [
      {
        heading: "How to practice",
        body: "Pick three representative inputs: easy, normal, and difficult. Run each prompt version against all three.",
      },
      {
        heading: "Quality check",
        body: "Track failures by type: missing context, wrong format, shallow reasoning, or unsupported claims.",
      },
    ],
  },
  {
    title: "AI customer support triage",
    slug: "ai-customer-support-triage",
    summary:
      "Classify tickets, identify urgency, draft responses, and surface unresolved issues.",
    category: "Customer Support",
    tags: ["support", "operations", "triage"],
    publishedAt: "2026-06-23",
    difficulty: "Intermediate",
    estimatedTime: "40 min",
    steps: ["Group tickets", "Tag urgency", "Draft replies", "Escalate edge cases", "Update help docs"],
    relatedTools: ["Support desk", "Writing assistant", "Knowledge base"],
    outcome: "A prioritized support queue with response drafts and clear escalation paths.",
    analysis:
      "AI triage is valuable when it reduces sorting time while keeping sensitive or ambiguous cases visible to humans.",
    detailSections: [
      {
        heading: "How to practice",
        body: "Start with historical tickets and compare AI labels against how the team actually resolved each case.",
      },
      {
        heading: "Quality check",
        body: "Never automate refunds, account changes, or policy exceptions without a human approval step.",
      },
    ],
  },
  {
    title: "AI code review preparation",
    slug: "ai-code-review-preparation",
    summary:
      "Use AI to summarize changes, list risks, generate tests, and prepare review notes.",
    category: "Coding",
    tags: ["coding", "review", "testing"],
    publishedAt: "2026-06-19",
    difficulty: "Advanced",
    estimatedTime: "35 min",
    steps: ["Summarize diff", "Identify risky files", "Generate test ideas", "Check edge cases", "Write review notes"],
    relatedTools: ["Coding assistant", "Test runner", "Git client"],
    outcome: "A sharper review plan with risk areas, test ideas, and concise reviewer context.",
    analysis:
      "This skill helps reviewers spend less time understanding the shape of a change and more time judging behavior.",
    detailSections: [
      {
        heading: "How to practice",
        body: "Provide the diff and relevant tests. Ask for behavioral risks before asking for wording or summary polish.",
      },
      {
        heading: "Quality check",
        body: "Confirm all suggested tests match actual project behavior. AI can suggest plausible tests that do not fit local architecture.",
      },
    ],
  },
];
