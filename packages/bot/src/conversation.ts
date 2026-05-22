import type { Context } from "grammy";
import {
  listBootMemories,
  recallBootMemories,
  rememberBootUser,
  runBootConversation,
  type BootUserIdentity
} from "@raiden/boot";

export function getTelegramUserId(ctx: Context) {
  const id = ctx.from?.id;
  if (!id) {
    throw new Error("Telegram user is missing");
  }

  return String(id);
}

function telegramIdentity(ctx: Context): BootUserIdentity {
  return {
    protocol: "telegram",
    userId: getTelegramUserId(ctx),
    username: ctx.from?.username ?? null,
    firstName: ctx.from?.first_name ?? null,
    lastName: ctx.from?.last_name ?? null,
    languageCode: ctx.from?.language_code ?? null
  };
}

export async function rememberTelegramUser(ctx: Context) {
  if (!ctx.from) {
    return null;
  }

  return rememberBootUser(telegramIdentity(ctx));
}

export async function replyAsMakoto(ctx: Context, content: string) {
  return runBootConversation({
    ...telegramIdentity(ctx),
    content,
    sourceChatId: ctx.chat?.id === undefined ? null : String(ctx.chat.id),
    sourceMessageId: ctx.message?.message_id ?? null,
    toolPermission: {
      actorId: String(ctx.from?.id),
      chatId: ctx.chat?.id === undefined ? null : String(ctx.chat.id)
    }
  });
}

export async function recallMemories(ctx: Context, query: string) {
  return recallBootMemories({ ...telegramIdentity(ctx), query, limit: 6 });
}

export async function getMemoryList(ctx: Context) {
  return listBootMemories({ ...telegramIdentity(ctx), limit: 8, offset: 0 });
}
