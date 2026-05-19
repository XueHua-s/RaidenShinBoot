# RaidenShinBoot

RaidenShinBoot is a modern TypeScript monorepo for a Telegram bot whose core personality is Raiden Makoto from Genshin Impact. It uses grammY for the bot, Hono for the typed API, PostgreSQL + Drizzle ORM + pgvector halfvec memory search, and a React 19 + Refine v4 + Tailwind CSS v4 admin panel.

## Stack

- `pnpm` workspace with `shared`, `database`, `bot`, `server`, and `panel`
- grammY Telegram bot
- Hono chain routes with `AppType` exported to the panel through `hono/client`
- PostgreSQL, Drizzle ORM, `pgvector` `halfvec(3072)`, and HNSW vector index
- React 19, Refine v4, Tailwind CSS v4, Vite
- Vercel AI SDK v6 with an OpenAI-compatible relay at `https://xhblog.top:3000/v1`
- `tsdown` for package builds and Vite for the panel

## Quick Start

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:generate
pnpm db:migrate
pnpm dev:server
pnpm dev:panel
pnpm dev:bot
```

Fill `BOT_TOKEN` and `BOOT_API_KEY` in `.env` before starting the bot. If your relay does not expose `/v1`, update `BOOT_BASE_URL`.

## Packages

- `packages/shared`: shared schemas, API types, and Raiden Makoto persona prompt
- `packages/database`: Drizzle schema, pgvector memory repository, migrations config
- `packages/server`: Hono API and typed routes
- `packages/bot`: grammY Telegram bot
- `packages/panel`: Refine admin panel

## Local Skills

This repo follows the same local-agent convention as `DocCopilotMonorepo`:

- Root agent entry files: `AGENTS.md`, `CLAUDE.md`
- Root skill guides: `.agents/skills.md`, `.claude/skills.md`
- Root reusable skills: `skills/*`
- SDD plan skill: `skills/plan-task` (`sdd:plan` maps to the installer's `plan-task` skill)
- Panel agent entry files: `packages/panel/AGENTS.md`, `packages/panel/CLAUDE.md`
- Panel skill guides: `packages/panel/.agents/skills.md`, `packages/panel/.claude/skills.md`
- Panel reusable skills migrated from DocCopilot `app/web`: `packages/panel/skills/*`

DocCopilot-specific skills were not copied. Raiden-specific replacements live in `skills/raiden-project-*` and `packages/panel/skills/raiden-panel-standards`.

The `product-designer` skill is also installed under `.agents/skills/product-designer` and locked in `skills-lock.json` for Codex skill installation compatibility.

## Persona Notes

Makoto is modeled as gentle, observant, humane, and attached to the beauty of passing moments. The prompt intentionally avoids Ei's severe stillness and leans into Makoto's version of eternity: memory, care, and the value of each present moment.
