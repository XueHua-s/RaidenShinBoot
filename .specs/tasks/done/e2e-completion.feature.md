---
title: Complete RaidenShinBoot E2E readiness
type: feature
depends_on: []
---

# Complete RaidenShinBoot E2E readiness

## Description

Ensure the RaidenShinBoot monorepo can run through a practical end-to-end validation loop on the local machine. The validation must cover the TypeScript monorepo gates, PostgreSQL + pgvector migration execution, Hono API health and chat routes, the shared AI boot client against the configured relay, and the Telegram bot conversation core where feasible without committing real secrets.

## Acceptance Criteria

- `SDD模式` is documented as an alias for the local `skills/plan-task/SKILL.md` workflow in root agent skill routing.
- Local runtime dependencies needed for E2E validation are installed or a concrete machine-level blocker is recorded.
- PostgreSQL with pgvector is available locally, and `pnpm db:migrate` applies the existing Drizzle migration successfully.
- Database schema contains the `vector` extension, `halfvec(3072)` memory embeddings, and HNSW vector index.
- Hono API starts locally and `GET /api/health` succeeds.
- `POST /api/chat` is exercised against the local database and either succeeds or records only an external relay availability blocker.
- Shared AI boot chat and embedding calls are exercised against the configured relay using a temporary environment variable only.
- Telegram bot code is validated without writing or committing `BOT_TOKEN`; if real polling cannot be tested, the core conversation path is tested through server or direct handler equivalents.
- `pnpm check`, `pnpm build`, and `pnpm db:generate` pass after any changes.
- Repository contains no committed API key, Telegram token, or accidental secret.

## Verification Rubric

- Pass: all local code, migration, API, and database checks complete; any remaining failure is caused by unavailable external credentials or relay/network service and is proven by transport-level diagnostics.
- Retry: any TypeScript, build, migration, route, schema, or secret-safety failure is found.
- Blocked: system package installation requires unavailable privileges or a remote service remains unreachable after direct and proxy diagnostics.

## Execution Summary

- Installed Colima, Docker CLI, and Docker Compose through Homebrew.
- Started `pgvector/pgvector:pg17` through `docker compose up -d postgres`.
- Applied Drizzle migrations against local PostgreSQL and verified `vector`, `halfvec(3072)`, and HNSW index state.
- Added `pnpm test:e2e` to exercise Hono `/api/chat`, the bot conversation core, AI SDK chat/embedding through a local OpenAI-compatible mock relay, and long-term memory persistence.
- Verified local API, panel dev entry, CORS for dynamic local Vite ports, build, type checks, migration generation, migration execution, and E2E smoke.
- Retested the external relays with separate chat and embedding keys: `https://proxy.xhblog.top:3000/v1` serves `gpt-5.5` chat when `stream: true`, and `https://api.burn.hair/v1` serves `text-embedding-3-large` embeddings with 3072 dimensions.
