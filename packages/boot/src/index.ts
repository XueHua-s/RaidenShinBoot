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
import { embedText, generateMakotoImage, generateMakotoReply, getBootConfig, summarizeForMemory } from "@raiden/shared/boot";
import { getBootSearchConfig } from "@raiden/shared/search";
import {
  executeBootTool,
  resolveWebSearchForMessage,
  type BootToolContext,
  type BootToolInput,
  type BootToolName,
  type BootToolOutput,
  type BootToolPermissionContext
} from "@raiden/shared/tools";
import { enqueueMemoryEnrichment, getBootQueueConfig, isBootQueueConfigured, type MemoryEnrichmentJob } from "./jobs.js";
import {
  buildConversationCacheContextFingerprint,
  conversationCacheScope,
  getSemanticCacheConfig,
  lookupConversationCache,
  writeConversationCache,
  type ConversationCacheHit,
  type ConversationCacheMetadata,
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

type RuntimeEnv = NodeJS.ProcessEnv;

type CacheContextMessage = {
  id?: string | undefined;
  role: string;
  content: string;
  createdAt?: Date | string | undefined;
};

type CacheContextMemory = {
  id: string;
  summary: string;
  importance: number;
  sourceMessageId: string | null;
  createdAt?: Date | string | undefined;
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

export type EffectiveBootToolOptions = {
  permission?: BootToolPermissionContext;
  audit?: BootToolContext["audit"];
  fetch?: typeof fetch;
  searchConfig?: BootToolContext["searchConfig"];
  imageGenerator?: BootToolContext["imageGenerator"];
};

const searchBootToolNames = new Set<BootToolName>(["web_search", "google_search", "wikipedia_search", "moegirl_search"]);

export async function getEffectiveBootToolContext(
  nameOrOptions: BootToolName | EffectiveBootToolOptions = {},
  maybeOptions: EffectiveBootToolOptions = {}
): Promise<BootToolContext> {
  const toolName = typeof nameOrOptions === "string" ? nameOrOptions : undefined;
  const options = typeof nameOrOptions === "string" ? maybeOptions : nameOrOptions;
  const context: BootToolContext = {};

  if (options.searchConfig !== undefined) {
    context.searchConfig = options.searchConfig;
  } else if (toolName === undefined || searchBootToolNames.has(toolName)) {
    context.loadSearchConfig = async () => getBootSearchConfig(await loadRuntimeEnv());
  }

  if (options.imageGenerator !== undefined) {
    context.imageGenerator = options.imageGenerator;
  } else if (toolName === undefined || toolName === "makoto_image") {
    context.imageGenerator = async (input) => {
      const bootConfig = getBootConfig(await loadRuntimeEnv());
      return generateMakotoImage({
        prompt: input.prompt,
        size: input.size as `${number}x${number}`,
        n: input.n,
        config: bootConfig
      });
    };
  }

  if (options.permission !== undefined) {
    context.permission = options.permission;
  }
  if (options.audit !== undefined) {
    context.audit = options.audit;
  }
  if (options.fetch !== undefined) {
    context.fetch = options.fetch;
  }

  return context;
}

export async function executeEffectiveBootTool<Name extends BootToolName>(
  name: Name,
  input: BootToolInput<Name>,
  options: EffectiveBootToolOptions = {}
): Promise<BootToolOutput<Name>> {
  return executeBootTool(name, input, await getEffectiveBootToolContext(name, options));
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
  const queueConfig = getBootQueueConfig(runtimeEnv);
  const userId = storageUserId(input);
  const cacheScope = conversationCacheScope({ protocol: input.protocol, userId: input.userId });

  await rememberBootUser(input);

  const [recentMessages, cacheContextMemories] = await Promise.all([
    getRecentMessages(userId, 12),
    listMemories({ telegramUserId: userId, limit: 10, offset: 0 })
  ]);
  const cacheContextFingerprint = buildCacheContextFingerprint({
    identity: input,
    bootConfig,
    searchConfig,
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
      hit: exactCache,
      bootConfig,
      searchConfig,
      semanticCacheConfig,
      cacheScope
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
        hit: semanticCache,
        bootConfig,
        searchConfig,
        semanticCacheConfig,
        cacheScope,
        embedding: queryEmbedding
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
  const responseMetadata: ConversationCacheMetadata = {
    memoryCount: memories.length,
    webSearchResultCount: webSearch.response?.results.length ?? 0,
    webSearchStatus: webSearch.status
  };
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
    bootConfig,
    runtimeEnv,
    queueConfig
  });
  refreshConversationCacheInBackground({
    identity: input,
    userId,
    bootConfig,
    searchConfig,
    semanticCacheConfig,
    cacheScope,
    content: input.content,
    reply,
    embedding: queryEmbedding,
    metadata: responseMetadata,
    warning: "Semantic cache write failed."
  });

  return {
    reply,
    ...responseMetadata,
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
  bootConfig: ReturnType<typeof getBootConfig>;
  searchConfig: ReturnType<typeof getBootSearchConfig>;
  semanticCacheConfig: ReturnType<typeof getSemanticCacheConfig>;
  cacheScope: string;
  embedding?: number[] | undefined;
}) {
  const { userMessage, assistantMessage } = await saveConversationTurn({
    telegramUserId: input.userId,
    telegramMessageId: input.input.sourceMessageId ?? null,
    userContent: input.input.content,
    assistantContent: input.hit.reply
  });
  refreshConversationCacheInBackground({
    identity: input.input,
    userId: input.userId,
    bootConfig: input.bootConfig,
    searchConfig: input.searchConfig,
    semanticCacheConfig: input.semanticCacheConfig,
    cacheScope: input.cacheScope,
    content: input.input.content,
    reply: input.hit.reply,
    embedding: input.embedding,
    metadata: cacheHitMetadata(input.hit),
    warning: "Semantic cache refresh after hit failed."
  });

  return {
    reply: input.hit.reply,
    ...cacheHitMetadata(input.hit),
    cacheStatus: input.hit.status,
    cacheSimilarity: input.hit.similarity,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id
  };
}

function buildCacheContextFingerprint(input: {
  identity: BootUserIdentity;
  bootConfig: ReturnType<typeof getBootConfig>;
  searchConfig: ReturnType<typeof getBootSearchConfig>;
  history: CacheContextMessage[];
  memories: CacheContextMemory[];
}) {
  return buildConversationCacheContextFingerprint({
    protocol: input.identity.protocol,
    userId: input.identity.userId,
    chatModel: input.bootConfig.BOOT_CHAT_MODEL,
    embeddingModel: input.bootConfig.BOOT_EMBEDDING_MODEL,
    searchProvider: input.searchConfig.BOOT_SEARCH_PROVIDER,
    history: input.history,
    memories: input.memories
  });
}

function refreshConversationCacheInBackground(input: {
  identity: BootUserIdentity;
  userId: string;
  bootConfig: ReturnType<typeof getBootConfig>;
  searchConfig: ReturnType<typeof getBootSearchConfig>;
  semanticCacheConfig: ReturnType<typeof getSemanticCacheConfig>;
  cacheScope: string;
  content: string;
  reply: string;
  embedding?: number[] | undefined;
  metadata: ConversationCacheMetadata;
  warning: string;
}) {
  void (async () => {
    // Reload the post-save context so cache keys match database ordering and memory side effects.
    const [history, memories, embedding] = await Promise.all([
      getRecentMessages(input.userId, 12),
      listMemories({ telegramUserId: input.userId, limit: 10, offset: 0 }),
      input.embedding ? Promise.resolve(input.embedding) : embedText(input.content, input.bootConfig)
    ]);
    const contextFingerprint = buildCacheContextFingerprint({
      identity: input.identity,
      bootConfig: input.bootConfig,
      searchConfig: input.searchConfig,
      history,
      memories
    });
    const result = await writeConversationCache({
      scope: input.cacheScope,
      contextFingerprint,
      content: input.content,
      reply: input.reply,
      embedding,
      model: input.bootConfig.BOOT_CHAT_MODEL,
      metadata: input.metadata,
      config: input.semanticCacheConfig
    });
    if (result.status === "write_failed") {
      console.warn(input.warning, result.reason);
    }
  })().catch((error) => {
    console.warn(input.warning, error instanceof Error ? error.message : error);
  });
}

async function scheduleDurableMemoryIfUseful(
  input: MemoryEnrichmentJob & {
    bootConfig: Awaited<ReturnType<typeof getEffectiveBootConfig>>;
    runtimeEnv: RuntimeEnv;
    queueConfig: ReturnType<typeof getBootQueueConfig>;
  }
) {
  const jobInput: MemoryEnrichmentJob = {
    userId: input.userId,
    displayName: input.displayName,
    content: input.content,
    reply: input.reply,
    sourceMessageId: input.sourceMessageId
  };

  if (isBootQueueConfigured(input.queueConfig) && envFlag(input.runtimeEnv.BOOT_MEMORY_ENRICHMENT_ASYNC_ENABLED, false)) {
    try {
      await enqueueMemoryEnrichment(jobInput, input.queueConfig);
      return;
    } catch (error) {
      console.warn("Memory enrichment enqueue failed; falling back to background inline task.", error instanceof Error ? error.message : error);
      void createDurableMemoryBestEffort(input, "Background durable memory creation failed after enqueue fallback.");
      return;
    }
  }

  await createDurableMemoryBestEffort(input, "Durable memory creation failed; reply was already saved.");
}

function cacheHitMetadata(hit: ConversationCacheHit): ConversationCacheMetadata {
  return {
    memoryCount: hit.memoryCount,
    webSearchResultCount: hit.webSearchResultCount,
    webSearchStatus: hit.webSearchStatus
  };
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
