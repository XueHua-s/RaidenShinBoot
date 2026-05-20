import { zValidator } from "@hono/zod-validator";
import { getEffectiveBootConfig } from "@raiden/boot";
import { countMemories, createMemory, listMemories } from "@raiden/database";
import { createMemoryRequestSchema, paginationQuerySchema } from "@raiden/shared";
import { embedText } from "@raiden/shared/boot";
import { Hono } from "hono";
import { z } from "zod";
import { requirePermission, type AuthVariables } from "../auth.js";

const memoryQuerySchema = paginationQuerySchema.extend({
  telegramUserId: z.string().optional()
});

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

    return c.json({ data: memory }, 201);
  });
