import type { Context, MiddlewareFn } from "grammy";
import { resolveTelegramChatAccess, upsertTelegramChatMember, upsertTelegramUser } from "@raiden/database";

function textCommand(ctx: Context) {
  const text = ctx.message && "text" in ctx.message ? ctx.message.text : undefined;
  const match = text?.trim().match(/^\/([a-zA-Z0-9_]+)/);
  return match?.[1]?.toLowerCase() ?? null;
}

function chatTitle(ctx: Context) {
  return ctx.chat && "title" in ctx.chat ? ctx.chat.title : null;
}

function chatUsername(ctx: Context) {
  return ctx.chat && "username" in ctx.chat ? ctx.chat.username : null;
}

async function rememberActor(ctx: Context) {
  if (!ctx.from || !ctx.chat) {
    return;
  }

  await upsertTelegramUser({
    telegramId: String(ctx.from.id),
    username: ctx.from.username ?? null,
    firstName: ctx.from.first_name ?? null,
    lastName: ctx.from.last_name ?? null,
    languageCode: ctx.from.language_code ?? null
  });
  await upsertTelegramChatMember({
    chatId: String(ctx.chat.id),
    telegramUserId: String(ctx.from.id),
    role: null
  });
}

export const enforceTelegramAccess: MiddlewareFn<Context> = async (ctx, next) => {
  if (!ctx.chat) {
    await next();
    return;
  }

  const command = textCommand(ctx);
  const accessInput: Parameters<typeof resolveTelegramChatAccess>[0] = {
    chatId: String(ctx.chat.id),
    type: ctx.chat.type,
    command
  };
  const title = chatTitle(ctx);
  const username = chatUsername(ctx);
  if (title !== undefined) {
    accessInput.title = title;
  }
  if (username !== undefined) {
    accessInput.username = username;
  }

  const access = await resolveTelegramChatAccess(accessInput);
  await rememberActor(ctx);

  if (access.allowed) {
    await next();
    return;
  }

  if (command || ctx.chat.type === "private") {
    const message =
      access.reason === "pending"
        ? "当前会话尚未在后台审批。请联系管理员在 Telegram > Groups 中批准。"
        : "当前会话没有使用 RaidenShinBoot 的权限。";
    await ctx.reply(message);
  }
};
