# AGENTS.md

Guidance for Codex, Claude Code, Antigravity, and other coding agents working in this repository.

## Project Stack

- Next.js 15 App Router, React 18, TypeScript.
- Tailwind CSS with Radix UI primitives and local UI components under `src/ui`.
- Prisma ORM with PostgreSQL only.
- Jotai, React Query, and SWR are available for client-side state/data patterns.
- `ts-node` is used for project scripts such as data initialization and imports.

## Directory Structure

- `src/app`: Next.js routes.
  - `src/app/(app)`: public pages such as homepage, categories, tools, rankings, resources, news, reviews, prompts, skills, tutorials.
  - `src/app/(admin)`: admin pages. Do not change admin behavior unless the task explicitly requires it.
  - `src/app/api`: API routes for websites, categories, settings, login, footer links, and admin utilities.
- `src/components`: shared UI components grouped by feature.
  - `src/components/resources`: AI resource hub cards, list UI, detail layout, and copy prompt controls.
  - `src/components/website`: tool cards, grids, thumbnails, visit tracking UI, and ranking UI.
  - `src/components/header` and `src/components/footer`: public shell components.
- `src/lib`: database clients, helpers, services, sync utilities, task utilities, resource content helpers, and shared types.
- `src/data/resources`: legacy/static resource seed data. Keep until a human approves removal.
- `scripts`: local maintenance/import scripts.
- `prisma`: Prisma schema and migration history.
- `docs`: handoff and architecture documentation.

## Coding Standards

- Keep changes surgical. Modify only files directly related to the task.
- Match existing naming, formatting, TypeScript style, and Tailwind patterns.
- Prefer existing components and helpers before adding new abstractions.
- Do not add dependencies unless explicitly approved.
- Do not move client-side database access into client components. Database reads belong in server components, route handlers, or server-side helpers.
- Public database-backed pages should use safe fallback behavior and must not expose raw database errors to the browser.
- Do not print secrets, full environment values, database URLs, JWT secrets, or admin passwords in logs or responses.

## Database Rules

- PostgreSQL is the only supported database provider in `prisma/schema.prisma`.
- Never run `prisma db push`.
- Never run `prisma migrate reset`.
- Never drop or recreate tables unless a human explicitly approves.
- Do not edit existing migrations.
- Do not create migrations unless the user explicitly asks for one.
- For Supabase/local validation, prefer loading `.env` and overriding `DATABASE_URL` with `DIRECT_URL` when required:

```bash
set -a
source .env
set +a
DATABASE_URL="$DIRECT_URL" npm run build
```

## Required Validation

Run the existing project commands after relevant changes:

```bash
npm run lint
npm run build
```

There is currently no `test` script in `package.json`. If a task asks for tests, first check whether a test command exists before inventing one.

For Prisma-only validation when schema work is explicitly approved:

```bash
npx prisma validate
```

## Files Requiring Human Confirmation

- `prisma/schema.prisma`
- `prisma/migrations/**`
- `.env`, `.env.*`, or any secret-bearing file
- `package.json` dependency changes
- Admin authentication or settings behavior
- Backup/sync code under `src/lib/sync`
- Destructive Git operations, including reset, clean, forced checkout, or force push

## Git Safety

- Do not commit `.env`, `.next`, `node_modules`, generated local cache files, or secrets.
- Before committing, run:

```bash
git status --short
git diff --cached --name-only
```

- Confirm no secret files are staged.
