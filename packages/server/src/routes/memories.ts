import { zValidator } from "@hono/zod-validator";
import { countMemories, createMemory, listMemories } from "@raiden/database";
import { createMemoryRequestSchema, paginationQuerySchema } from "@raiden/shared";
import { embedText } from "@raiden/shared/boot";
import { Hono } from "hono";
import { z } from "zod";

const memoryQuerySchema = paginationQuerySchema.extend({
  telegramUserId: z.string().optional()
});

export const memoriesRoute = new Hono()
  .get("/", zValidator("query", memoryQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const [data, total] = await Promise.all([
      listMemories(query),
      countMemories(query.telegramUserId)
    ]);

    return c.json({ data, total });
  })
  .post("/", zValidator("json", createMemoryRequestSchema), async (c) => {
    const body = c.req.valid("json");
    const embedding = await embedText(body.summary);
    const memory = await createMemory({
      telegramUserId: body.telegramUserId,
      summary: body.summary,
      importance: body.importance,
      embedding
    });

    return c.json({ data: memory }, 201);
  });

