# Codex Skills Guide

Use this file when Codex CLI needs to load local skills in the monorepo. Do not scan the entire `skills/` tree by default. Pick the smallest relevant set, then read only the matching `SKILL.md` files.

## How To Use

- Skill entry points live at `skills/*/SKILL.md`
- Read the matching `SKILL.md` first, then load only the referenced `references/*` files you actually need
- If paths, package boundaries, scripts, or dependency placement are unclear, start with `skills/raiden-project-structure/SKILL.md`
- If the task is really inside `packages/panel`, switch to `packages/panel/.agents/skills.md`
- If a task spans the root monorepo and `packages/panel`, combine skills from both sides, but keep loaded context minimal

## Skill Routing

- `skills/raiden-project-structure/SKILL.md`
  Use for package discovery, workspace scripts, dependency placement, and verification selection.
- `skills/raiden-project-spec/SKILL.md`
  Use for cross-package refactors, API/database/bot/panel contract changes, memory pipeline work, and validation gates.
- `skills/software-design-philosophy/SKILL.md`
  Use for module design, deep abstractions, information hiding, and complexity reduction.
- `skills/code-review-expert/SKILL.md`
  Use for reviewing the current diff and reporting issues by risk level.
- `skills/frontend-design/SKILL.md`
  Use for UI work in `packages/panel`.
- `skills/product-designer/SKILL.md`
  Use for product design, IA, usability, and design-system thinking.
- `skills/plan-task/SKILL.md`
  Use for SDD planning (`SDD模式` / `sdd:plan` / `/plan-task`): refining a draft task into an implementation-ready specification with architecture, decomposition, parallelization, and verification rubrics.

## Guardrails

- Do not apply a generic solution before reading the relevant skill.
- Do not bulk-load every file under `references/`; open only what the current task needs.
- If a skill and the current codebase differ, trust the live code structure first and adapt minimally.
