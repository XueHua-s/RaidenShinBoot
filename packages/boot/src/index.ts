import {
  createMemory,
  getRecentMessages,
  getRuntimeSettingsEnvOverrides,
  listMemories,
  saveConversationTurn,
  searchMemories,
  upsertTelegramUser
} from "@raiden/database";
import { isMemoryRecallRequest } from "@raiden/shared";
import { embedText, generateMakotoReply, getBootConfig, summarizeForMemory } from "@raiden/shared/boot";
import { getBootSearchConfig } from "@raiden/shared/search";
import { resolveWebSearchForMessage } from "@raiden/shared/tools";
import { enqueueMemoryEnrichment, isBootQueueConfigured, type MemoryEnrichmentJob } from "./jobs.js";
import {
  buildConversationCacheContextFingerprint,
  conversationCacheScope,
  getSemanticCacheConfig,
  lookupConversationCache,
  writeConversationCache,
  type ConversationCacheHit,
  type ConversationCacheStatus
} from "./semantic-cache.js";

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

type DurableMemoryInput = {
  userId: string;
  displayName: string | null;
  content: string;
  reply: string;
  sourceMessageId: string;
  bootConfig: Awaited<ReturnType<typeof getEffectiveBootConfig>>;
};

function storageUserId(identity: BootUserIdentity) {
  if (identity.protocol === "telegram") {
    return identity.userId;
  }

  return `${identity.protocol}:${identity.userId}`;
}

function envFlag(value: string | undefined, fallback: boolean) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  return !["0", "false", "no", "off", "disabled"].includes(normalized);
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
  const runtimeEnv = await loadRuntimeEnv();
  const bootConfig = getBootConfig(runtimeEnv);
  const searchConfig = getBootSearchConfig(runtimeEnv);
  const semanticCacheConfig = getSemanticCacheConfig(runtimeEnv);
  const userId = storageUserId(input);
  const cacheScope = conversationCacheScope({ protocol: input.protocol, userId: input.userId });

  await rememberBootUser(input);

  const [recentMessages, cacheContextMemories] = await Promise.all([
    getRecentMessages(userId, 12),
    listMemories({ telegramUserId: userId, limit: 10, offset: 0 })
  ]);
  const cacheContextFingerprint = buildConversationCacheContextFingerprint({
    protocol: input.protocol,
    userId: input.userId,
    chatModel: bootConfig.BOOT_CHAT_MODEL,
    embeddingModel: bootConfig.BOOT_EMBEDDING_MODEL,
    searchProvider: searchConfig.BOOT_SEARCH_PROVIDER,
    history: recentMessages,
    memories: cacheContextMemories
  });

  const exactCache = await lookupConversationCache({
    scope: cacheScope,
    contextFingerprint: cacheContextFingerprint,
    content: input.content,
    config: semanticCacheConfig
  });
  if (exactCache.status === "l1_hit") {
    return saveCachedReply({
      input,
      userId,
      hit: exactCache
    });
  }
  let cacheStatus: Extract<ConversationCacheStatus, "disabled" | "miss"> =
    exactCache.status === "disabled" ? "disabled" : "miss";

  const queryEmbedding = await embedText(input.content, bootConfig);
  if (exactCache.status !== "disabled") {
    const semanticCache = await lookupConversationCache({
      scope: cacheScope,
      contextFingerprint: cacheContextFingerprint,
      content: input.content,
      embedding: queryEmbedding,
      config: semanticCacheConfig
    });
    if (semanticCache.status === "l2_hit") {
      return saveCachedReply({
        input,
        userId,
        hit: semanticCache
      });
    }
    cacheStatus = semanticCache.status === "disabled" ? "disabled" : "miss";
  }

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

  const webSearch = await resolveWebSearchForMessage(input.content, { searchConfig });
  const displayName = input.firstName ?? input.username ?? null;

  const reply = await generateMakotoReply({
    userName: displayName,
    content: input.content,
    memories,
    webSearch: webSearch.response,
    webSearchError: webSearch.error,
    config: bootConfig,
    history: recentMessages.map((message: { role: string; content: string }) => ({
      role: message.role as "user" | "assistant" | "system",
      content: message.content
    }))
  });

  const { userMessage, assistantMessage } = await saveConversationTurn({
    telegramUserId: userId,
    telegramMessageId: input.sourceMessageId ?? null,
    userContent: input.content,
    assistantContent: reply
  });

  await scheduleDurableMemoryIfUseful({
    userId,
    displayName,
    content: input.content,
    reply,
    sourceMessageId: userMessage.id,
    bootConfig
  });
  void writeConversationCache({
    scope: cacheScope,
    contextFingerprint: cacheContextFingerprint,
    content: input.content,
    reply,
    embedding: queryEmbedding,
    model: bootConfig.BOOT_CHAT_MODEL,
    config: semanticCacheConfig
  }).then((result) => {
    if (result.status === "write_failed") {
      console.warn("Semantic cache write failed.", result.reason);
    }
  });

  return {
    reply,
    memoryCount: memories.length,
    webSearchResultCount: webSearch.response?.results.length ?? 0,
    webSearchStatus: webSearch.status,
    cacheStatus,
    cacheSimilarity: null,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id
  };
}

async function saveCachedReply(input: {
  input: BootConversationInput;
  userId: string;
  hit: ConversationCacheHit;
}) {
  const { userMessage, assistantMessage } = await saveConversationTurn({
    telegramUserId: input.userId,
    telegramMessageId: input.input.sourceMessageId ?? null,
    userContent: input.input.content,
    assistantContent: input.hit.reply
  });

  return {
    reply: input.hit.reply,
    memoryCount: 0,
    webSearchResultCount: 0,
    webSearchStatus: "skipped" as const,
    cacheStatus: input.hit.status,
    cacheSimilarity: input.hit.similarity,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id
  };
}

async function scheduleDurableMemoryIfUseful(
  input: MemoryEnrichmentJob & {
    bootConfig: Awaited<ReturnType<typeof getEffectiveBootConfig>>;
  }
) {
  const jobInput: MemoryEnrichmentJob = {
    userId: input.userId,
    displayName: input.displayName,
    content: input.content,
    reply: input.reply,
    sourceMessageId: input.sourceMessageId
  };

  if (isBootQueueConfigured() && envFlag(process.env.BOOT_MEMORY_ENRICHMENT_ASYNC_ENABLED, false)) {
    try {
      await enqueueMemoryEnrichment(jobInput);
      return;
    } catch (error) {
      console.warn("Memory enrichment enqueue failed; falling back to background inline task.", error instanceof Error ? error.message : error);
      void createDurableMemoryBestEffort(input, "Background durable memory creation failed after enqueue fallback.");
      return;
    }
  }

  await createDurableMemoryBestEffort(input, "Durable memory creation failed; reply was already saved.");
}

async function createDurableMemoryBestEffort(input: DurableMemoryInput, message: string) {
  try {
    await createDurableMemory(input);
  } catch (error) {
    console.warn(message, error instanceof Error ? error.message : error);
  }
}

async function createDurableMemory(input: DurableMemoryInput) {
  const memorySummary = await summarizeForMemory({
    userName: input.displayName,
    userMessage: input.content,
    assistantReply: input.reply,
    config: input.bootConfig
  });

  if (!memorySummary) {
    return;
  }

  const memoryEmbedding = await embedText(memorySummary, input.bootConfig);
  await createMemory({
    telegramUserId: input.userId,
    summary: memorySummary,
    embedding: memoryEmbedding,
    importance: 6,
    sourceMessageId: input.sourceMessageId
  });
}

export async function processMemoryEnrichmentJob(input: MemoryEnrichmentJob) {
  await createDurableMemory({
    ...input,
    bootConfig: await getEffectiveBootConfig()
  });
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

export * from "./jobs.js";
export * from "./semantic-cache.js";
