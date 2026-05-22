import { zValidator } from "@hono/zod-validator";
import {
  countTelegramChats,
  deleteTelegramCommandPermission,
  listTelegramChats,
  listTelegramCommandPermissions,
  updateTelegramChat,
  upsertTelegramCommandPermission
} from "@raiden/database";
import {
  paginationQuerySchema,
  updateTelegramChatRequestSchema,
  upsertTelegramCommandPermissionRequestSchema
} from "@raiden/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requirePermission, writeAuditFromContext, type AuthVariables } from "../auth.js";

const commandPermissionQuerySchema = paginationQuerySchema.extend({
  chatId: z.string().optional()
});

function snapshot(value: unknown) {
  return value ? (JSON.parse(JSON.stringify(value)) as Record<string, unknown>) : null;
}

export const telegramRoute = new Hono<{ Variables: AuthVariables }>()
  .get("/chats", zValidator("query", paginationQuerySchema), async (c) => {
    requirePermission(c, "telegram:read");
    const query = c.req.valid("query");
    const [data, total] = await Promise.all([listTelegramChats(query), countTelegramChats()]);

    return c.json({ data, total });
  })
  .patch("/chats/:chatId", zValidator("json", updateTelegramChatRequestSchema), async (c) => {
    requirePermission(c, "telegram:moderate");
    const chatId = c.req.param("chatId");
    const body = c.req.valid("json");
    const updates: Parameters<typeof updateTelegramChat>[1] = {};
    if (body.title !== undefined) {
      updates.title = body.title;
    }
    if (body.username !== undefined) {
      updates.username = body.username;
    }
    if (body.status !== undefined) {
      updates.status = body.status;
    }
    if (body.policy !== undefined) {
      updates.policy = body.policy;
    }

    const { before, after } = await updateTelegramChat(chatId, updates);
    if (!after) {
      throw new HTTPException(404, { message: "Telegram chat not found" });
    }

    await writeAuditFromContext(c, {
      action: "telegram_chat.update",
      targetType: "telegram_chat",
      targetId: chatId,
      before: snapshot(before),
      after: snapshot(after)
    });

    return c.json({ data: after });
  })
  .get("/command-permissions", zValidator("query", commandPermissionQuerySchema), async (c) => {
    requirePermission(c, "telegram:read");
    const query = c.req.valid("query");
    const data = await listTelegramCommandPermissions(query.chatId ? { ...query, chatId: query.chatId } : query);

    return c.json({ data, total: data.length });
  })
  .put("/command-permissions", zValidator("json", upsertTelegramCommandPermissionRequestSchema), async (c) => {
    requirePermission(c, "telegram:moderate");
    const body = c.req.valid("json");
    const permission = await upsertTelegramCommandPermission({
      chatId: body.chatId ?? null,
      command: body.command,
      enabled: body.enabled
    });

    await writeAuditFromContext(c, {
      action: "telegram_command_permission.upsert",
      targetType: "telegram_command_permission",
      targetId: permission.id,
      after: snapshot(permission)
    });

    return c.json({ data: permission });
  })
  .delete("/command-permissions/:id", async (c) => {
    requirePermission(c, "telegram:moderate");
    const id = c.req.param("id");
    const permission = await deleteTelegramCommandPermission(id);
    if (!permission) {
      throw new HTTPException(404, { message: "Telegram command permission not found" });
    }

    await writeAuditFromContext(c, {
      action: "telegram_command_permission.delete",
      targetType: "telegram_command_permission",
      targetId: permission.id,
      before: snapshot(permission)
    });

    return c.json({ data: permission });
  });
