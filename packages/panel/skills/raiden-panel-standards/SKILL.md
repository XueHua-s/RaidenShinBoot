---
name: raiden-panel-standards
description: Standards for RaidenShinBoot admin panel work. Use for React 19, Refine v4, Tailwind CSS v4, Hono typed client integration, runtime status UX, resource tables, dashboard components, and panel validation.
---

# Raiden Panel Standards

Use this as the default skill for `packages/panel` work.

## Architecture

- React entry: `src/main.tsx`
- Workbench UI: `src/App.tsx`
- API boundary: `src/lib/apiClient.ts`
- Refine data boundary: `src/lib/dataProvider.ts`
- Reusable panel primitives: `src/components/*`
- Styling: Tailwind CSS v4 via `src/styles.css`

## API Integration

- Use `hc<AppType>` from `hono/client`; import `AppType` from `@raiden/server/app`.
- Do not duplicate server response types when the typed client can infer them.
- If adding a new resource, update:
  1. server route
  2. shared schema/type if cross-package
  3. panel data provider
  4. panel UI state

## Refine Rules

- Keep Refine as the data orchestration layer, not the visual design system.
- Data provider should adapt API payloads to Refine's `{ data, total }` shape.
- Keep generic casting at the data-provider boundary only; avoid spreading casts through UI components.

## UI/UX Rules

- Admin panel is a workbench, not a landing page.
- Prioritize dense but readable status, data, and actions.
- Every data surface should cover loading, empty, error, and disabled states.
- Environment faults such as missing `DATABASE_URL` should be explicit and non-spammy.
- Use lucide-react icons for buttons and status affordances.
- Keep cards to actual repeated items, panels, and tool surfaces; avoid nested decorative card stacks.
- Text should fit on mobile and desktop; test narrow width after layout changes.

## React Performance

- Prefer derived values during render over effect-driven mirrored state.
- Use primitive dependencies for hooks where possible.
- Avoid defining components inside components.
- Load `skills/vercel-react-best-practices/SKILL.md` for performance or bundle work.

## Validation

- Type check: `pnpm --filter @raiden/panel check`
- Build: `pnpm --filter @raiden/panel build`
- Dev: `pnpm --filter @raiden/panel dev`
- If route types changed, also run `pnpm --filter @raiden/server check`.
- For visual/layout changes, verify desktop and mobile screenshots against the running Vite app.

