# AI Resource Hub Plan

## Direction

Extend AskWalle AI Hub from an AI tools directory into an AI resource hub with five content sections: AI News, AI Tool Reviews, Prompt Library, Skills Library, and AI Tutorials.

The experience should keep the current directory DNA: high-density layouts, strong search entries, category chips, tabs, compact cards, and resource/ranking sections. The design should be original and must not copy Toolify's brand, exact layout, text, colors, logo, or assets.

## V1 Constraints

- Use static TypeScript data under `src/data/resources/`.
- Do not modify `prisma/schema.prisma`.
- Do not create migrations.
- Do not add dependencies.
- Do not modify admin pages.
- Keep existing `Website` and `Category` models unchanged.
- Do not copy full external articles.
- Do not rely on AI paraphrasing as the only transformation for sourced content.
- Keep builds passing.

## Content Integrity Rules

- Every resource item must have its own site detail page.
- Detail pages must contain original analysis, practical framing, or structured commentary created for AskWalle.
- If an item is based on an external source, store and show source attribution with `sourceName` and `sourceUrl`.
- External-source detail pages should summarize why the item matters, who it affects, practical takeaways, and how to evaluate it.
- Do not copy full source articles, source images, source branding, or large verbatim excerpts.
- Keep source links as attribution and further reading, not as copied content.

## Navigation Structure

Public resource navigation:

- Resources hub -> `/resources`
- News -> `/news`
- Reviews -> `/reviews`
- Prompts -> `/prompts`
- Skills -> `/skills`
- Tutorials -> `/tutorials`

Footer/resource links:

- AI News
- AI Tool Reviews
- Prompt Library
- Skills Library
- AI Tutorials
- Existing directory links: AI Tools, Categories, Rankings, Free AI Tools, Submit Tool, A-Z index

Search behavior:

- V1 keeps resource search local to each resource listing page using static arrays.
- A later unified search page can search tools plus all resource data.

## Required Routes

### AI News

Routes:

- Listing page: `/news`
- Detail page: `/news/[slug]`

Purpose:

- A curated feed of AI industry updates, product announcements, research notes, open-source developments, business trends, and regulation updates.

Detail page requirement:

- Each news item must have an original AskWalle summary and analysis.
- Include source attribution with `sourceName` and `sourceUrl`.
- Include practical takeaways, affected audiences, and verification notes where useful.
- Do not copy full articles.

Dynamic route:

- No for V1 static data.

### AI Tool Reviews

Routes:

- Listing page: `/reviews`
- Detail page: `/reviews/[slug]`

Purpose:

- Editorial reviews and evaluation frameworks for AI tools, focused on use case fit, strengths, limits, risks, pricing notes, and best-fit users.

Detail page requirement:

- Each review must include original evaluation criteria and analysis.
- If a review references a tool website or external source, attribute it with source fields.
- Avoid unsupported claims and make review criteria visible.

Dynamic route:

- No for V1 static data.
- Dynamic later if reviews are linked to database-managed `Website` records.

### Prompt Library

Routes:

- Listing page: `/prompts`
- Detail page: `/prompts/[slug]`

Purpose:

- A searchable prompt directory organized by workflow, task, difficulty, and use case.

Detail page requirement:

- Each prompt detail page must include the prompt text, use case, difficulty, usage guidance, and adaptation tips.
- Prompts should be original placeholders/demo content in V1.
- Do not copy prompt packs from external websites.

Dynamic route:

- No for V1 static data.

### Skills Library

Routes:

- Listing page: `/skills`
- Detail page: `/skills/[slug]`

Purpose:

- A collection of AI workflow skills, playbooks, and repeatable operating patterns.

Detail page requirement:

- Each skill detail page must include steps, related tools, difficulty, estimated time, expected outcome, and practical usage notes.
- Skills should be original workflow content in V1.

Dynamic route:

- No for V1 static data.

### AI Tutorials

Routes:

- Listing page: `/tutorials`
- Detail page: `/tutorials/[slug]`

Purpose:

- Practical guides for using AI tools and workflows, from beginner concepts to task-specific walkthroughs.

Detail page requirement:

- Each tutorial detail page must include level, estimated time, steps, outcome, and practical notes.
- If based on external documentation or sources, include attribution and original analysis.
- Do not copy full external docs or articles.

Dynamic route:

- No for V1 static data.

## Page Layouts

### Shared Listing Page Pattern

Each resource section should use a consistent public layout:

- Hero with title, short description, and strong search entry.
- Category chips or tabs for filtering.
- Dense resource card grid.
- Empty state for no matching results.
- CTA linking to `/resources`, `/tools`, or `/submit` when relevant.

### Shared Detail Page Pattern

Each detail page should include:

- Back link to the section listing page.
- Title and short summary.
- Category, tags, date, and difficulty/level if relevant.
- Main original content body or structured sections.
- Source attribution section when `sourceName` and `sourceUrl` exist.
- Related resource links from the same static dataset when easy.
- CTA to browse tools or submit a tool.

## Static Data File Structure

Required files:

```text
src/data/resources/
  types.ts
  news.ts
  reviews.ts
  prompts.ts
  skills.ts
  tutorials.ts
  index.ts
```

Required exports:

- `newsItems`
- `reviewItems`
- `promptItems`
- `skillItems`
- `tutorialItems`
- `resourceSections`

## Card And Detail Fields

### AI News

Fields:

- `title`
- `slug`
- `summary`
- `category`
- `tags`
- `publishedAt`
- `sourceName`
- `sourceUrl`
- `readTime`

Detail content should add:

- Original analysis
- Why it matters
- Practical takeaways
- Source attribution

### AI Tool Reviews

Fields:

- `title`
- `slug`
- `summary`
- `category`
- `tags`
- `publishedAt`
- `sourceName`
- `sourceUrl`
- `rating`
- `bestFor`
- `pros`
- `cons`

Detail content should add:

- Original review criteria
- Strengths
- Limitations
- Best-fit users
- Evaluation notes

### Prompt Library

Fields:

- `title`
- `slug`
- `summary`
- `category`
- `tags`
- `publishedAt`
- `difficulty`
- `useCase`
- `promptText`

Detail content should add:

- Prompt text
- When to use it
- How to adapt it
- Example input guidance

### Skills Library

Fields:

- `title`
- `slug`
- `summary`
- `category`
- `tags`
- `publishedAt`
- `difficulty`
- `estimatedTime`
- `steps`
- `relatedTools`

Detail content should add:

- Step-by-step workflow
- Expected outcome
- Related tool suggestions
- Quality checks

### AI Tutorials

Fields:

- `title`
- `slug`
- `summary`
- `category`
- `tags`
- `publishedAt`
- `level`
- `estimatedTime`
- `steps`
- `sourceName`
- `sourceUrl`

Detail content should add:

- Learning goal
- Step-by-step guide
- Completion checklist
- Source attribution when relevant

## Data Source Strategy

V1:

- Store curated resource data as TypeScript arrays.
- Keep resource data separate from Prisma models.
- Render list and detail pages from local static data.
- Do not fetch remote sources during build.
- Do not make builds depend on external content services.

Future:

- Move resource content into database tables only after static V1 proves useful.
- Add admin management for resources in a later phase.
- Add unified search across websites and resources later.

## Files Likely To Change In V1

Planning/data:

- `src/data/resources/types.ts`
- `src/data/resources/news.ts`
- `src/data/resources/reviews.ts`
- `src/data/resources/prompts.ts`
- `src/data/resources/skills.ts`
- `src/data/resources/tutorials.ts`
- `src/data/resources/index.ts`

Public listing routes:

- `src/app/(app)/news/page.tsx`
- `src/app/(app)/reviews/page.tsx`
- `src/app/(app)/prompts/page.tsx`
- `src/app/(app)/skills/page.tsx`
- `src/app/(app)/tutorials/page.tsx`

Public detail routes:

- `src/app/(app)/news/[slug]/page.tsx`
- `src/app/(app)/reviews/[slug]/page.tsx`
- `src/app/(app)/prompts/[slug]/page.tsx`
- `src/app/(app)/skills/[slug]/page.tsx`
- `src/app/(app)/tutorials/[slug]/page.tsx`

Optional shared components:

- `src/components/resources/resource-card.tsx`
- `src/components/resources/resource-search.tsx`
- `src/components/resources/resource-tabs.tsx`
- `src/components/resources/resource-detail-layout.tsx`

## Future Database Migration Plan

Do not implement this in V1.

Possible later tables:

- `Resource`
  - shared fields: title, slug, summary, content, type, category, tags, status, published_at
- `ResourceSource`
  - attribution fields: source_name, source_url, source_type
- `Prompt`
  - prompt-specific fields such as prompt text, use case, model type, difficulty, examples
- `Review`
  - review-specific fields such as rating, pros, cons, best_for, related website id
- `Tutorial`
  - tutorial-specific fields such as steps, level, estimated time, related tools

Migration sequencing:

1. Build static V1 list and detail pages.
2. Validate user navigation and content shape.
3. Define final database schema.
4. Add migrations in a dedicated database task.
5. Add admin CRUD for resources.
6. Replace static arrays with Prisma queries.
7. Mark database-backed resource routes dynamic.

## Validation Command

```bash
set -a
source .env
set +a
DATABASE_URL="$DIRECT_URL" npm run build
```

After a successful build, clear the dev port and restart the dev server:

```bash
lsof -ti tcp:3000 | xargs -r kill
set -a
source .env
set +a
npm run dev
```

## Risks

- Static V1 content can become stale without an editorial workflow.
- Resource search will be separate from tool search until unified search is implemented.
- Reviews should avoid unsupported claims unless backed by visible criteria.
- News pages need source links and dates to avoid looking outdated.
- Detail pages require original analysis, not copied or lightly paraphrased external text.
- Future database support requires a separate schema/migration task.
