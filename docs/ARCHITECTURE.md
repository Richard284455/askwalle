# AskWalle Architecture

## Application Structure

This project uses Next.js App Router with route groups:

- `src/app/page.tsx`: public homepage server component. Fetches approved tools, categories, and resource previews.
- `src/app/home-page.tsx`: client-side homepage experience for directory filtering, sections, and UI interactions.
- `src/app/(app)`: public routes.
  - `/categories` and `/categories/[slug]`: category browsing and category landing pages.
  - `/tools` and `/tools/[slug]`: A-Z index and internal tool detail pages.
  - `/new`, `/popular`, `/free-ai-tools`, `/rankings`: directory discovery pages.
  - `/resources`: AI resource hub overview.
  - `/news`, `/reviews`, `/prompts`, `/skills`, `/tutorials`: resource list pages.
  - `/news/[slug]`, `/reviews/[slug]`, `/prompts/[slug]`, `/skills/[slug]`, `/tutorials/[slug]`: resource detail pages.
  - `/submit`: public tool submission page.
- `src/app/(admin)`: admin panel routes.
- `src/app/api`: API route handlers.

## Module Structure

- `src/components/website`: public AI tool cards, thumbnails, grids, rankings, and visit buttons.
- `src/components/resources`: resource hub cards, list filtering, detail layout, hero sections, and prompt copy control.
- `src/components/header` and `src/components/footer`: public site chrome.
- `src/lib/db`: Prisma client and simple query cache helpers.
- `src/lib/resources/resource-content.ts`: server-side helpers for reading `ResourceContent` and adapting records to UI shapes.
- `src/lib/website/tool-index.ts`: public slug helpers for internal tool detail routes.
- `src/data/resources`: static resource data used as import seed material.
- `scripts/import-resources.ts`: imports static resource data into `ResourceContent`.
- `scripts/cache-thumbnails.ts`: caches remote website thumbnails/favicons under local public assets.

## Database Models

Main Prisma models:

- `Website`
  - AI tool record with title, URL, description, category relation, thumbnail fields, status, visits, likes, active flag, and timestamps.
- `Category`
  - Tool category with name, slug, and relation to websites.
- `Setting`
  - Key-value settings used by admin/site behavior.
- `FooterLink`
  - Footer links managed independently from page content.
- `ResourceContent`
  - Unified content table for AI News, Reviews, Prompts, Skills, and Tutorials.
  - Uses JSON fields for flexible sources and type-specific content.

Resource enums:

- `ResourceType`: `news`, `review`, `prompt`, `skill`, `tutorial`
- `ResourceStatus`: `draft`, `published`, `archived`
- `ResourceSourceType`: `original`, `source_informed`, `external`

## Resource Content Flow

V1 resource data flow:

1. Static demo data lives under `src/data/resources`.
2. `scripts/import-resources.ts` imports demo data into `ResourceContent`.
3. Import defaults to skip existing database records, preserving manual edits.
4. Public pages read only `published` records from the database.
5. `src/lib/resources/resource-content.ts` maps database records to existing UI card/detail shapes.

Public resource read paths:

- List pages use `getResourcesByType(type)`.
- Detail pages use `getResourceBySlug(type, slug)`.
- Homepage previews use `getHomepageResourcePreviews()`.
- `/resources` uses `getLatestResources(type, 3)` per resource type.

## Summary Tables and Raw Tables

There is no separate summary table for AI resource hub content.

- `resource_contents` is both the canonical storage table and the public read source.
- Static files under `src/data/resources` are seed/import material, not runtime source of truth for migrated pages.
- `Website` and `Category` remain canonical for AI tool directory data.
- Derived UI summaries such as homepage previews, resource cards, and rankings are computed at query/render time.

## Tool Directory Flow

1. Public/admin submissions create or update `Website` records.
2. Public pages usually show approved websites only.
3. Tool cards link to internal `/tools/[slug]` pages.
4. External visit buttons call the existing visit tracking path before opening the official website.
5. Category and ranking pages query existing `Website` and `Category` models.

## Thumbnail Flow

1. `scripts/cache-thumbnails.ts` reads current website records.
2. The script attempts to cache thumbnail, favicon, or base64 image data into `public/cached-thumbnails`.
3. It generates `src/lib/website/thumbnail-cache-map.ts`.
4. Public thumbnails prefer local cached assets and fall back to a local placeholder.

## Key Design Decisions

- Public database-backed pages are dynamic with `force-dynamic` and `revalidate = 0` where required.
- Resource content uses one unified table instead of five separate tables for faster V1 implementation.
- Type-specific resource fields live in `content` JSON to avoid frequent schema changes.
- Sources live in JSON so source-informed pages can show attribution without copying external articles.
- Legacy static resource files remain until a human approves removal.
- Database helpers return safe empty arrays or `null` on failures to avoid leaking raw errors to users.

## Safety Constraints

- Do not run `prisma db push`.
- Do not run `prisma migrate reset`.
- Do not edit existing migrations.
- Do not print environment values or secrets.
- Do not query the database directly from client components.
