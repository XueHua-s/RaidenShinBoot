---
title: Support image generation boot capability
type: feature
depends_on:
  - boot-memory-closure
---

# Support Image Generation Boot Capability

## Description

Add image generation as a first-class boot capability alongside chat and embeddings. The feature must support OpenAI-compatible image models with independent base URL and API key configuration, expose a typed Hono route, provide a Telegram bot command, and validate the payload in E2E without leaking secrets.

## Acceptance Criteria

- Shared boot supports image generation through Vercel AI SDK v6 `generateImage`.
- Image generation can use `BOOT_IMAGE_BASE_URL`, `BOOT_IMAGE_API_KEY`, and `BOOT_IMAGE_MODEL` independently from chat and embedding.
- Hono exposes `POST /api/images`.
- grammY bot exposes `/draw <prompt>`.
- E2E smoke verifies the image generation route, base64 image payload, media type, and Makoto visual prompt guidance against a local OpenAI-compatible mock relay.
- README explains chat, embedding, and image model configuration clearly.
- Real provider smoke confirms `api.burn.hair` can generate an image through `gpt-image-1`.
- No relay keys, bot tokens, image payloads, or generated assets are committed.

## Execution Summary

- Added `generateMakotoImage` to `packages/shared/src/boot.ts`.
- Added image request/response schemas to `packages/shared/src/schemas.ts`.
- Added `packages/server/src/routes/images.ts` and wired it into `AppType`.
- Added Telegram `/draw` command using `replyWithPhoto`.
- Extended `pnpm test:e2e` with local `/v1/images/generations` mock coverage.
- Verified real image generation with `api.burn.hair` + `gpt-image-1`; returned `image/png` base64 successfully.
