# Claude Skills Guide For packages/panel

Use this file when Claude is working inside `packages/panel`. Do not load the entire `skills/` directory by default. Start with the smallest matching skill set.

## How To Use

- Skill entry points live at `skills/*/SKILL.md`
- Start with `skills/raiden-panel-standards/SKILL.md` unless another skill is clearly a better fit
- Read the matching `SKILL.md` first, then load only the referenced `references/*` files you actually need
- If the task crosses into API routes, database schema, bot behavior, shared prompt, or root scripts, also read the parent `AGENTS.md` and root skills as needed

## Skill Routing

- `skills/raiden-panel-standards/SKILL.md`
  Default entry for panel work, Refine data provider, Hono typed client, runtime status, Tailwind v4, and local validation commands.
- `skills/software-design-philosophy/SKILL.md`
  Use for component decomposition, module boundaries, interface cleanup, and complexity reduction.
- `skills/code-review-expert/SKILL.md`
  Use for reviewing the current diff and prioritizing bugs, regressions, and missing tests.
- `skills/frontend-design/SKILL.md`
  Use for pages, components, interaction design, and visual quality work.
- `skills/product-designer/SKILL.md`
  Use for product flows, IA, usability, and design-system decisions.
- `skills/vercel-react-best-practices/SKILL.md`
  Use for React performance optimization, bundle size reduction, eliminating waterfalls, re-render optimization, and data fetching best practices.

## Local Conventions To Reuse

- Use `src/lib/apiClient.ts` for Hono typed API access.
- Use `src/lib/dataProvider.ts` for Refine resource integration.
- Reuse `src/components/*` for metrics, empty states, status pills, and console panels before adding new primitives.
- Keep panel copy concise and operational; avoid explanatory in-app prose unless it is actionable status.

## Guardrails

- Do not introduce a new library or pattern before checking the relevant skill and existing local utilities.
- Do not bulk-load every file under `references/`; open only what the current task needs.
- If a skill and the current codebase differ, trust the live code structure first and adapt minimally.

