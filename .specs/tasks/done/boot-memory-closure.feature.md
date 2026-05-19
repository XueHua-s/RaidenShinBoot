---
title: Verify boot memory closure
type: feature
depends_on:
  - e2e-completion
---

# Verify Boot Memory Closure

## Description

Strengthen RaidenShinBoot boot validation so the bot proves a complete user-impression loop: a user tells Makoto a stable preference, the system summarizes it into long-term memory, stores a 3072-dimensional vector, later retrieves it for an indirect memory/impression request, and Makoto naturally uses that impression in the reply.

## Acceptance Criteria

- API chat E2E covers at least two turns for the same user.
- Bot core E2E covers at least two turns for the same user.
- First turn creates a durable memory containing the user's nickname and preference.
- Second turn asks an indirect memory/impression question and retrieves long-term memory.
- The generated prompt includes the retrieved memory before the model replies.
- The final reply naturally references the stored user impression.
- Real relay smoke confirms `gpt-5.5` streaming chat plus `text-embedding-3-large` 3072-dimensional embeddings work together.
- Test data is deleted after every smoke run.
- Secrets remain only in process environment and are not committed.

## Execution Summary

- Added `isMemoryRecallRequest` in `@raiden/shared` for recall/impression-style queries.
- Added a fallback memory search without the strict distance threshold when a recall/impression query does not pass the normal threshold.
- Applied the fallback to both Hono API chat and grammY bot core chat paths.
- Extended `pnpm test:e2e` to verify API and bot multi-turn memory loops, retrieved-memory prompt injection, and natural user-impression replies.
- Verified the real relay combination with temporary keys: `proxy.xhblog.top` `gpt-5.5` streaming chat and `api.burn.hair` `text-embedding-3-large` 3072-dimensional embeddings.
