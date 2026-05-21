# Raiden Subagent Design Notes

This directory contains project-level Claude Code subagents. Files with `name`
frontmatter are loaded as agents; this README is documentation only.

## Reference Project Lessons

The reference project treats tools and agents as a small runtime system rather
than a flat prompt list:

- Tool definitions are the source of truth. Each tool declares its schema,
  result schema, read/write behavior, concurrency safety, destructive behavior,
  result budget, and user-facing summary.
- Tool discovery is separate from tool execution. Heavy or rarely used tools can
  be deferred, then found by exact `select:` queries or keyword search over tool
  names, search hints, and descriptions.
- Search tools are optimized for context hygiene: exact-name fast paths, scored
  keyword matching, required `+term` filters, result limits, cache invalidation
  when the deferred pool changes, and pending-server feedback when a search has
  no match.
- Dynamic listings should live in messages or attachments when possible, not in
  stable tool descriptions, so changing agents, MCP servers, or plugins does not
  invalidate the main tool prompt cache.
- Read-only exploration and planning agents should have narrow tool access,
  strong no-write rules, and less inherited context. The parent agent keeps the
  full project policy and synthesizes the findings.
- Implementation agents should own a bounded package scope. Prompts must name
  what is in scope, what is out of scope, and which validation commands prove
  the work.
- Verification is adversarial and evidence-based. A verifier should run commands
  and report exact command/output/result blocks instead of passing by code
  inspection.
- Permissions fail closed. If a tool cannot prove an action is safe, it asks or
  rejects. Agents mirror that by avoiding broad write scopes and by using
  explicit disallowed tools for read-only roles.

## Raiden Agent Set

- `raiden-explore`: fast read-only codebase search and package boundary tracing.
- `raiden-plan`: read-only SDD planner for architecture, decomposition, and
  verification rubrics.
- `raiden-backend-worker`: implementation worker for `boot`, `shared`,
  `database`, `server`, and `bot` changes.
- `raiden-panel-worker`: implementation worker for the React/Refine admin panel.
- `raiden-tooling-architect`: search/tool registry specialist inspired by the
  reference project's ToolSearch and tool metadata design.
- `raiden-reviewer`: review-only diff reviewer using the local review skill.
- `raiden-verifier`: evidence-first verifier for non-trivial completed changes.

Prefer the read-only agents before large edits when the affected files are not
obvious. Prefer worker agents only when their package ownership is a clean fit.
