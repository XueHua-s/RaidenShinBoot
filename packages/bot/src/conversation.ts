import type { Context } from "grammy";
import {
  createMemory,
  ensureConversation,
  getRecentMessages,
  listMemories,
  saveMessage,
  searchMemories,
  upsertTelegramUser
} from "@raiden/database";
import { embedText, generateMakotoReply, summarizeForMemory } from "@raiden/shared/boot";

export function getTelegramUserId(ctx: Context) {
  const id = ctx.from?.id;
  if (!id) {
    throw new Error("Telegram user is missing");
  }

  return String(id);
}

export async function rememberTelegramUser(ctx: Context) {
  if (!ctx.from) {
    return null;
  }

  return upsertTelegramUser({
    telegramId: String(ctx.from.id),
    username: ctx.from.username ?? null,
    firstName: ctx.from.first_name ?? null,
    lastName: ctx.from.last_name ?? null,
    languageCode: ctx.from.language_code ?? null
  });
}

export async function replyAsMakoto(ctx: Context, content: string) {
  const telegramUserId = getTelegramUserId(ctx);
  await rememberTelegramUser(ctx);

  const conversation = await ensureConversation(telegramUserId);
  const userMessage = await saveMessage({
    conversationId: conversation.id,
    telegramUserId,
    telegramMessageId: ctx.message?.message_id ?? null,
    role: "user",
    content
  });

  const queryEmbedding = await embedText(content);
  const memories = await searchMemories({
    telegramUserId,
    embedding: queryEmbedding,
    limit: 5,
    maxDistance: 0.55
  });
  const recentMessages = await getRecentMessages(telegramUserId, 12);

  const reply = await generateMakotoReply({
    userName: ctx.from?.first_name ?? ctx.from?.username ?? null,
    content,
    memories,
    history: recentMessages.map((message) => ({
      role: message.role as "user" | "assistant" | "system",
      content: message.content
    }))
  });

  await saveMessage({
    conversationId: conversation.id,
    telegramUserId,
    role: "assistant",
    content: reply
  });

  const memorySummary = await summarizeForMemory({
    userName: ctx.from?.first_name ?? ctx.from?.username ?? null,
    userMessage: content,
    assistantReply: reply
  });

  if (memorySummary) {
    const memoryEmbedding = await embedText(memorySummary);
    await createMemory({
      telegramUserId,
      summary: memorySummary,
      embedding: memoryEmbedding,
      importance: 6,
      sourceMessageId: userMessage.id
    });
  }

  return {
    reply,
    memoryCount: memories.length
  };
}

export async function recallMemories(ctx: Context, query: string) {
  const telegramUserId = getTelegramUserId(ctx);
  const embedding = await embedText(query);
  return searchMemories({
    telegramUserId,
    embedding,
    limit: 6
  });
}

export async function getMemoryList(ctx: Context) {
  return listMemories({
    telegramUserId: getTelegramUserId(ctx),
    limit: 8,
    offset: 0
  });
}

