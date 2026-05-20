import {
  createMemory,
  ensureConversation,
  getRecentMessages,
  getRuntimeSettingsEnvOverrides,
  listMemories,
  saveMessage,
  searchMemories,
  upsertTelegramUser
} from "@raiden/database";
import { isMemoryRecallRequest } from "@raiden/shared";
import { embedText, generateMakotoReply, getBootConfig, summarizeForMemory } from "@raiden/shared/boot";
import { getBootSearchConfig } from "@raiden/shared/search";
import { resolveWebSearchForMessage } from "@raiden/shared/tools";

let runtimeSettingsWarningEmitted = false;

export type BootProtocol = "telegram" | "web" | "wechat" | (string & {});

export type BootUserIdentity = {
  protocol: BootProtocol;
  userId: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
};

export type BootConversationInput = BootUserIdentity & {
  content: string;
  sourceMessageId?: number | null;
};

function storageUserId(identity: BootUserIdentity) {
  if (identity.protocol === "telegram") {
    return identity.userId;
  }

  return `${identity.protocol}:${identity.userId}`;
}

export async function loadRuntimeEnv() {
  if (!process.env.DATABASE_URL) {
    return process.env;
  }

  try {
    const overrides = await getRuntimeSettingsEnvOverrides();
    return {
      ...process.env,
      ...overrides
    };
  } catch (error) {
    if (!runtimeSettingsWarningEmitted) {
      runtimeSettingsWarningEmitted = true;
      console.warn(
        "Runtime settings could not be loaded; falling back to process env.",
        error instanceof Error ? error.message : error
      );
    }
    return process.env;
  }
}

export async function getEffectiveBootConfig() {
  return getBootConfig(await loadRuntimeEnv());
}

export async function getEffectiveBootSearchConfig() {
  return getBootSearchConfig(await loadRuntimeEnv());
}

export async function rememberBootUser(identity: BootUserIdentity) {
  return upsertTelegramUser({
    telegramId: storageUserId(identity),
    username: identity.username ?? null,
    firstName: identity.firstName ?? null,
    lastName: identity.lastName ?? null,
    languageCode: identity.languageCode ?? null
  });
}

export async function runBootConversation(input: BootConversationInput) {
  const [bootConfig, searchConfig] = await Promise.all([getEffectiveBootConfig(), getEffectiveBootSearchConfig()]);
  const userId = storageUserId(input);

  await rememberBootUser(input);

  const conversation = await ensureConversation(userId);
  const userMessage = await saveMessage({
    conversationId: conversation.id,
    telegramUserId: userId,
    telegramMessageId: input.sourceMessageId ?? null,
    role: "user",
    content: input.content
  });

  const queryEmbedding = await embedText(input.content, bootConfig);
  let memories = await searchMemories({
    telegramUserId: userId,
    embedding: queryEmbedding,
    limit: 5,
    maxDistance: 0.55
  });
  if (memories.length === 0 && isMemoryRecallRequest(input.content)) {
    memories = await searchMemories({
      telegramUserId: userId,
      embedding: queryEmbedding,
      limit: 5
    });
  }

  const recentMessages = await getRecentMessages(userId, 12);
  const webSearch = await resolveWebSearchForMessage(input.content, { searchConfig });
  const displayName = input.firstName ?? input.username ?? null;

  const reply = await generateMakotoReply({
    userName: displayName,
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
    telegramUserId: userId,
    role: "assistant",
    content: reply
  });

  const memorySummary = await summarizeForMemory({
    userName: displayName,
    userMessage: input.content,
    assistantReply: reply,
    config: bootConfig
  });

  if (memorySummary) {
    const memoryEmbedding = await embedText(memorySummary, bootConfig);
    await createMemory({
      telegramUserId: userId,
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

export async function recallBootMemories(input: BootUserIdentity & { query: string; limit?: number }) {
  const embedding = await embedText(input.query, await getEffectiveBootConfig());
  return searchMemories({
    telegramUserId: storageUserId(input),
    embedding,
    limit: input.limit ?? 6
  });
}

export async function listBootMemories(input: BootUserIdentity & { limit?: number; offset?: number }) {
  return listMemories({
    telegramUserId: storageUserId(input),
    limit: input.limit ?? 8,
    offset: input.offset ?? 0
  });
}
