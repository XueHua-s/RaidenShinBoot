---
name: raiden-project-spec
description: Guard cross-package architecture for RaidenShinBoot. Use when changes affect API contracts, bot/server conversation behavior, Drizzle schema, vector memory, shared persona logic, environment variables, or validation gates.
---

# Raiden Project Spec

Use this skill for cross-package changes where behavior must stay aligned between bot, API, database, shared types, and panel.

## Core Contracts

- Hono route types flow from `packages/server/src/app.ts` through `export type AppType = typeof app`.
- Panel should consume server routes through `hono/client` and `AppType`, not duplicate response types by hand.
- Shared DTO/schema definitions belong in `packages/shared/src/schemas.ts` when used by more than one package.
- Persona and AI boot behavior belong in `packages/shared/src/persona.ts` and `packages/shared/src/boot.ts`.
- Cross-entry conversation orchestration belongs in `packages/boot/src/index.ts`.
- Long-term memory persistence and search belong in `packages/database`.

## Conversation Pipeline

Expected flow, implemented through `packages/boot` so bot and server do not drift:

1. Upsert Telegram/user identity.
2. Save user message.
3. Embed the latest user input.
4. Search memories with vector similarity.
5. Load recent messages.
6. Generate Makoto reply from persona + memory + history.
7. Save assistant reply.
8. Summarize durable memory when useful.
9. Embed and save new memory.

If bot and server both need the same behavior, move orchestration into `packages/boot` or lower shared/database packages instead of letting implementations drift.

## Database Rules

- `memories.embedding` uses `halfvec(3072)`; embedding model changes must be checked against dimension.
- HNSW cosine index must stay present for memory search.
- Migration SQL must include `CREATE EXTENSION IF NOT EXISTS vector;` before `halfvec` usage.
- Repository functions should return DTO-friendly shapes and avoid leaking raw vector fields to panel by default.

## API Rules

- Hono routes should stay chain-composed so type inference remains useful.
- Use Zod validators for query/body inputs exposed to panel or external callers.
- `/api/health` should remain cheap and not require a DB connection.
- Data endpoints may require `DATABASE_URL`, but panel must handle missing DB gracefully.

## Panel Rules

- `packages/panel/src/lib/apiClient.ts` is the typed API boundary.
- `packages/panel/src/lib/dataProvider.ts` is the Refine integration boundary.
- Runtime status, empty state, error state, loading state, and disabled controls are part of the contract for admin usability.

## Validation Matrix

- Shared schema/persona/AI client: `pnpm --filter @raiden/shared check`
- Conversation orchestration: `pnpm --filter @raiden/boot check`
- Database schema/repository: `pnpm --filter @raiden/database check` and `pnpm db:generate`
- Hono API: `pnpm --filter @raiden/server check`
- Bot behavior: `pnpm --filter @raiden/bot check`
- Panel UI/API contract: `pnpm --filter @raiden/panel check` and `pnpm --filter @raiden/panel build`
- Cross-package changes: `pnpm check` and `pnpm build`

## Delivery Notes

Final answers for cross-package work should mention:

- Packages touched
- Whether env vars or migrations changed
- Validation commands run
- Any local service limitation, such as missing Docker/PostgreSQL
