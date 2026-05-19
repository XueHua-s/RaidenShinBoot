import { zValidator } from "@hono/zod-validator";
import { chatRequestSchema } from "@raiden/shared";
import { Hono } from "hono";
import { handleConversation } from "../services/conversation.js";

export const chatRoute = new Hono().post("/", zValidator("json", chatRequestSchema), async (c) => {
  const body = c.req.valid("json");
  const result = await handleConversation({
    telegramUserId: body.telegramUserId,
    username: body.username ?? null,
    content: body.content
  });

  return c.json({
    reply: result.reply,
    memoryCount: result.memoryCount
  });
});

