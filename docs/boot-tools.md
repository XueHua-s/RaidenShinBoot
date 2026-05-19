# Boot Tools

RaidenShinBoot keeps bot-facing capabilities behind a small tool layer instead of wiring every capability directly into Telegram handlers or Hono routes.

The current design is inspired by the Codex CLI tool split:

- tool spec: name, description, exposure, and input/output schemas
- tool registry: one lookup point for available tools
- tool runtime: validated execution with a typed result
- presentation adapters: API routes, Telegram commands, or prompt context decide how to expose the result

## Current Tool

`web_search` searches the live web through a configured provider and returns normalized source results.

Supported providers:

- `tavily`
- `brave`
- `serper`

Default provider is `disabled`, so local development and tests do not accidentally call external services.

## Entry Points

- Shared registry: `packages/shared/src/tools.ts`
- Provider adapters: `packages/shared/src/search.ts`
- API route: `POST /api/search`
- Tool inspection: `GET /api/search/tools`
- Telegram command: `/search <query>`
- Automatic chat search: explicit search-intent messages inject web results into the Makoto prompt

## Adding Another Tool

1. Add request/response schemas in `packages/shared/src/schemas.ts`.
2. Add provider or runtime code in `packages/shared/src/*`.
3. Register the tool in `packages/shared/src/tools.ts`.
4. Add API or Telegram presentation only if users need a direct command.
5. Extend `scripts/e2e-smoke.ts` with a mock provider path.

The registry remains the authority. Routes and commands should call `executeBootTool(...)` rather than provider functions directly.
