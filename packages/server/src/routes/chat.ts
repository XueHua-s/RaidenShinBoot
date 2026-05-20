import { zValidator } from "@hono/zod-validator";
import { chatRequestSchema } from "@raiden/shared";
import { Hono } from "hono";
import { requirePermission, type AuthVariables } from "../auth.js";
import { handleConversation } from "../services/conversation.js";

export const chatRoute = new Hono<{ Variables: AuthVariables }>().post("/", zValidator("json", chatRequestSchema), async (c) => {
  requirePermission(c, "conversation:write");
  const body = c.req.valid("json");
  const result = await handleConversation({
    telegramUserId: body.telegramUserId,
    username: body.username ?? null,
    content: body.content
  });

  return c.json({
    reply: result.reply,
    memoryCount: result.memoryCount,
    webSearchResultCount: result.webSearchResultCount,
    webSearchStatus: result.webSearchStatus,
    cacheStatus: result.cacheStatus,
    cacheSimilarity: result.cacheSimilarity
  });
});
