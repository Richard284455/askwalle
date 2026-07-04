# Toolify-Inspired Redesign Direction

This document defines the redesign direction for askwalle as an original AI tools directory inspired by common patterns in products like Toolify. The goal is not to copy Toolify's brand, exact layout, wording, logo, colors, or assets. The final experience should feel like a clean, modern, high-density SaaS directory for discovering AI tools.

## Goals

- Make the public site feel like a polished AI tools directory.
- Improve browsing, search, category discovery, and rankings.
- Preserve the existing database schema, Prisma models, and admin workflows.
- Use the current dependency set and existing component system.
- Keep the build passing throughout the redesign.

## Homepage Structure

The homepage should become the primary discovery surface for AI tools.

### Header

- Logo and product name.
- Categories link or anchor.
- Rankings link.
- Submit tool button.
- Theme toggle.
- Mobile menu with the same core actions.

The header should be simple, sticky, and directory-focused. It should avoid oversized branding treatments and keep navigation quick to scan.

### Hero

- Strong H1 that clearly communicates the product category, such as an AI tools directory or AI tools discovery hub.
- Short supporting copy focused on discovering, comparing, and submitting AI tools.
- Large central search bar.
- Optional secondary actions for browsing categories or submitting a tool.

The hero should be useful, not purely decorative. Search should be the dominant interaction.

### Stats Row

Show lightweight directory stats when derivable from current data:

- Total tools.
- Total categories.
- Latest updates or newly added tools.

If exact update metadata is not available in the current selected data, use the newest available tools based on existing fields or keep the stat label generic.

### Popular Category Chips

- Display prominent category chips near the search area.
- Chips should filter the current homepage list using existing category state.
- Include a clear all-tools option.
- Keep chips compact and easy to scan on desktop and mobile.

### Featured Categories Section

- Card/grid section for categories.
- Each category card should include category name and tool count when available.
- Use existing `Category` and `Website` data to calculate counts client-side if needed.
- Cards should link to category landing pages if implemented, or filter in place until category routes exist.

### New AI Tools Section

- Show recently added or default ordered tools using existing website data.
- If `created_at` is not selected in current public queries, either add it to the query without schema changes or use the available list order as a fallback.
- Use compact, information-rich cards.

### Top AI Tools Section

- Highlight tools by visits and/or likes.
- Use existing `visits` and `likes` fields.
- Keep this distinct from the full listing so users can quickly find popular tools.

### Submit CTA

- Add a clear call-to-action for users to submit an AI tool.
- Link to the existing `/submit` route.
- Keep the CTA visually distinct but not oversized.

## Category Experience

### Category Grid

- Provide a browsable category grid on the homepage.
- Include category name and tool count where available.
- Use current categories from Prisma.
- Keep layout responsive and dense.

### Category Landing Pages

Desired direction:

- Add category landing pages for individual categories when implementation begins.
- Each category page should show category name, tool count, search/filter controls, and tools in that category.
- Category pages should use existing models and fields only.

If route creation is deferred, category chips and cards can filter the homepage state first.

### Tool Count Per Category

- Calculate counts from loaded approved tools where possible.
- Avoid schema changes.
- Avoid extra database fields.
- If counts need to be server-derived later, use Prisma aggregation or grouped queries without schema changes.

## Tool Card Design

Cards should support fast scanning, comparison, and external navigation.

### Compact Card

- Dense layout suitable for directory browsing.
- Thumbnail or favicon on the left/top.
- Tool title prominent but not oversized.
- Short two-line description.
- Category badge.
- Visits and likes if available.
- External link button using an icon and accessible label.

### Full Card Variant

- May be used for featured or top tools.
- Include thumbnail, title, description, category badge, visits, likes, and external action.
- Should avoid overly tall cards and preserve high information density.

### Thumbnail Behavior

- Use existing `thumbnail`, `thumbnail_base64`, and favicon fallback behavior.
- Do not introduce new image services or dependencies.

## Ranking Experience

The rankings experience should help users discover proven or trending tools.

### Ranking Types

- Top tools by visits.
- Top tools by likes.
- Newest tools.

### Optional Tabs

- Tabs are preferred if easy with existing UI primitives.
- Tab labels should be short and scannable.
- Each tab should reuse the same card/list primitives where practical.

### Existing Route

- Keep `/rankings`.
- The page can be redesigned visually while preserving existing data fetching and visit behavior.

## Visual Style

The redesign should feel like a clean SaaS directory:

- Light background by default.
- Card-based layout with restrained borders and shadows.
- High information density.
- Responsive layouts for mobile, tablet, and desktop.
- Subtle gradients only.
- Avoid copying Toolify colors exactly.
- Avoid heavy purple/blue gradient dominance.
- Avoid decorative blobs, orbs, and purely atmospheric visuals.
- Use clear typography hierarchy.
- Keep cards at moderate radius and avoid nested card layouts.
- Make controls familiar: chips, tabs, icon buttons, search field, badges.

## Implementation Constraints

- Do not modify `prisma/schema.prisma`.
- Do not create migrations for the redesign.
- Do not run `prisma db push`.
- Do not run `prisma migrate reset`.
- Do not add new dependencies.
- Keep existing Prisma models:
  - `Website`
  - `Category`
  - `Setting`
  - `FooterLink`
- Keep existing admin functionality working.
- Keep existing submit flow working.
- Keep existing API routes compatible.
- Do not print `.env` values or secrets.
- Build must pass after implementation.

## Likely Implementation Areas

- `src/app/home-page.tsx`
- `src/app/page.tsx`
- `src/components/header/header.tsx`
- `src/components/header/mobile-menu.tsx`
- `src/components/header/persistent-header.tsx`
- `src/components/search-box.tsx`
- `src/components/category-filter.tsx`
- `src/components/category-sidebar.tsx`
- `src/components/website/website-grid.tsx`
- `src/components/website/website-card.tsx`
- `src/components/website/compact-card.tsx`
- `src/components/footer/footer-content.tsx`
- `src/app/(app)/rankings/page.tsx`
- `src/components/website/rankings.tsx`

## Success Criteria

- Public homepage looks and behaves like a modern AI tools directory.
- Users can search, browse categories, identify popular tools, and submit tools easily.
- Rankings are clearer and more useful.
- Mobile layout remains polished and usable.
- Admin dashboard and settings continue to work.
- `npm run build` passes.
