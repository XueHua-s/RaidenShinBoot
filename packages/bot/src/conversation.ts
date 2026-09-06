import type { Context } from "grammy";
import {
  clearBootConversation,
  forgetBootMemories,
  getBootPrivacyMode,
  listBootMemories,
  recallBootMemories,
  rememberBootUser,
  runBootConversation,
  setBootPrivacyMode,
  summarizeBootConversation,
  type BootUserIdentity
} from "@raiden/boot";
import type { TelegramPrivacyMode } from "@raiden/shared";

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

function telegramScope(ctx: Context) {
  return {
    sourceChatId: ctx.chat?.id === undefined ? null : String(ctx.chat.id),
    sourceChatType: ctx.chat?.type ?? null,
    sourceThreadId: ctx.msg?.message_thread_id === undefined ? null : String(ctx.msg.message_thread_id)
  };
}

export async function rememberTelegramUser(ctx: Context) {
  if (!ctx.from) {
    return null;
  }

  return rememberBootUser(telegramIdentity(ctx));
}

export async function replyAsMakoto(ctx: Context, content: string, abortSignal?: AbortSignal) {
  return runBootConversation({
    ...telegramIdentity(ctx),
    ...telegramScope(ctx),
    content,
    sourceMessageId: ctx.message?.message_id ?? null,
    ...(abortSignal ? { abortSignal } : {}),
    toolPermission: {
      actorId: String(ctx.from?.id),
      chatId: ctx.chat?.id === undefined ? null : String(ctx.chat.id)
    }
  });
}

export async function recallMemories(ctx: Context, query: string) {
  return recallBootMemories({ ...telegramIdentity(ctx), ...telegramScope(ctx), query, limit: 6 });
}

export async function getMemoryList(ctx: Context) {
  return listBootMemories({ ...telegramIdentity(ctx), ...telegramScope(ctx), limit: 8, offset: 0 });
}

export function getPrivacyMode(ctx: Context) {
  return getBootPrivacyMode(telegramIdentity(ctx));
}

export function setPrivacyMode(ctx: Context, privacyMode: TelegramPrivacyMode) {
  return setBootPrivacyMode(telegramIdentity(ctx), privacyMode);
}

export function forgetAllMemories(ctx: Context) {
  return forgetBootMemories(telegramIdentity(ctx));
}

export function clearCurrentConversation(ctx: Context) {
  return clearBootConversation({ ...telegramIdentity(ctx), ...telegramScope(ctx) });
}

export function summarizeCurrentConversation(ctx: Context) {
  return summarizeBootConversation({ ...telegramIdentity(ctx), ...telegramScope(ctx) });
}
