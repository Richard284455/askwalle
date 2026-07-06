import type { PromptItem } from "./types";

export const promptItems: PromptItem[] = [
  {
    title: "Turn messy meeting notes into an action plan",
    slug: "messy-meeting-notes-action-plan",
    summary:
      "Convert raw notes into decisions, owners, risks, blockers, and next actions.",
    category: "Productivity",
    tags: ["meetings", "planning", "operations"],
    publishedAt: "2026-07-01",
    difficulty: "Beginner",
    useCase: "Meeting follow-up",
    promptText:
      "Review these meeting notes and produce a concise action plan with decisions, owners, due dates, risks, unresolved questions, and the next three recommended actions.",
    exampleInput: "A transcript excerpt, meeting notes, or bullet list from a project sync.",
    adaptationTips: [
      "Add a required output format if the action plan goes into a project tracker.",
      "Name the team roles so the model can infer realistic owners.",
      "Ask for unresolved questions separately from confirmed decisions.",
    ],
    analysis:
      "This prompt is useful because it asks for operational structure instead of a generic summary. It turns a conversation into a follow-up artifact.",
    detailSections: [
      {
        heading: "When to use it",
        body: "Use it after project meetings, customer calls, planning sessions, or any discussion where the next step is more important than a polished recap.",
      },
      {
        heading: "Quality check",
        body: "Verify names, dates, and commitments before sharing the output. The model can infer ownership incorrectly if notes are vague.",
      },
    ],
  },
  {
    title: "Generate landing page positioning angles",
    slug: "landing-page-positioning-angles",
    summary:
      "Explore audiences, pains, benefits, objections, and headline directions for a product page.",
    category: "Marketing",
    tags: ["copywriting", "positioning", "landing pages"],
    publishedAt: "2026-06-29",
    difficulty: "Intermediate",
    useCase: "Landing page strategy",
    promptText:
      "Act as a product marketer. Based on this product description, generate five positioning angles with target audience, core pain, promise, proof points, objections, and a draft hero headline.",
    exampleInput: "A product description, target customer notes, and known competitor alternatives.",
    adaptationTips: [
      "Tell the model whether the product is self-serve, enterprise, or creator-focused.",
      "Ask for one conservative angle and one bold angle.",
      "Add proof constraints so claims do not exceed available evidence.",
    ],
    analysis:
      "This prompt helps teams explore positioning before writing final copy, making it easier to compare strategic options.",
    detailSections: [
      {
        heading: "When to use it",
        body: "Use it before a redesign, launch page, paid campaign, or messaging review where multiple audiences are plausible.",
      },
      {
        heading: "Quality check",
        body: "Remove unsupported claims and test whether each angle speaks to a real customer pain rather than a generic benefit.",
      },
    ],
  },
  {
    title: "Explain unfamiliar code like a senior teammate",
    slug: "explain-unfamiliar-code-senior-teammate",
    summary:
      "Ask for architecture, data flow, edge cases, and safe change points in an unfamiliar file.",
    category: "Coding",
    tags: ["coding", "code review", "learning"],
    publishedAt: "2026-06-27",
    difficulty: "Beginner",
    useCase: "Codebase onboarding",
    promptText:
      "Explain this code as if you are onboarding me to the project. Cover purpose, data flow, dependencies, edge cases, risky areas, and the safest place to make a small change.",
    exampleInput: "A file, function, or module plus any nearby tests or route names.",
    adaptationTips: [
      "Include the user-facing behavior that the code supports.",
      "Ask for a change plan only after the explanation is accurate.",
      "Request line-specific risks when working in a large file.",
    ],
    analysis:
      "The prompt frames explanation as onboarding, so the model covers context and change risk instead of merely restating code syntax.",
    detailSections: [
      {
        heading: "When to use it",
        body: "Use it before editing unfamiliar files, reviewing a pull request, or tracing a bug through a module you do not own.",
      },
      {
        heading: "Quality check",
        body: "Compare the explanation with tests and runtime behavior. Treat any confident architectural claim as provisional until verified.",
      },
    ],
  },
  {
    title: "Create a research brief from mixed sources",
    slug: "research-brief-from-mixed-sources",
    summary:
      "Synthesize notes, links, and excerpts into a decision-ready research brief.",
    category: "Research",
    tags: ["research", "analysis", "briefs"],
    publishedAt: "2026-06-24",
    difficulty: "Advanced",
    useCase: "Research synthesis",
    promptText:
      "Synthesize the following source notes into a research brief with key findings, source confidence, disagreements, open questions, recommendations, and a short executive summary.",
    exampleInput: "Annotated source notes, interview snippets, article summaries, and internal observations.",
    adaptationTips: [
      "Ask the model to label claims by source confidence.",
      "Include a section for disagreement instead of smoothing over conflicts.",
      "Separate recommendations from findings.",
    ],
    analysis:
      "This prompt is designed for decision support, not content generation. It asks the model to preserve uncertainty and conflicting evidence.",
    detailSections: [
      {
        heading: "When to use it",
        body: "Use it when a team has gathered research but needs a compact artifact for planning, prioritization, or stakeholder review.",
      },
      {
        heading: "Quality check",
        body: "Verify the strongest claims directly against source material and remove anything that cannot be traced.",
      },
    ],
  },
  {
    title: "Stress-test a product idea before building",
    slug: "stress-test-product-idea",
    summary:
      "Identify assumptions, weak signals, risks, and lightweight validation tests.",
    category: "Business",
    tags: ["startups", "strategy", "validation"],
    publishedAt: "2026-06-13",
    difficulty: "Intermediate",
    useCase: "Product validation",
    promptText:
      "Act as a skeptical product advisor. Stress-test this idea by listing assumptions, reasons it may fail, target users, validation experiments, success signals, and a no-build test plan.",
    exampleInput: "A product idea, target customer, expected value proposition, and current evidence.",
    adaptationTips: [
      "Specify whether the goal is revenue, retention, acquisition, or internal efficiency.",
      "Ask for validation tests that can run in less than one week.",
      "Request separate risks for customer demand, feasibility, and distribution.",
    ],
    analysis:
      "The prompt deliberately asks for skepticism so teams can test weak assumptions before investing engineering or marketing effort.",
    detailSections: [
      {
        heading: "When to use it",
        body: "Use it before writing a roadmap item, building a prototype, or pitching an unvalidated feature.",
      },
      {
        heading: "Quality check",
        body: "Do not treat the output as a final verdict. Use it to design sharper customer conversations and faster experiments.",
      },
    ],
  },
];
