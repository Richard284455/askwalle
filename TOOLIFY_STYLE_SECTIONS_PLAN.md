# Toolify-Style Sections Plan

## Direction

Build an original AI tools directory experience inspired by common directory patterns: strong search, browsable categories, rankings, fresh tools, popular tools, and practical resource pages.

Do not copy Toolify branding, exact copy, layout, logo, colors, or assets. Keep the existing AskWalle identity and use only the existing `Website` and `Category` models.

## Constraints

- No Prisma schema changes.
- No migrations.
- No new dependencies.
- No admin page changes.
- Use existing `Website` and `Category` data only.
- Keep builds passing.

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

## V1 Sections

### 1. Header Navigation

Target route:
- Global public header across public routes.

Menu items:
- AI Tools
- New
- Popular
- Categories
- Rankings
- Free AI Tools
- Submit Tool

Files likely to change:
- `src/components/header/header.tsx`
- `src/components/header/mobile-menu.tsx`

Data needed:
- None directly. Links point to existing sections/routes.

Uses database queries:
- No.

Dynamic route:
- No route change needed.

Validation:
- Run the shared validation command.

Notes:
- `New` can link to `/#new-tools`.
- `Popular` can link to `/#popular-tools`.
- `AI Tools` can link to `/#all-tools`.
- `Free AI Tools` can link to `/free-ai-tools`.
- TODO: Create real `/new`, `/popular`, and `/free-ai-tools` routes before
  changing header links to those route paths. Until then, do not add broken
  header links for routes that do not exist.

### 2. Homepage Sections

Target route:
- `/`

Sections:
- Hero with large search
- Stats row: total tools, total categories, recently added
- Explore tabs: New Tools, Most Liked, Most Used
- Featured Categories
- Popular AI Tools
- New AI Tools
- Free AI Tools preview
- Submit Tool CTA

Files likely to change:
- `src/app/page.tsx`
- `src/app/home-page.tsx`
- `src/components/search-box.tsx`
- `src/components/website/website-card.tsx`
- `src/components/website/compact-card.tsx`
- `src/components/website/website-grid.tsx`

Data needed:
- `Website.id`
- `Website.title`
- `Website.url`
- `Website.description`
- `Website.category_id`
- `Website.thumbnail`
- `Website.thumbnail_base64`
- `Website.status`
- `Website.visits`
- `Website.likes`
- `Website.active`
- `Category.id`
- `Category.name`
- `Category.slug`

Uses database queries:
- Yes. Homepage uses approved websites and categories.

Dynamic route:
- Yes. Keep homepage dynamic because tools/categories can change through admin.

Validation:
- Run the shared validation command.

Notes:
- “Free AI Tools preview” must use existing data only. If there is no reliable free/paid field, V1 should label it as a curated preview using existing approved tools, or use title/description keyword matching only if clearly disclosed in code comments or UI copy.

### 3. Category Page

Target routes:
- `/categories`
- `/categories/[slug]`

Sections:
- Category directory grid
- Tool counts
- Category landing pages

Files likely to change:
- `src/app/(app)/categories/page.tsx`
- `src/app/(app)/categories/[slug]/page.tsx`

Data needed:
- `Category.id`
- `Category.name`
- `Category.slug`
- Approved `Website` count per category
- Approved websites for category landing pages

Uses database queries:
- Yes.

Dynamic route:
- Yes. Categories and tools are database-backed and can change through admin.

Validation:
- Run the shared validation command.

Notes:
- Keep category pages public-only.
- Do not change admin category management.

### 4. Rankings Page

Target route:
- `/rankings`

Sections:
- Top by visits
- Most liked
- Newest tools

Files likely to change:
- `src/app/(app)/rankings/page.tsx`
- `src/components/website/rankings-client.tsx`
- `src/components/website/rankings.tsx`

Data needed:
- Approved websites
- `Website.visits`
- `Website.likes`
- `Website.created_at`
- Related category name/slug if included in cards

Uses database queries:
- Yes.

Dynamic route:
- Yes. Rankings should reflect changing visits, likes, and new tools.

Validation:
- Run the shared validation command.

Notes:
- Keep rankings readable on mobile.
- Avoid making ranking claims beyond available data.

### 5. Free AI Tools Page

Target route:
- `/free-ai-tools`

Sections:
- Intro section
- 3-step guide
- Filtered/free tools listing if possible from existing data
- FAQ section

Files likely to change:
- `src/app/(app)/free-ai-tools/page.tsx`
- Possible shared public card/list component files if reuse is needed:
  - `src/components/website/website-card.tsx`
  - `src/components/website/compact-card.tsx`
  - `src/components/website/website-grid.tsx`

Data needed:
- Approved websites
- Categories for badges/filtering
- Existing website title/description only if trying to infer “free”

Uses database queries:
- Yes, if listing tools.
- No, if V1 is only intro/guide/FAQ with links.

Dynamic route:
- Yes if it queries tools.
- Static is acceptable only if V1 has no database-backed listing.

Validation:
- Run the shared validation command.

Notes:
- Current schema has no pricing/free field.
- Recommended V1 wording: “Free AI Tools” page can explain that tools may offer free tiers or trials where listed, but exact pricing should be verified on each tool website.
- If filtering is implemented, use conservative keyword matching from existing title/description only, or show general approved tools as a preview without claiming all are free.

### 6. Footer

Target route:
- Global public footer across public routes.

Sections:
- Resource links
- Category links
- Rankings links
- Submit link
- A-Z tool index placeholder

Files likely to change:
- `src/components/footer/index.tsx`
- `src/components/footer/footer-content.tsx`

Data needed:
- Existing `FooterLink` data for custom resource links
- Optional top categories from `Category`

Uses database queries:
- Yes for existing footer links/settings.
- Yes if showing category links from DB.

Dynamic route:
- Footer is used in layout. Keep routes that depend on it dynamic where needed, or ensure footer query failures fall back safely.

Validation:
- Run the shared validation command.

Notes:
- Preserve existing footer link functionality.
- A-Z tool index should be a placeholder link/label in V1 unless a real route is implemented.

## Implementation Order

1. Header nav links and anchors.
2. Homepage section anchors and Explore tabs.
3. Free AI Tools page shell.
4. Footer category/resource links and A-Z placeholder.
5. Responsive pass across homepage, rankings, categories, and footer.
6. Build validation and local dev restart.

## Risks

- “Free AI Tools” cannot be perfectly accurate without a pricing/free field.
- Footer database queries can affect build/prerender if route dynamic settings are missing.
- Search/results pages should remain dynamic if they query Prisma.
- Build currently skips type validation and linting per existing project config.
