# US AI Directory Design System

## Goal

Define a visual style for AskWalle AI Hub as a modern US-focused AI tools directory and resource hub. The experience should feel clean, professional, high-trust, high-density, search-first, and responsive.

This system should be original. It may draw from common SaaS and directory conventions, but must not copy Toolify, Product Hunt, Vercel, Linear, G2, or any other product's exact layout, colors, text, branding, or assets.

## 1. Brand Personality

AskWalle AI Hub should feel like a practical research desk for AI tools:

- Clear: users should understand where to search, browse, compare, and submit within seconds.
- Trustworthy: favor calm information hierarchy over hype.
- Efficient: dense cards, compact metadata, and direct navigation.
- Helpful: guide users toward the right tool or resource without exaggerating claims.
- Contemporary: modern SaaS polish with restrained visual effects.
- US business-friendly: professional enough for founders, marketers, engineers, operators, and teams evaluating tools for work.

Voice:

- Direct and useful.
- Confident but not promotional.
- Avoid fake rankings, unsupported superlatives, or claims that imply formal review unless the content supports it.
- Prefer words like "Discover", "Compare", "Browse", "Explore", "Evaluate", and "Submit".

## 2. Color Palette

Use a light-first, neutral SaaS palette with one confident accent family and a small set of semantic colors.

### Core Colors

- Page background: near white, such as `#F8FAFC`.
- Surface: white, such as `#FFFFFF`.
- Muted surface: cool off-white, such as `#F1F5F9`.
- Border: soft neutral, such as `#E2E8F0`.
- Primary text: deep slate, such as `#0F172A`.
- Secondary text: slate gray, such as `#475569`.
- Muted text: lighter gray, such as `#64748B`.

### Accent Colors

- Primary accent: crisp blue, such as `#2563EB`.
- Primary hover: deeper blue, such as `#1D4ED8`.
- Accent tint: pale blue, such as `#EFF6FF`.
- Secondary accent: teal or cyan for secondary signals, such as `#0891B2`.
- Warm highlight: amber for ranking or "new" indicators, such as `#F59E0B`.

### Semantic Colors

- Success: `#16A34A`.
- Warning: `#D97706`.
- Danger: `#DC2626`.
- Info: `#2563EB`.

### Dark Mode Direction

If dark mode is supported:

- Background: `#020617`.
- Surface: `#0F172A`.
- Muted surface: `#111827`.
- Border: `#1E293B`.
- Primary text: `#F8FAFC`.
- Secondary text: `#CBD5E1`.
- Accent remains blue but should be slightly brighter for contrast.

### Color Rules

- Do not create a one-hue interface dominated by blue or purple.
- Use gradients sparingly: short hero accents, badge washes, or section dividers only.
- Avoid decorative blobs, orbs, bokeh backgrounds, and heavy glass effects.
- Directory content should remain readable before decorative.

## 3. Typography

Use the existing font stack unless the project already defines a brand font. Do not add font dependencies just for redesign work.

### Hierarchy

- H1: 40-56px desktop, 32-40px mobile, semibold or bold.
- H2: 28-36px desktop, 24-30px mobile, semibold.
- H3: 18-24px, semibold.
- Card title: 15-18px, semibold.
- Body: 14-16px.
- Metadata: 12-13px.
- Buttons: 14px, medium.

### Rules

- Letter spacing should be normal.
- Do not scale type fluidly with viewport width.
- Avoid oversized headings inside cards, sidebars, tabs, and dense sections.
- Use line length constraints for article pages: about 65-78 characters for long reading content.
- Prefer sentence case for headings and labels.

## 4. Spacing Scale

Use a compact but breathable spacing system.

- 4px: icon gaps, tight badge padding.
- 8px: small gaps, compact card internals.
- 12px: form controls, card row gaps.
- 16px: standard component padding.
- 20px: card padding for featured cards.
- 24px: section group spacing.
- 32px: medium section padding.
- 48px: large section padding.
- 64px: hero and major desktop vertical rhythm.

### Layout Widths

- Main container: 1180-1280px.
- Reading container: 760-860px.
- Dense grid container: 1180-1280px.
- Header inner width should match main container.

## 5. Card Design

Cards should feel like directory entries, not marketing tiles.

### Tool Cards

- Compact height.
- 8px border radius or existing project radius.
- White or surface background.
- 1px border.
- Very subtle shadow only on hover.
- Thumbnail/icon at 40-56px depending on card density.
- Title in one line when possible.
- Description clamped to 2-3 lines.
- Category badge visible but secondary.
- Visits and likes should be small metadata, not dominant.
- Internal detail link should be the primary click target.
- External visit action belongs on the detail page or explicit action, not accidental card clicks.

### Resource Cards

- Dense title, summary, category, tags, and date.
- Use tags as compact chips.
- Avoid large image placeholders unless actual imagery exists.
- Source names should be visible where relevant.
- Card should link to the internal detail page first.

### Ranking Cards

- Strong rank number.
- Tool title and category.
- One primary metric per row when space is tight.
- Use amber or neutral rank accents, not heavy medal graphics.

## 6. Button Styles

Buttons should be functional and predictable.

### Primary

- Solid primary accent background.
- White text.
- 8px radius.
- Medium weight.
- Use for search, submit, visit website, and primary CTAs.

### Secondary

- White or muted surface.
- Border.
- Primary or neutral text.
- Use for browse category, view all, and filters.

### Ghost

- Transparent with hover surface.
- Use for header navigation and low-priority inline actions.

### Icon Buttons

- Use existing icon library.
- Always include accessible labels.
- Fixed width/height to prevent layout shift.

### Rules

- Do not put long text inside small buttons.
- Do not use pill buttons everywhere; reserve pill shapes for chips and filters.
- Use "View details" for internal navigation and "Visit website" for external navigation.

## 7. Header/Nav Style

The public header should feel like a focused directory command bar.

### Structure

- Brand: AskWalle AI Hub.
- Primary links: AI Tools, Categories, Rankings.
- Resources dropdown: News, Reviews, Prompts, Skills, Tutorials.
- Submit Tool action.
- Search entry or search icon if supported.
- Theme toggle if already available.
- Mobile menu with the same navigation structure.

### Visual Rules

- Sticky or fixed only if it does not obscure content.
- White or slightly translucent surface with border-bottom.
- Header height around 64-72px desktop.
- Mobile header should stay compact and easy to tap.
- Avoid oversized logos or decorative nav treatments.

## 8. Homepage Section Style

The homepage should be search-first and discovery-heavy.

### Recommended Order

1. Hero with large search.
2. Stats row.
3. Explore tabs or compact section blocks.
4. Featured Categories.
5. Popular AI Tools.
6. New AI Tools.
7. Free AI Tools preview.
8. Resource hub previews.
9. Submit Tool CTA.

### Section Rules

- Use clear section titles and concise descriptions.
- Keep dense grids scannable.
- Use "View all" links consistently.
- Do not place every section inside a large card.
- Alternate full-width bands and plain container sections instead of stacking nested cards.
- Search should remain the largest interaction on the page.

## 9. Tool Detail Page Style

Tool detail pages should help users evaluate before clicking out.

### Layout

- Breadcrumb: Home / AI Tools / Category / Tool.
- Hero with thumbnail, title, description, category badge, status, visits, likes, and Visit Website action.
- Key information panel with category, added date, visits, likes, status, and pricing fallback.
- Product information section using existing directory metadata only.
- How-to-use section with a generic verification-focused guide.
- Related tools from the same category.
- Final CTA with Visit Website and category browsing.

### Rules

- Do not invent unsupported product claims.
- Make external navigation explicit.
- Track visits only when the external visit action is clicked.
- Use local cached thumbnails where available.
- Keep the sidebar informative but not overwhelming.

## 10. Resource Article Page Style

Resource detail pages should feel editorial but still directory-like.

### Layout

- Back link to section.
- Category, tags, date, source, difficulty or rating if relevant.
- Strong title and summary.
- Main content in structured sections.
- Sources and references where applicable.
- Related resources or CTA to browse tools.

### News

- Key takeaways.
- Context and impact.
- Source attribution.
- No copied full article text.

### Reviews

- Rating or score if used.
- Best for.
- Pros and cons.
- Pricing note.
- Verdict.
- Visit tool if linked to a tool.

### Prompts

- Prompt text in a readable code-style panel.
- Copy prompt button if already implemented.
- How to use.
- Variations.

### Skills

- Outcome.
- Tools needed.
- Workflow steps.
- Prompt templates.
- Common mistakes.

### Tutorials

- Learning goal.
- Prerequisites.
- Steps.
- Next steps.

## 11. Accessibility Rules

- Text contrast must meet WCAG AA for normal text.
- Every icon-only button needs an accessible label.
- Links and buttons must have visible focus states.
- Do not rely on color alone for status or ranking.
- Use semantic headings in order.
- Use real buttons for actions and links for navigation.
- Avoid invalid nested links and buttons.
- Touch targets should be at least 44px on mobile.
- Images need meaningful alt text or empty alt text if decorative.
- Search suggestions and menus should be keyboard reachable where practical.

## 12. Mobile Rules

- Mobile should prioritize search, nav clarity, and card scan speed.
- Header actions should collapse into a menu when crowded.
- Search bar should be full width.
- Cards should use one column with compact metadata rows.
- Avoid horizontal overflow in chips and tabs; allow wrapping or horizontal scroll with visible affordance.
- Hero spacing should be reduced on mobile.
- Sticky elements should not cover form fields or suggestions.
- Footer links should stack into clear groups.
- Article pages should use a single-column reading layout.

## 13. Do And Don't Examples

### Do

- Use compact cards with title, category, description, and metrics.
- Use local cached thumbnails and safe placeholders.
- Link cards to internal detail pages first.
- Keep nav labels short.
- Use section descriptions that explain user value.
- Show empty states for no results.
- Use fallback copy when data is missing.
- Keep resource content original and attributed.

### Don't

- Do not copy Toolify, Product Hunt, Vercel, Linear, or G2 layouts, copy, logos, colors, or assets.
- Do not use remote favicons directly in the browser when a local cache path is expected.
- Do not make public pages depend on admin-only assumptions.
- Do not hide primary search below decorative content.
- Do not use huge marketing cards for every directory section.
- Do not invent pricing, features, or rankings without data.
- Do not use gradients as the primary visual identity.
- Do not make mobile users tap tiny controls.
- Do not expose raw database errors or secret values in UI, logs, metadata, or build output.

## Implementation Guardrails

- Do not modify `prisma/schema.prisma` for visual redesign work.
- Do not create migrations for design-only changes.
- Do not add dependencies unless explicitly approved.
- Preserve admin workflows.
- Keep public routes build-safe.
- Use existing Tailwind utilities and UI components.
- Run the project validation command after source changes:

```bash
set -a
source .env
set +a
DATABASE_URL="$DIRECT_URL" npm run build
```
