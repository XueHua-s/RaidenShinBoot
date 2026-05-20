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
import { isMemoryRecallRequest } from "@raiden/shared";
import { embedText, generateMakotoReply, summarizeForMemory } from "@raiden/shared/boot";
import { resolveWebSearchForMessage } from "@raiden/shared/tools";
import { getEffectiveBootConfig, getEffectiveBootSearchConfig } from "./runtime-config.js";

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
  const [bootConfig, searchConfig] = await Promise.all([getEffectiveBootConfig(), getEffectiveBootSearchConfig()]);
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

  const queryEmbedding = await embedText(content, bootConfig);
  let memories = await searchMemories({
    telegramUserId,
    embedding: queryEmbedding,
    limit: 5,
    maxDistance: 0.55
  });
  if (memories.length === 0 && isMemoryRecallRequest(content)) {
    memories = await searchMemories({
      telegramUserId,
      embedding: queryEmbedding,
      limit: 5
    });
  }
  const recentMessages = await getRecentMessages(telegramUserId, 12);
  const webSearch = await resolveWebSearchForMessage(content, { searchConfig });

  const reply = await generateMakotoReply({
    userName: ctx.from?.first_name ?? ctx.from?.username ?? null,
    content,
    memories,
    webSearch: webSearch.response,
    webSearchError: webSearch.error,
    config: bootConfig,
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
    assistantReply: reply,
    config: bootConfig
  });

  if (memorySummary) {
    const memoryEmbedding = await embedText(memorySummary, bootConfig);
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
    memoryCount: memories.length,
    webSearchResultCount: webSearch.response?.results.length ?? 0,
    webSearchStatus: webSearch.status
  };
}

export async function recallMemories(ctx: Context, query: string) {
  const telegramUserId = getTelegramUserId(ctx);
  const embedding = await embedText(query, await getEffectiveBootConfig());
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
