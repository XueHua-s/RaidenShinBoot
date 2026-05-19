---
name: raiden-project-structure
description: Navigate the RaidenShinBoot TypeScript monorepo. Use for package ownership, entry points, workspace scripts, dependency placement, environment files, and validation command selection across shared, database, server, bot, and panel.
---

# Raiden Project Structure

Use this skill before making structural decisions, adding dependencies, or choosing validation commands in RaidenShinBoot.

## Package Map

- `packages/shared`
  - Owns shared Zod schemas, persona prompt, memory context formatting, and Vercel AI SDK v6 boot helpers.
  - Import from `@raiden/shared` for browser-safe schemas and from `@raiden/shared/boot` only in Node/server contexts.
- `packages/database`
  - Owns Drizzle schema, PostgreSQL client, repositories, migrations, `pgvector` `halfvec(3072)`, and HNSW memory search.
  - Schema changes start in `src/schema.ts`, then run `pnpm db:generate`.
- `packages/server`
  - Owns Hono app, route composition, CORS/logging, `AppType` export, and HTTP orchestration.
  - Frontend type inference flows through `packages/server/src/app.ts`.
- `packages/bot`
  - Owns grammY Telegram command handlers and Telegram-specific context adaptation.
  - Bot should reuse shared/database behavior instead of duplicating server logic.
- `packages/panel`
  - Owns React 19 + Refine v4 + Tailwind CSS v4 admin UI.
  - For panel work, switch to `packages/panel/AGENTS.md` and `packages/panel/.agents/skills.md`.

## Dependency Placement

- Cross-package DTOs, persona text, and schemas: `packages/shared`.
- Database schema/query logic: `packages/database`.
- HTTP-only validation and route composition: `packages/server`.
- Telegram-only commands, messages, and grammY middleware: `packages/bot`.
- Browser UI, Refine data provider, and typed API client usage: `packages/panel`.

Do not add a dependency to the root unless it is a build/dev tool used across packages.

## Entry Points

- API app: `packages/server/src/app.ts`
- API server process: `packages/server/src/index.ts`
- Bot process: `packages/bot/src/index.ts`
- Bot conversation adapter: `packages/bot/src/conversation.ts`
- Shared AI boot client: `packages/shared/src/boot.ts`
- Persona prompt: `packages/shared/src/persona.ts`
- Database schema: `packages/database/src/schema.ts`
- Panel app: `packages/panel/src/App.tsx`
- Panel typed client: `packages/panel/src/lib/apiClient.ts`
- Panel data provider: `packages/panel/src/lib/dataProvider.ts`

## Scripts

- Install: `pnpm install`
- Full type check: `pnpm check`
- Full build: `pnpm build`
- Server dev: `pnpm dev:server`
- Bot dev: `pnpm dev:bot`
- Panel dev: `pnpm dev:panel`
- Generate migrations: `pnpm db:generate`
- Apply migrations: `pnpm db:migrate`
- Panel only: `pnpm --filter @raiden/panel check` and `pnpm --filter @raiden/panel build`

## Environment

- `.env.example` documents required keys.
- `DATABASE_URL` is required for data APIs, bot memory, and migrations.
- `BOT_TOKEN` is required only for `packages/bot`.
- `BOOT_BASE_URL`, `BOOT_API_KEY`, `BOOT_CHAT_MODEL`, and `BOOT_EMBEDDING_MODEL` control the OpenAI-compatible relay.
- `VITE_API_BASE_URL` controls panel to API connection.

## Quick Self-Check

Before changing structure, run:

```bash
rg --files packages .agents .claude skills | sort
```

Then choose the smallest package and validation command that covers the change.

