import {
  createMemory,
  ensureConversation,
  getRecentMessages,
  saveMessage,
  searchMemories,
  upsertTelegramUser
} from "@raiden/database";
import { isMemoryRecallRequest } from "@raiden/shared";
import { embedText, generateMakotoReply, summarizeForMemory } from "@raiden/shared/boot";
import { resolveWebSearchForMessage } from "@raiden/shared/tools";
import { getEffectiveBootConfig, getEffectiveBootSearchConfig } from "../runtime-config.js";

export type ConversationInput = {
  telegramUserId: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
  content: string;
  telegramMessageId?: number | null;
};

export async function handleConversation(input: ConversationInput) {
  const [bootConfig, searchConfig] = await Promise.all([getEffectiveBootConfig(), getEffectiveBootSearchConfig()]);

  await upsertTelegramUser({
    telegramId: input.telegramUserId,
    username: input.username ?? null,
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    languageCode: input.languageCode ?? null
  });

  const conversation = await ensureConversation(input.telegramUserId);
  const userMessage = await saveMessage({
    conversationId: conversation.id,
    telegramUserId: input.telegramUserId,
    telegramMessageId: input.telegramMessageId ?? null,
    role: "user",
    content: input.content
  });

  const queryEmbedding = await embedText(input.content, bootConfig);
  let memories = await searchMemories({
    telegramUserId: input.telegramUserId,
    embedding: queryEmbedding,
    limit: 5,
    maxDistance: 0.55
  });
  if (memories.length === 0 && isMemoryRecallRequest(input.content)) {
    memories = await searchMemories({
      telegramUserId: input.telegramUserId,
      embedding: queryEmbedding,
      limit: 5
    });
  }
  const recentMessages = await getRecentMessages(input.telegramUserId, 12);
  const webSearch = await resolveWebSearchForMessage(input.content, { searchConfig });

  const reply = await generateMakotoReply({
    userName: input.firstName ?? input.username ?? null,
    content: input.content,
    memories,
    webSearch: webSearch.response,
    webSearchError: webSearch.error,
    config: bootConfig,
    history: recentMessages.map((message) => ({
      role: message.role as "user" | "assistant" | "system",
      content: message.content
    }))
  });

  const assistantMessage = await saveMessage({
    conversationId: conversation.id,
    telegramUserId: input.telegramUserId,
    role: "assistant",
    content: reply
  });

  const memorySummary = await summarizeForMemory({
    userName: input.firstName ?? input.username ?? null,
    userMessage: input.content,
    assistantReply: reply,
    config: bootConfig
  });

  if (memorySummary) {
    const memoryEmbedding = await embedText(memorySummary, bootConfig);
    await createMemory({
      telegramUserId: input.telegramUserId,
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
    webSearchStatus: webSearch.status,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id
  };
}
