# RaidenShinBoot

RaidenShinBoot is a modern TypeScript monorepo for a Telegram bot whose core personality is Raiden Makoto from Genshin Impact. It uses grammY for the bot, Hono for the typed API, PostgreSQL + Drizzle ORM + pgvector halfvec memory search, and a React 19 + Refine v4 + Tailwind CSS v4 admin panel.

## Stack

- `pnpm` workspace with `shared`, `database`, `bot`, `server`, and `panel`
- grammY Telegram bot
- Hono chain routes with `AppType` exported to the panel through `hono/client`
- PostgreSQL, Drizzle ORM, `pgvector` `halfvec(3072)`, and HNSW vector index
- React 19, Refine v4, Tailwind CSS v4, Vite
- Vercel AI SDK v6 with OpenAI-compatible relays for chat, embeddings, and image generation
- `tsdown` for package builds and Vite for the panel

## Quick Start

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres
docker compose up -d redis
pnpm db:generate
pnpm db:migrate
ADMIN_USERNAME=owner ADMIN_PASSWORD='replace-with-a-long-password' pnpm admin:bootstrap
pnpm test:e2e
pnpm dev:server
pnpm dev:panel
pnpm dev:bot
```

Fill `BOT_TOKEN` and AI relay keys in `.env` before starting the bot. Use `BOOT_CHAT_API_KEY` and `BOOT_EMBEDDING_API_KEY` when chat and embedding are served by different relay hosts.
Set `REDIS_URL` to enable BullMQ jobs, Telegram webhook ingestion, and L1/L2 semantic response cache. Without Redis, local long polling still works and durable memory falls back to the original inline path.
For webhook mode, set `BOOT_TELEGRAM_WEBHOOK_SECRET`, configure Telegram to send updates to `POST /api/telegram/webhook` with that `secret_token`, set `BOOT_MEMORY_ENRICHMENT_ASYNC_ENABLED=true`, and run the worker with `pnpm --filter @raiden/bot dev:worker`.
When testing the admin panel locally, keep the browser host and `VITE_API_BASE_URL` host consistent, for example `http://localhost:5173` with `http://localhost:8787` or `http://127.0.0.1:5173` with `http://127.0.0.1:8787`. Admin session cookies are host-bound, so mixing `localhost` and `127.0.0.1` can make authenticated panel requests look unauthorized.
Create the first admin with `pnpm admin:bootstrap`; the command requires `ADMIN_USERNAME` and an `ADMIN_PASSWORD` of at least 12 characters and never creates a default production account.
Set `BOOT_SETTINGS_ENCRYPTION_KEY` before saving relay keys in the admin System page; model names and base URLs can be managed without it, but secrets are rejected unless encrypted storage is ready.
If the chat relay does not expose a 3072-dimensional embedding model, set `BOOT_EMBEDDING_BASE_URL` and `BOOT_EMBEDDING_MODEL` to a compatible embedding provider before using long-term memory.
Set `BOOT_IMAGE_BASE_URL`, `BOOT_IMAGE_API_KEY`, and `BOOT_IMAGE_MODEL` to enable `/api/images` and the Telegram `/draw` command.
Set `BOOT_SEARCH_PROVIDER` plus `BOOT_SEARCH_API_KEY` to enable the Boot `web_search` tool, `POST /api/search`, Telegram `/search`, and automatic search injection for explicit search requests in chat.
On macOS without Docker Desktop, `brew install colima docker docker-compose` plus `colima start` is enough for the local pgvector service.

To run the containerized app stack after filling `.env`:

```bash
docker compose --profile app up --build
```

The `bot` container is isolated behind a profile so local stacks can run without a Telegram token:

```bash
docker compose --profile app --profile bot up --build
```

Webhook worker mode is available through the `bot-worker` service:

```bash
docker compose --profile app --profile worker up --build
```

In webhook mode, the Hono API only validates Telegram's secret token and enqueues the raw update. The worker consumes BullMQ jobs and runs the same grammY middleware stack used by long polling.
The worker profile enables asynchronous memory enrichment; local polling keeps memory creation inline by default unless `BOOT_MEMORY_ENRICHMENT_ASYNC_ENABLED=true` is set.

`pnpm test:e2e` validates both the Hono API and grammY bot core paths, including multi-turn user-impression memory: first-turn memory creation, second-turn memory retrieval, prompt injection, and natural recall in Makoto's reply.

Image generation is available through:

- API: `POST /api/images` with `{ "prompt": "...", "size": "1024x1024", "n": 1 }`
- Telegram: `/draw 稻妻夜色里的樱花与柔和雷光`

Web search is available through:

- API: `POST /api/search` with `{ "query": "...", "maxResults": 5 }`
- API: `GET /api/search/tools` to inspect the Boot tool registry
- Telegram: `/search Codex CLI 工具架构`
- Chat auto-use: messages containing explicit search intent such as `联网搜索`, `查一下`, `最新`, or `新闻`

Response cache behavior:

- L1 exact cache: per-user normalized query match; no embedding or LLM call.
- L2 semantic cache: Redis Stack vector search over the query embedding; default threshold is `0.92`.
- L3 cold path: full boot conversation pipeline; successful standalone answers are cached for `BOOT_SEMANTIC_CACHE_TTL_SECONDS`.

The cache is intentionally per user by default because replies can include persona, conversation, search, and private memory context. Explicit search/current-events requests are excluded from response caching. Cache reads and writes are best-effort and fail open after `BOOT_SEMANTIC_CACHE_TIMEOUT_MS`.

## AI Relay Configuration

The boot client supports separate OpenAI-compatible providers per capability:

| Capability | Base URL | API key | Model | Notes |
| --- | --- | --- | --- | --- |
| Chat | `BOOT_CHAT_BASE_URL` or `BOOT_BASE_URL` | `BOOT_CHAT_API_KEY` or `BOOT_API_KEY` | `BOOT_CHAT_MODEL` | Default chat model is `gpt-5.5`; the configured proxy requires streaming chat completions. |
| Embedding | `BOOT_EMBEDDING_BASE_URL` or `BOOT_BASE_URL` | `BOOT_EMBEDDING_API_KEY` or `BOOT_API_KEY` | `BOOT_EMBEDDING_MODEL` | Must return exactly 3072 dimensions because memories are stored as `halfvec(3072)`. |
| Image | `BOOT_IMAGE_BASE_URL` or `BOOT_BASE_URL` | `BOOT_IMAGE_API_KEY` or `BOOT_API_KEY` | `BOOT_IMAGE_MODEL` | Used by `POST /api/images` and Telegram `/draw`. Returns base64 images. |
| Web search | `BOOT_SEARCH_BASE_URL` or provider default | `BOOT_SEARCH_API_KEY` | `BOOT_SEARCH_PROVIDER` | Supported providers: `tavily`, `brave`, `serper`. Default is `disabled`. |

The admin panel's System page can persist these values into PostgreSQL `runtime_settings`. Runtime settings take precedence over `.env`, are audited, and are read by both the Hono API and the grammY bot on the next request. Secret values are write-only and stored with AES-256-GCM when `BOOT_SETTINGS_ENCRYPTION_KEY` is set.

For `new-api`, choose the `new-api` preset in System and point `BOOT_BASE_URL` to the gateway's OpenAI-compatible `/v1` endpoint, for example `https://new-api.example.com/v1`. Use the model names exposed by that gateway for chat/image, and keep the embedding model mapped to a 3072-dimensional provider for memory.

Known working split configuration:

```env
BOOT_BASE_URL=https://proxy.xhblog.top:3000/v1
BOOT_CHAT_MODEL=gpt-5.5
BOOT_CHAT_API_KEY=

BOOT_EMBEDDING_BASE_URL=https://api.burn.hair/v1
BOOT_EMBEDDING_MODEL=text-embedding-3-large
BOOT_EMBEDDING_API_KEY=

BOOT_IMAGE_BASE_URL=https://api.burn.hair/v1
BOOT_IMAGE_MODEL=gpt-image-1
BOOT_IMAGE_API_KEY=

BOOT_SEARCH_PROVIDER=disabled
BOOT_SEARCH_API_KEY=
BOOT_SEARCH_MAX_RESULTS=5
BOOT_SEARCH_DEPTH=basic
BOOT_CHAT_TIMEOUT_MS=90000
BOOT_EMBEDDING_TIMEOUT_MS=30000
BOOT_IMAGE_TIMEOUT_MS=180000
BOOT_SEARCH_TIMEOUT_MS=15000
BOOT_SETTINGS_ENCRYPTION_KEY=
```

If one relay key can access every capability, set only `BOOT_API_KEY` and omit the capability-specific keys.

Search provider defaults:

- `tavily`: `https://api.tavily.com/search`, bearer token auth, uses `BOOT_SEARCH_DEPTH` (`basic` or `advanced`).
- `brave`: `https://api.search.brave.com/res/v1/web/search`, `X-Subscription-Token` auth.
- `serper`: `https://google.serper.dev/search`, `X-API-KEY` auth.

## Packages

- `packages/shared`: shared schemas, API types, and Raiden Makoto persona prompt
- `packages/database`: Drizzle schema, pgvector memory repository, migrations config
- `packages/server`: Hono API and typed routes
- `packages/bot`: grammY Telegram bot
- `packages/panel`: Refine admin panel

Boot tool architecture notes live in `docs/boot-tools.md`. New user-facing bot capabilities should enter through `packages/shared/src/tools.ts` and then be exposed by API/bot adapters.

## Local Skills

This repo follows the same local-agent convention as `DocCopilotMonorepo`:

- Root agent entry files: `AGENTS.md`, `CLAUDE.md`
- Root skill guides: `.agents/skills.md`, `.claude/skills.md`
- Root reusable skills: `skills/*`
- SDD plan skill: `skills/plan-task` (`SDD模式` / `sdd:plan` / `/plan-task` map to the installer's `plan-task` skill)
- Panel agent entry files: `packages/panel/AGENTS.md`, `packages/panel/CLAUDE.md`
- Panel skill guides: `packages/panel/.agents/skills.md`, `packages/panel/.claude/skills.md`
- Panel reusable skills migrated from DocCopilot `app/web`: `packages/panel/skills/*`

DocCopilot-specific skills were not copied. Raiden-specific replacements live in `skills/raiden-project-*` and `packages/panel/skills/raiden-panel-standards`.

The `product-designer` skill is also installed under `.agents/skills/product-designer` and locked in `skills-lock.json` for Codex skill installation compatibility.

## Persona Notes

Makoto is modeled as gentle, observant, humane, and attached to the beauty of passing moments. The prompt intentionally avoids Ei's severe stillness and leans into Makoto's version of eternity: memory, care, and the value of each present moment.
