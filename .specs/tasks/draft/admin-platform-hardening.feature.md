---
title: Build production-grade RaidenShinBoot admin platform
type: feature
depends_on:
  - boot-memory-closure
  - image-generation-support
---

# Build Production-Grade RaidenShinBoot Admin Platform

## Problem Statement

The current panel is a thin operational viewer plus a local chat tester. It proves that the API, database, memory loop, and bot core can run, but it is not a mature admin system. It has no administrator login, no role model, no Telegram group governance, no audit trail, no deployable container topology for the full product, and no UI system beyond custom Tailwind markup.

RaidenShinBoot needs a real back office for managing the bot as an operated service: administrators must sign in with account and password, control who can operate the panel, control which Telegram groups/users the bot responds to, inspect runtime health, manage user/memory data safely, and deploy the whole stack with PostgreSQL in Docker.

## Product Goals

- Provide a secure admin console with account/password login, session management, and role-based access.
- Govern Telegram bot access by chat/group, user, command scope, and moderation state.
- Turn the panel into an operational cockpit: health, bot status, relay status, database status, jobs, audit logs, and recent activity.
- Let operators manage model, new-api/OpenAI-compatible gateway, image, embedding, and search channel configuration from the panel.
- Provide a coherent bilingual admin experience with Chinese and English UI copy, without accidental mixed-language operational text.
- Preserve the existing successful conversation pipeline: shared persona, memory search, API chat route, and grammY bot behavior stay aligned.
- Containerize the complete system for local and production-like deployment: PostgreSQL + pgvector, API, bot, panel, migrations, and optional reverse proxy.
- Build the panel with Tailwind CSS + shadcn/ui style components, not ad hoc cards.

## Non-Goals

- Do not rewrite the conversation pipeline only for aesthetic reasons.
- Do not commit secrets, default production admin passwords, bot tokens, or relay keys.
- Do not make Supabase a hard dependency unless it replaces a concrete missing capability better than the existing monorepo can.
- Do not migrate to Rust/Actix in the first implementation phase unless a strict operational requirement justifies the migration cost.

## Product Personas

### Owner / Super Admin

Runs the bot deployment, owns secrets and production configuration, creates other admin accounts, approves Telegram groups, and reviews audit logs.

Core needs:

- Bootstrap the first admin safely.
- Know whether the bot is healthy.
- Disable a group or user quickly.
- See who changed configuration and when.

### Operator

Handles day-to-day moderation and memory inspection without touching infrastructure secrets.

Core needs:

- Review Telegram users and groups.
- Suspend/resume specific groups or users.
- Inspect recent messages and memories.
- Use a safe chat test console.

### Read-Only Auditor

Reviews data and audit logs without changing configuration.

Core needs:

- Filter events by actor, action, target, and time.
- Export or inspect operational state.
- Confirm permission boundaries.

## Key User Journeys

### First Deployment Bootstrap

1. Operator runs Docker Compose.
2. Migration service applies database schema.
3. Bootstrap command creates the first super admin with an explicit username/password.
4. Admin opens `/login`, signs in, and lands on the operational dashboard.
5. Dashboard clearly shows API, PostgreSQL, bot, relay, and migration status.

Success criteria:

- No default admin account exists in production.
- Password is hashed with a memory-hard password hash; current implementation uses scrypt with per-password salt.
- Session cookie is HTTP-only, secure in production, and has expiry.

### Telegram Group Approval

1. Bot sees a new group or private chat.
2. Middleware records the chat as `pending` and refuses normal conversation unless policy allows pending chats.
3. Admin opens `Telegram > Groups`, reviews chat metadata, and approves or blocks it.
4. Bot applies the decision immediately or after a short cache TTL.
5. Audit log records actor, action, target chat, old state, and new state.

Success criteria:

- Unknown groups do not silently gain access.
- Group state is visible and reversible.
- Denied chats receive a concise configured response or no response, depending on policy.

### Admin Account Management

1. Super admin opens `Security > Admins`.
2. Creates operator/read-only account.
3. Assigns role and optional disabled state.
4. Operator signs in and only sees actions allowed by role.
5. Failed login attempts and role changes appear in audit log.

Success criteria:

- Operators cannot create super admins.
- Read-only users cannot mutate data.
- Disabled accounts cannot create new sessions.

## Information Architecture

- Dashboard
  - Service health
  - Bot status
  - Relay/search/image capability status
  - Recent audit events
  - Recent errors
- Telegram
  - Groups and private chats
  - Telegram users
  - Access policy
  - Command permissions
- Conversations
  - Messages
  - Chat tester
  - Search-trigger diagnostics
- Memory
  - Long-term memories
  - Manual memory creation
  - Recall test
- Security
  - Admin accounts
  - Roles and permissions
  - Sessions
  - Audit log
- System
  - Environment status
  - Database migrations
  - Docker/runtime metadata
  - Runtime relay/model/search configuration
  - Secret storage readiness and masked key status
  - Language preference

## Recommended Architecture Decision

### Keep TypeScript Hono for Phase 1

The existing code already has:

- Hono route composition with exported `AppType`.
- Shared Zod schemas.
- Vercel AI SDK boot client.
- grammY bot integration.
- Drizzle/PostgreSQL repository layer.
- Passing E2E smoke for API chat, bot core, memory, image, and search fallback.

Keeping Hono lets the first hardening phase focus on missing product capabilities instead of a full backend rewrite.

### Do Not Use Supabase as the Main Backend for Phase 1

Supabase is valuable for hosted auth, realtime, and managed Postgres. For this project, a self-hosted Supabase stack would add a second platform layer while the app still needs custom bot policy, AI relay configuration, and audit semantics. Direct Postgres + Hono + Drizzle is simpler and fits the current monorepo.

Supabase can be revisited if the product later needs managed auth, realtime dashboards, file storage, or hosted Postgres operations.

### Treat Rust/Actix-Web as a Phase 2 Option

The likely intended framework is `actix-web`, not `active_web`. Rust/Actix is a valid future migration if the API must be separated into a hardened service boundary, but it would require duplicating or rehosting current TypeScript shared schemas, AI SDK integration, and typed panel contracts.

Phase 1 should create clean service boundaries so a future Rust API can replace Hono route-by-route if needed.

## Technical Architecture

### Services

- `postgres`: `pgvector/pgvector:pg17`, persistent volume, healthcheck.
- `migrate`: one-shot Drizzle migration runner.
- `api`: Hono API, auth, RBAC, bot policy endpoints, conversation endpoints.
- `bot`: grammY bot process, uses the same database and policy middleware.
- `panel`: Vite-built React app served by Nginx/Caddy.
- `reverse-proxy` optional: TLS, compression, secure headers, API/panel routing.

### Package Impact

- `packages/database`
  - Add admin, session, role, Telegram chat policy, audit log, and migration tables.
- `packages/shared`
  - Add auth, role, policy, audit, and admin DTO schemas.
- `packages/server`
  - Add auth middleware, cookie sessions, CSRF protection for mutations, RBAC guards, admin routes, policy routes, and audit writing.
- `packages/bot`
  - Add grammY access middleware backed by Telegram chat policy.
- `packages/panel`
  - Replace current single-screen workbench with routed shadcn/Tailwind admin app.
- root
  - Add Dockerfiles, Compose profiles, deployment env docs, seed/bootstrap command, and production smoke checks.

## Data Model Additions

### Admin Security

- `admin_users`
  - `id uuid primary key`
  - `username text unique not null`
  - `display_name text`
  - `password_hash text not null`
  - `role text not null`
  - `status text not null` (`active`, `disabled`)
  - `last_login_at timestamptz`
  - `created_at timestamptz not null`
  - `updated_at timestamptz not null`
- `admin_sessions`
  - `id uuid primary key`
  - `admin_user_id uuid not null`
  - `token_hash text unique not null`
  - `expires_at timestamptz not null`
  - `revoked_at timestamptz`
  - `created_at timestamptz not null`
- `audit_logs`
  - `id uuid primary key`
  - `actor_admin_id uuid`
  - `action text not null`
  - `target_type text not null`
  - `target_id text`
  - `before jsonb`
  - `after jsonb`
  - `ip_address text`
  - `user_agent text`
  - `created_at timestamptz not null`

### Telegram Governance

- `telegram_chats`
  - `chat_id text primary key`
  - `type text not null` (`private`, `group`, `supergroup`, `channel`)
  - `title text`
  - `username text`
  - `status text not null` (`pending`, `approved`, `blocked`, `muted`)
  - `policy text not null` (`allow_all_commands`, `commands_only`, `read_only`, `disabled`)
  - `first_seen_at timestamptz not null`
  - `updated_at timestamptz not null`
- `telegram_chat_members`
  - `chat_id text not null`
  - `telegram_user_id text not null`
  - `role text`
  - `first_seen_at timestamptz not null`
  - `updated_at timestamptz not null`
- `telegram_command_permissions`
  - `id uuid primary key`
  - `chat_id text`
  - `command text not null`
  - `enabled boolean not null`
  - `created_at timestamptz not null`
  - `updated_at timestamptz not null`

## API Contract Additions

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/admin-users`
- `POST /api/admin-users`
- `PATCH /api/admin-users/:id`
- `GET /api/admin-sessions`
- `DELETE /api/admin-sessions/:id`
- `GET /api/audit-logs`
- `GET /api/telegram/chats`
- `PATCH /api/telegram/chats/:chatId`
- `GET /api/telegram/command-permissions`
- `PUT /api/telegram/command-permissions/:id`
- `GET /api/system/status`
- `GET /api/system/settings`
- `PATCH /api/system/settings`

All non-login admin routes require authenticated session and RBAC authorization.

## Permission Model

- `super_admin`
  - Full access.
  - Can create admins, rotate roles, disable accounts, and change Telegram policy.
- `operator`
  - Can manage Telegram chats/users, inspect messages/memories, and use chat tester.
  - Cannot create admin accounts or change roles.
- `auditor`
  - Read-only access to dashboards, data lists, and audit logs.

Implementation should use explicit permission checks such as `admin:write`, `telegram:moderate`, `memory:write`, `audit:read`, not scattered role-name conditionals.

## UI System

Use Tailwind CSS + shadcn/ui style primitives:

- App shell: sidebar, topbar, breadcrumbs, user menu.
- Auth: login form, session-expired state.
- Data: table, filters, pagination, empty state, error state, skeleton.
- Feedback: toast, alert, dialog, confirmation modal.
- Controls: button, input, select, checkbox, switch, tabs, dropdown menu, badge.
- Operations: status cards, audit timeline, policy editor, chat tester.
- Internationalization: global Chinese/English switch, persistent language preference, and complete page-level translation coverage.

Design constraints:

- Admin tool, not marketing page.
- Dense but readable layout.
- No nested card stacks.
- Keyboard accessible controls.
- Desktop-first with usable tablet/mobile fallback.
- Every mutation has success/failure feedback and audit event.
- Chinese and English modes should each read as a complete product surface; keep only unavoidable entity names such as OpenAI, new-api, model IDs, and URLs in their original form.

## Dockerization Plan

### Development Compose

- Uses bind mounts and hot reload.
- Starts `postgres`, `api`, `bot`, and `panel`.
- `bot` can be disabled with a profile when `BOT_TOKEN` is absent.
- `migrate` runs manually or as a one-shot profile.

### Production Compose

- Builds immutable images.
- Panel served as static assets behind reverse proxy.
- API and bot run as separate containers.
- Migration is explicit and idempotent.
- Secrets provided by environment or Docker secrets, never baked into images.

Required files:

- `packages/server/Dockerfile`
- `packages/bot/Dockerfile`
- `packages/panel/Dockerfile`
- root `docker-compose.yml` expanded for full stack
- optional `docker-compose.prod.yml`
- `.env.example` updated with auth/session/policy keys

## Implementation Plan

### Phase 1: Security Foundation

- Add admin/session/audit/Telegram policy schema and migration.
- Add password hashing and session token hashing.
- Add first-admin bootstrap command.
- Add Hono auth middleware and RBAC guard.
- Add audit log writer.
- Add tests for login, session expiry, logout, disabled users, and RBAC denial.

### Phase 2: Telegram Policy Enforcement

- Record every seen Telegram chat and user.
- Block or limit unknown groups according to policy.
- Add admin APIs for approving/blocking chats and command permissions.
- Add bot middleware tests without requiring real Telegram polling.

### Phase 3: shadcn/Tailwind Admin App

- Add shadcn-compatible component primitives.
- Add `/login` route and authenticated app shell.
- Add dashboard, Telegram groups, admin users, audit logs, messages, memories, and settings pages.
- Replace direct unguarded data fetching with authenticated client calls.

### Phase 4: Docker Deployment

- Add server/bot/panel Dockerfiles.
- Expand Compose into full app topology.
- Add migration service.
- Document local and production-like startup.
- Add container smoke test.

### Phase 5: Operational Hardening

- Add rate limiting for login.
- Add CSRF protection for cookie-authenticated mutations.
- Add secure headers in reverse proxy.
- Add session revocation UI.
- Add backup/restore guidance for Postgres volume.

### Phase 6: Runtime Configuration and i18n

- Add persistent runtime settings for gateway preset, base URLs, model IDs, search provider, and search limits.
- Store API keys as write-only encrypted settings gated by `BOOT_SETTINGS_ENCRYPTION_KEY`.
- Wire both API and bot conversation paths to read runtime settings with environment fallback.
- Add Chinese/English i18n to the panel shell, resources, forms, states, and System configuration page.
- Verify desktop and mobile layouts for both languages.

## Acceptance Criteria

- Admin login exists and requires username/password.
- Passwords are stored only as strong hashes.
- Admin session cookie is HTTP-only and expires.
- Unauthenticated users cannot access admin APIs or panel data.
- RBAC prevents operators/auditors from privileged actions.
- Audit log records login, logout, admin changes, Telegram policy changes, and critical data mutations.
- Bot rejects or limits unapproved Telegram groups according to database policy.
- Panel uses Tailwind + shadcn-style components and has routed pages, not one monolithic workbench.
- System page can manage OpenAI-compatible/new-api gateway URLs, chat model, embedding model, image model, and supported web search channel settings.
- Runtime secret values are never returned to the panel; UI only shows configured/missing state.
- Chinese and English panel modes are available globally and persist per browser.
- PostgreSQL + pgvector runs in Docker.
- API, bot, panel, migration, and database can run through Docker Compose.
- Existing chat E2E still passes after auth/policy changes.
- No real secret or default production credential is committed.

## Verification Rubric

- `pnpm check`
- `pnpm build`
- `pnpm db:generate`
- `pnpm db:migrate`
- `pnpm test:e2e`
- API auth tests for login/logout/me/RBAC.
- Bot policy tests for pending/approved/blocked group states.
- Panel build and browser verification for login, dashboard, Telegram groups, admin users, audit logs, System settings, language switching, and mobile layout.
- Docker smoke:
  - `docker compose up -d postgres`
  - migration service succeeds
  - API health succeeds
  - panel serves static app
  - bot container starts only when `BOT_TOKEN` is present

## Open Decisions

- Whether to migrate password hashing from the current scrypt implementation to Argon2id later if native package support and build images remain simple.
- Whether to keep Refine as the data orchestration layer or replace it with TanStack Query plus explicit routes. Prefer TanStack Query if shadcn routed pages become the primary UI model.
- Whether to add a reverse proxy container immediately or document it as production deployment guidance.
- Whether Telegram unknown private chats should be allowed by default while unknown groups are pending.
- Whether Rust/Actix-Web migration is a future target after Phase 1 or out of scope.
