import {
  applyRuntimeSettingsChangesWithAudit,
  createMemory,
  getRecentMessages,
  getRuntimeSettingsEnvOverrides,
  listMemories,
  saveConversationTurn,
  searchMemories,
  type NewRuntimeSetting,
  upsertTelegramUser
} from "@raiden/database";
import { isMemoryRecallRequest, type BootToolDecision, type BootToolStatus, type GeneratedImage } from "@raiden/shared";
import {
  embedText,
  generateMakotoImage,
  generateMakotoImagePrompt,
  generateMakotoReply,
  getBootConfig,
  isLikelyChatModelId,
  listChatModels,
  planMakotoToolUse,
  probeChatModel,
  summarizeForMemory
} from "@raiden/shared/boot";
import { getBootSearchConfig } from "@raiden/shared/search";
import {
  executeBootTool,
  formatBootToolError,
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
  isStandaloneCacheCandidate,
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

export async function listEffectiveChatModels() {
  return listChatModels(await getEffectiveBootConfig());
}

export async function switchEffectiveChatModel(input: {
  modelId: string;
  actorTelegramId?: string | null;
  actorUsername?: string | null;
  chatId?: string | null;
}) {
  const modelId = input.modelId.trim();
  if (!modelId) {
    throw new Error("Model id is required.");
  }

  const beforeConfig = await getEffectiveBootConfig();
  if (!isLikelyChatModelId(modelId)) {
    throw new Error(`Model "${modelId}" does not look like a chat model.`);
  }

  const modelList = await listChatModels(beforeConfig);
  const exists = modelList.models.some((model) => model.id === modelId);
  if (!exists) {
    throw new Error(`Model "${modelId}" was not found in the provider model list.`);
  }

  try {
    await probeChatModel(modelId, beforeConfig);
  } catch (error) {
    throw new Error(`Model "${modelId}" failed the chat probe: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  const setting: NewRuntimeSetting = {
    key: "BOOT_CHAT_MODEL",
    value: modelId,
    encrypted: false,
    updatedByAdminId: null
  };
  await applyRuntimeSettingsChangesWithAudit({
    changes: { upserts: [setting] },
    audit: {
      actorAdminId: null,
      action: "runtime_settings.telegram_model_update",
      targetType: "runtime_settings",
      targetId: "BOOT_CHAT_MODEL",
      before: {
        bootChatModel: beforeConfig.BOOT_CHAT_MODEL
      },
      after: {
        bootChatModel: modelId,
        actorTelegramId: input.actorTelegramId ?? null,
        actorUsername: input.actorUsername ?? null,
        chatId: input.chatId ?? null
      }
    }
  });

  return {
    beforeModel: beforeConfig.BOOT_CHAT_MODEL,
    afterModel: modelId,
    availableModelCount: modelList.models.length
  };
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

  const history = recentMessages.map((message: { role: string; content: string }) => ({
    role: message.role as "user" | "assistant" | "system",
    content: message.content
  }));

  const canAttemptExactCache = isStandaloneCacheCandidate(input.content);
  let exactCacheStatus: Extract<ConversationCacheStatus, "disabled" | "miss"> = canAttemptExactCache ? "miss" : "disabled";
  if (canAttemptExactCache) {
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
    exactCacheStatus = exactCache.status === "disabled" ? "disabled" : "miss";
  }

  const [toolDecision, queryEmbedding] = await Promise.all([
    planMakotoToolUse({
      content: input.content,
      config: bootConfig,
      history
    }),
    embedText(input.content, bootConfig)
  ]);
  const cacheEligible = toolDecision.action === "none";
  let cacheStatus: Extract<ConversationCacheStatus, "disabled" | "miss"> = cacheEligible ? exactCacheStatus : "disabled";

  if (cacheEligible && canAttemptExactCache && exactCacheStatus !== "disabled") {
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

  const displayName = input.firstName ?? input.username ?? null;
  const toolResult = await executeConversationTool({
    input,
    displayName,
    bootConfig,
    searchConfig,
    history,
    toolDecision
  });
  const responseMetadata: ConversationCacheMetadata = {
    memoryCount: memories.length,
    webSearchResultCount: toolResult.webSearch.response?.results.length ?? 0,
    webSearchStatus: toolResult.webSearch.status
  };

  const reply =
    toolDecision.action === "makoto_image"
      ? toolResult.reply
      : await generateMakotoReply({
          userName: displayName,
          content: input.content,
          memories,
          webSearch: toolResult.webSearch.response,
          webSearchError: toolResult.webSearch.error,
          config: bootConfig,
          history
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
  if (cacheEligible) {
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
  }

  return {
    reply,
    ...responseMetadata,
    cacheStatus,
    cacheSimilarity: null,
    toolDecision,
    toolStatus: toolResult.toolStatus,
    images: toolResult.images,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id
  };
}

type ConversationWebSearchResult =
  | { status: "skipped"; response: null; error: null }
  | { status: "completed"; response: BootToolOutput<"web_search">; error: null }
  | { status: "failed"; response: null; error: string };

async function executeConversationTool(input: {
  input: BootConversationInput;
  displayName: string | null;
  bootConfig: ReturnType<typeof getBootConfig>;
  searchConfig: ReturnType<typeof getBootSearchConfig>;
  history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  toolDecision: BootToolDecision;
}): Promise<{
  webSearch: ConversationWebSearchResult;
  toolStatus: BootToolStatus;
  images: GeneratedImage[];
  reply: string;
}> {
  if (input.toolDecision.action === "web_search") {
    try {
      const response = await executeBootTool(
        "web_search",
        {
          query: input.toolDecision.query ?? input.input.content,
          maxResults: 4
        },
        { searchConfig: input.searchConfig }
      );
      return {
        webSearch: { status: "completed", response, error: null },
        toolStatus: {
          name: "web_search",
          status: "completed",
          message: `query: ${response.query}`
        },
        images: [],
        reply: ""
      };
    } catch (error) {
      const message = formatBootToolError(error);
      return {
        webSearch: { status: "failed", response: null, error: message },
        toolStatus: {
          name: "web_search",
          status: "failed",
          message
        },
        images: [],
        reply: ""
      };
    }
  }

  if (input.toolDecision.action === "makoto_image") {
    const originalPrompt = input.toolDecision.prompt ?? input.input.content;
    let imagePrompt = originalPrompt;
    let promptRewriteFallback = false;
    try {
      imagePrompt = await generateMakotoImagePrompt({
        userPrompt: originalPrompt,
        userName: input.displayName,
        history: input.history,
        config: input.bootConfig
      });
    } catch {
      promptRewriteFallback = true;
    }

    try {
      const result = await executeBootTool(
        "makoto_image",
        {
          prompt: imagePrompt,
          size: "1024x1024",
          n: 1
        },
        {
          imageGenerator: async (toolInput) =>
            generateMakotoImage({
              prompt: toolInput.prompt,
              size: toolInput.size as `${number}x${number}`,
              n: toolInput.n,
              config: input.bootConfig
            })
        }
      );
      return {
        webSearch: { status: "skipped", response: null, error: null },
        toolStatus: {
          name: "makoto_image",
          status: "completed",
          message: promptRewriteFallback ? "image generated; prompt rewrite fallback used" : "image generated"
        },
        images: result.images,
        reply: "画好了。愿这点温柔的雷光，正好落在你想看的地方。"
      };
    } catch (error) {
      const message = formatBootToolError(error);
      return {
        webSearch: { status: "skipped", response: null, error: null },
        toolStatus: {
          name: "makoto_image",
          status: "failed",
          message
        },
        images: [],
        reply: `这一次画面没有顺利凝成：${message}`
      };
    }
  }

  return {
    webSearch: { status: "skipped", response: null, error: null },
    toolStatus: {
      name: null,
      status: "skipped",
      message: input.toolDecision.reason || null
    },
    images: [],
    reply: ""
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
    toolDecision: {
      action: "none",
      reason: "命中语义响应缓存。",
      query: null,
      prompt: null
    } satisfies BootToolDecision,
    toolStatus: {
      name: null,
      status: "skipped",
      message: "cache hit"
    } satisfies BootToolStatus,
    images: [] satisfies GeneratedImage[],
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
