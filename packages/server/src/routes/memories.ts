import { zValidator } from "@hono/zod-validator";
import { getEffectiveBootConfig } from "@raiden/boot";
import { countMemories, createMemory, listMemories, searchMemories } from "@raiden/database";
import { createMemoryRequestSchema, memorySearchRequestSchema, paginationQuerySchema } from "@raiden/shared";
import { embedText } from "@raiden/shared/boot";
import { Hono } from "hono";
import { z } from "zod";
import { requirePermission, type AuthVariables } from "../auth.js";

const memoryQuerySchema = paginationQuerySchema.extend({
  telegramUserId: z.string().optional()
});

function memoryDto(memory: Awaited<ReturnType<typeof createMemory>>) {
  return {
    id: memory.id,
    telegramUserId: memory.telegramUserId,
    summary: memory.summary,
    importance: memory.importance,
    sourceMessageId: memory.sourceMessageId,
    createdAt: memory.createdAt.toISOString(),
    lastAccessedAt: memory.lastAccessedAt?.toISOString() ?? null
  };
}

export const memoriesRoute = new Hono<{ Variables: AuthVariables }>()
  .get("/", zValidator("query", memoryQuerySchema), async (c) => {
    requirePermission(c, "memory:read");
    const query = c.req.valid("query");
    const [data, total] = await Promise.all([
      listMemories(query),
      countMemories(query.telegramUserId)
    ]);

    return c.json({ data, total });
  })
  .post("/search", zValidator("json", memorySearchRequestSchema), async (c) => {
    requirePermission(c, "memory:read");
    const body = c.req.valid("json");
    const embedding = await embedText(body.query, await getEffectiveBootConfig());
    const rows = await searchMemories({
      telegramUserId: body.telegramUserId,
      embedding,
      limit: body.limit,
      touchLastAccessed: false
    });

    return c.json({
      data: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        lastAccessedAt: row.lastAccessedAt?.toISOString() ?? null
      }))
    });
  })
  .post("/", zValidator("json", createMemoryRequestSchema), async (c) => {
    requirePermission(c, "memory:write");
    const body = c.req.valid("json");
    const embedding = await embedText(body.summary, await getEffectiveBootConfig());
    const memory = await createMemory({
      telegramUserId: body.telegramUserId,
      summary: body.summary,
      importance: body.importance,
      embedding
    });

    return c.json({ data: memoryDto(memory) }, 201);
  });
