import { zValidator } from "@hono/zod-validator";
import { countMessages, listMessages } from "@raiden/database";
import { paginationQuerySchema } from "@raiden/shared";
import { Hono } from "hono";
import { z } from "zod";

const messageQuerySchema = paginationQuerySchema.extend({
  telegramUserId: z.string().optional()
});

export const messagesRoute = new Hono().get("/", zValidator("query", messageQuerySchema), async (c) => {
  const query = c.req.valid("query");
  const [data, total] = await Promise.all([
    listMessages(query),
    countMessages(query.telegramUserId)
  ]);

  return c.json({ data, total });
});

