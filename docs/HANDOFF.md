# AskWalle Handoff

## Project Goal

AskWalle is being evolved from an AI tool navigation app into a public AI tools directory and AI resource hub. The public site should help users discover AI tools, compare categories and rankings, read resource content, and visit official tool websites while preserving existing admin workflows.

## Current Completed Features

- Toolify-inspired public homepage redesign with search-first AI tools directory sections.
- Public navigation with AI tools, categories, rankings, resources, and submit tool entry points.
- Public category directory and category landing pages.
- Public rankings, new tools, popular tools, free AI tools, and A-Z tools pages.
- Internal AI tool detail pages at `/tools/[slug]`.
- Public tool cards link to internal detail pages before external visits.
- Visit Website buttons use existing visit tracking behavior.
- Local thumbnail/favicon cache strategy for public tool cards.
- AI resource hub sections:
  - `/resources`
  - `/news`
  - `/reviews`
  - `/prompts`
  - `/skills`
  - `/tutorials`
  - detail routes for each resource type.
- `ResourceContent` database model and migration.
- Static resource import script with non-overwriting default behavior.
- Resource list pages, detail pages, homepage previews, and `/resources` previews now read from `ResourceContent`.

## Not Yet Completed

- Admin UI for creating/editing `ResourceContent`.
- Full removal of legacy static files under `src/data/resources`.
- Automated tests. The project currently has no `test` script.
- Cleanup of noisy non-secret footer/cache build logs.
- Type checking command. There is **no** `type-check` script in `package.json`. Because `next.config.ts` sets `typescript.ignoreBuildErrors: true` and `eslint.ignoreDuringBuilds: true`, `npm run build` skips both TypeScript type validation and ESLint. A passing build does NOT imply type checking passed.
- Production deployment validation after the resource database migration.

## Recent Work

- Added `ResourceType`, `ResourceStatus`, `ResourceSourceType`, and `ResourceContent` to Prisma schema.
- Created and applied migration `20260705180439_add_resource_content`.
- Added `scripts/import-resources.ts` and `npm run import:resources`.
- Imported 25 demo resource records into the database.
- Added `src/lib/resources/resource-content.ts` helpers.
- Migrated public resource list pages, detail pages, homepage previews, and `/resources` previews to database reads.
- Created checkpoint commit:
  - `d273e82 feat: migrate resource hub content to database`
- Created checkpoint tag:
  - `checkpoint-after-resource-db-migration`
- Pushed branch and tag to `origin`.

## Branch, Commit, and Checkpoint

- Branch: `feature/toolify-inspired-redesign`
- Current HEAD: `fad0fe7 docs: add agent handoff documentation`
- Resource DB migration checkpoint (feature checkpoint): `d273e82 feat: migrate resource hub content to database`
- Checkpoint tag: `checkpoint-after-resource-db-migration` (points at the `d273e82` resource migration checkpoint)
- Remote: `origin` points to `https://github.com/Richard284455/askwalle.git`

## Known Issues and Technical Debt

- Build emits repeated footer/cache fallback logs. These appear non-secret but noisy.
- Static resource data still exists as seed/import source and fallback reference.
- `ResourceContent.content` is JSON, so type-specific fields are parsed defensively in helpers instead of enforced by Prisma columns.
- Homepage resource preview labels include “Beginner AI Tutorials,” but DB helper currently returns latest tutorials, not a JSON-filtered beginner subset.
- Some README content still reflects the original upstream AI navigation project and may not fully describe the AskWalle AI Hub direction.
- `.env.example` should remain documentation-only and must never include real secrets.

## Recommended Next Task

Build an admin-managed ResourceContent workflow:

- Admin list page for resource content.
- Create/edit forms for news, reviews, prompts, skills, and tutorials.
- Status workflow using `draft`, `published`, and `archived`.
- Safe JSON editing or structured type-specific form fields.

Do this only after confirming desired admin UX and whether `ResourceContent.content` should stay JSON for V1.

## Local Run Steps

```bash
npm install
cp .env.example .env
```

Edit `.env` manually with PostgreSQL connection strings and secrets. Do not print or commit these values.

For local Supabase setup where `DATABASE_URL` points to an unreachable transaction pooler, use `DIRECT_URL` for local commands:

```bash
set -a
source .env
set +a
DATABASE_URL="$DIRECT_URL" npm run dev
```

Local preview:

```text
http://localhost:3000
```

## Build and Validation

Existing project commands:

```bash
npm run lint
npm run build
```

Recommended local build command for this environment:

```bash
set -a
source .env
set +a
DATABASE_URL="$DIRECT_URL" npm run build
```

There is no `test` script in `package.json` at the time of this handoff.

## Database Migration Status

Migration files:

- `20241221124437_init`
- `20260704121500_add_website_thumbnail_base64`
- `20260705180439_add_resource_content`

The `ResourceContent` migration creates:

- `ResourceType` enum
- `ResourceStatus` enum
- `ResourceSourceType` enum
- `resource_contents` table
- indexes for type/status/published date and category
- unique constraint on type + slug

To inspect migration state without applying anything (safe, read-only):

```bash
npx prisma migrate status
# or, if DATABASE_URL (pooler) is unreachable:
DATABASE_URL="$DIRECT_URL" npx prisma migrate status
```

Apply command — **requires explicit human approval before running** (consistent with `AGENTS.md` and `README.md`; agents must not run migrations on their own):

```bash
set -a
source .env
set +a
DATABASE_URL="$DIRECT_URL" npx prisma migrate deploy
DATABASE_URL="$DIRECT_URL" npx prisma generate
```

Never run (destructive / prohibited):

```bash
npx prisma db push
npx prisma migrate reset
npx prisma migrate dev        # creates/applies migrations; approval required, not for routine use
```

## Data Import

The import script reads static demo content from `src/data/resources` and upserts by `type + slug`.

Default behavior skips existing records to avoid overwriting manual edits:

```bash
set -a
source .env
set +a
DATABASE_URL="$DIRECT_URL" npm run import:resources
```

Only use overwrite intentionally:

```bash
DATABASE_URL="$DIRECT_URL" npm run import:resources -- --overwrite
```

## Rollback Methods

Code rollback to checkpoint:

```bash
git checkout feature/toolify-inspired-redesign
git reset --hard checkpoint-after-resource-db-migration
```

Do not run the rollback command unless the user explicitly approves destructive Git operations.

Database rollback is not automated in this handoff. If production rollback is needed, create and review a forward Prisma migration that safely removes or ignores `ResourceContent` data. Do not use `migrate reset`.
