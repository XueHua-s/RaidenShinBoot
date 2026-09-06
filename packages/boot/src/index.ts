import {
  applyRuntimeSettingsChangesWithAudit,
  clearConversationMessages,
  createAuditLog,
  createMemory,
  findConversationTurnByTelegramMessage,
  getRecentMessages,
  getTelegramUser,
  getRuntimeSettingsEnvOverrides,
  listMemories,
  saveConversationTurn,
  searchMemories,
  softDeleteMemories,
  type NewRuntimeSetting,
  type ConversationScopeInput,
  updateTelegramUserPrivacyMode,
  upsertTelegramUser
} from "@raiden/database";
import {
  isMemoryMutationRequest,
  isMemoryRecallRequest,
  type BootToolDecision,
  type BootToolStatus,
  type GeneratedImage
} from "@raiden/shared";
import {
  embedDocument,
  embedQuery,
  generateMakotoImage,
  generateMakotoImagePrompt,
  generateMakotoReply,
  getBootConfig,
  isLikelyChatModelId,
  isLikelyImageModelId,
  listChatModels,
  listImageModels,
  planMakotoToolUse,
  probeChatModel,
  shouldUseExplicitMakotoImageForMessage,
  summarizeConversation,
  summarizeForMemory
} from "@raiden/shared/boot";
import { getBootSearchConfig } from "@raiden/shared/search";
import {
  executeBootTool,
  formatBootToolError,
  shouldUseBootSearchForMessage,
  type BootToolContext,
  type BootToolAuditEvent,
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
  invalidateConversationCacheForUser,
  isStandaloneCacheCandidate,
  lookupConversationCache,
  writeConversationCache,
  type ConversationCacheHit,
  type ConversationCacheMetadata,
  type ConversationCacheStatus
} from "./semantic-cache.js";

let runtimeSettingsWarningEmitted = false;
type BootToolAuditHandler = NonNullable<BootToolContext["audit"]>;

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
  sourceChatId?: string | null;
  sourceChatType?: "private" | "group" | "supergroup" | "channel" | null;
  sourceThreadId?: string | null;
  sourceMessageId?: number | null;
  abortSignal?: AbortSignal;
  toolPermission?: BootToolPermissionContext;
  toolAudit?: BootToolAuditHandler;
};

type DurableMemoryInput = {
  userId: string;
  sourceChatId: string | null;
  sourceThreadId: string | null;
  sharedConversation: boolean;
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

export function resolveBootConversationScope(
  input: BootUserIdentity & {
    sourceChatId?: string | null;
    sourceChatType?: "private" | "group" | "supergroup" | "channel" | null;
    sourceThreadId?: string | null;
  },
  persona?: { id: string; version: number; hash: string }
): ConversationScopeInput & { shared: boolean } {
  const userId = storageUserId(input);
  const chatId = input.sourceChatId?.trim() || null;
  const threadId = input.sourceThreadId?.trim() || null;
  const shared = input.sourceChatType === "group" || input.sourceChatType === "supergroup";
  const scopeKey = [
    input.protocol,
    chatId ? `chat:${chatId}` : "direct",
    threadId ? `thread:${threadId}` : "main",
    shared ? "shared" : `user:${userId}`
  ].join(":");
  return {
    protocol: input.protocol,
    scopeKey,
    telegramUserId: shared ? null : userId,
    chatId,
    threadId,
    personaId: persona?.id ?? null,
    personaVersion: persona?.version ?? null,
    personaHash: persona?.hash ?? null,
    shared
  };
}

function envFlag(value: string | undefined, fallback: boolean) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  return !["0", "false", "no", "off", "disabled"].includes(normalized);
}

function privateMemoryScopeFilter(
  privacyMode: "normal" | "isolated" | "off",
  sourceChatId: string | null | undefined,
  sourceThreadId: string | null | undefined
) {
  return privacyMode === "isolated"
    ? {
        privateSourceChatId: sourceChatId ?? null,
        privateSourceThreadId: sourceThreadId ?? null
      }
    : {};
}

function cacheMemoryScopeFilter(
  privacyMode: "normal" | "isolated" | "off",
  sourceChatId: string | null | undefined,
  sourceThreadId: string | null | undefined
) {
  return privacyMode === "isolated"
    ? {
        sourceChatId: sourceChatId ?? null,
        sourceThreadId: sourceThreadId ?? null
      }
    : {};
}

function deterministicConversationToolDecision(content: string): BootToolDecision | null {
  if (shouldUseExplicitMakotoImageForMessage(content)) {
    return {
      action: "makoto_image",
      reason: "用户明确要求生成图片。",
      query: null,
      prompt: content.slice(0, 2000)
    };
  }

  if (
    /(联网|搜索|搜一下|查一下|帮我查|查找|资料来源|来源|链接|最新|新闻|事实核验|核实|天气|气温|空气质量|汇率|股价|航班|比分|油价|google|谷歌|web\s*search|search\s+the\s+web|look\s+up)/i.test(
      content
    )
  ) {
    return {
      action: "web_search",
      reason: "用户明确要求查询外部资料。",
      query: content.slice(0, 500),
      prompt: null
    };
  }

  return null;
}

function mayNeedRemoteToolPlanning(content: string) {
  return (
    shouldUseBootSearchForMessage(content) ||
    /(图片|图像|画面|插画|海报|头像|壁纸|视觉|image|illustration|poster|avatar|wallpaper|visual)/i.test(content)
  );
}

function planConversationToolUse(input: Parameters<typeof planMakotoToolUse>[0]) {
  const deterministic = deterministicConversationToolDecision(input.content);
  if (deterministic) {
    return Promise.resolve(deterministic);
  }
  if (!mayNeedRemoteToolPlanning(input.content)) {
    return Promise.resolve({
      action: "none",
      reason: "消息没有外部工具意图。",
      query: null,
      prompt: null
    } satisfies BootToolDecision);
  }
  return planMakotoToolUse(input);
}

function defaultToolPermission(input: BootConversationInput): BootToolPermissionContext {
  return {
    actorId: input.userId,
    chatId: null
  };
}

function permissionHasToolName(list: readonly string[] | undefined, name: BootToolName) {
  return Boolean(list?.some((item) => item.toLowerCase() === name));
}

function toolAllowedByRuntimePolicy(name: BootToolName, permission: BootToolPermissionContext) {
  if (permissionHasToolName(permission.deniedToolNames, name)) {
    return false;
  }

  return !permission.allowedToolNames || permissionHasToolName(permission.allowedToolNames, name);
}

function safeAuditAfter(event: BootToolAuditEvent): Record<string, unknown> {
  return {
    toolName: event.toolName,
    status: event.status,
    durationMs: event.durationMs,
    readOnly: event.readOnly,
    destructive: event.destructive,
    concurrencySafe: event.concurrencySafe,
    actorId: event.actorId ?? null,
    chatId: event.chatId ?? null,
    inputSummary: event.inputSummary ?? null,
    resultSizeChars: event.resultSizeChars ?? null,
    error: event.error ?? null
  };
}

function actorAdminIdFromToolEvent(event: BootToolAuditEvent) {
  const actorId = event.actorId ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actorId)
    ? actorId
    : null;
}

function defaultBootToolAudit(): BootToolAuditHandler {
  return async (event) => {
    if (!process.env.DATABASE_URL) {
      return;
    }

    await createAuditLog({
      actorAdminId: actorAdminIdFromToolEvent(event),
      action: `boot_tool.${event.status}`,
      targetType: "boot_tool",
      targetId: event.toolName,
      after: safeAuditAfter(event)
    });
  };
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
  audit?: BootToolAuditHandler;
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
  } else {
    context.audit = defaultBootToolAudit();
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

export async function listEffectiveChatModels(forceRefresh = false) {
  return listChatModels(await getEffectiveBootConfig(), forceRefresh);
}

export async function listEffectiveImageModels(forceRefresh = false) {
  return listImageModels(await getEffectiveBootConfig(), forceRefresh);
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
  if (!isLikelyChatModelId(modelId, beforeConfig)) {
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

export async function switchEffectiveImageModel(input: {
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
  if (!isLikelyImageModelId(modelId, beforeConfig)) {
    throw new Error(`Model "${modelId}" does not look like an image model.`);
  }
  const modelList = await listImageModels(beforeConfig);
  if (!modelList.models.some((model) => model.id === modelId)) {
    throw new Error(`Model "${modelId}" was not found in the provider image model list.`);
  }

  await applyRuntimeSettingsChangesWithAudit({
    changes: {
      upserts: [
        {
          key: "BOOT_IMAGE_MODEL",
          value: modelId,
          encrypted: false,
          updatedByAdminId: null
        }
      ]
    },
    audit: {
      actorAdminId: null,
      action: "runtime_settings.telegram_image_model_update",
      targetType: "runtime_settings",
      targetId: "BOOT_IMAGE_MODEL",
      before: { bootImageModel: beforeConfig.BOOT_IMAGE_MODEL },
      after: {
        bootImageModel: modelId,
        actorTelegramId: input.actorTelegramId ?? null,
        actorUsername: input.actorUsername ?? null,
        chatId: input.chatId ?? null
      }
    }
  });

  return {
    beforeModel: beforeConfig.BOOT_IMAGE_MODEL,
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

function duplicateTelegramTurnReply(turn: NonNullable<Awaited<ReturnType<typeof findConversationTurnByTelegramMessage>>>) {
  return {
    reply: turn.assistantMessage.content,
    memoryCount: 0,
    webSearchResultCount: 0,
    webSearchStatus: "skipped" as const,
    cacheStatus: "disabled" as const,
    cacheSimilarity: null,
    toolDecision: {
      action: "none",
      reason: "重复的 Telegram message_id，复用已保存回复。",
      query: null,
      prompt: null
    } satisfies BootToolDecision,
    toolStatus: {
      name: null,
      status: "skipped",
      message: "duplicate telegram message"
    } satisfies BootToolStatus,
    images: [] satisfies GeneratedImage[],
    userMessageId: turn.userMessage.id,
    assistantMessageId: turn.assistantMessage.id
  };
}

export async function runBootConversation(input: BootConversationInput) {
  const runtimeEnv = await loadRuntimeEnv();
  const bootConfig = getBootConfig(runtimeEnv);
  const searchConfig = getBootSearchConfig(runtimeEnv);
  const semanticCacheConfig = getSemanticCacheConfig(runtimeEnv);
  const queueConfig = getBootQueueConfig(runtimeEnv);
  const userId = storageUserId(input);
  const scope = resolveBootConversationScope(input, {
    id: bootConfig.PERSONA_ID,
    version: bootConfig.PERSONA_VERSION,
    hash: bootConfig.PERSONA_HASH
  });
  const cacheScope = conversationCacheScope({ scopeKey: scope.scopeKey });

  const rememberedUser = await rememberBootUser(input);
  const privacyMode = rememberedUser?.privacyMode ?? "normal";
  const memoryEnabled = privacyMode !== "off";
  const canAttemptExactCache = privacyMode !== "off" && !scope.shared && isStandaloneCacheCandidate(input.content);
  if (input.sourceMessageId !== null && input.sourceMessageId !== undefined) {
    const existingTurn = await findConversationTurnByTelegramMessage({
      telegramUserId: userId,
      telegramChatId: input.sourceChatId ?? null,
      telegramMessageId: input.sourceMessageId
    });
    if (existingTurn) {
      return duplicateTelegramTurnReply(existingTurn);
    }
  }

  const [recentMessages, cacheContextMemories] = await Promise.all([
    getRecentMessages(scope.scopeKey, 12),
    memoryEnabled && canAttemptExactCache
      ? listMemories({
          telegramUserId: userId,
          ...cacheMemoryScopeFilter(privacyMode, input.sourceChatId, input.sourceThreadId),
          limit: 10,
          offset: 0
        })
      : Promise.resolve([])
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
        cacheScope,
        privacyMode
      });
    }
    exactCacheStatus = exactCache.status === "disabled" ? "disabled" : "miss";
  }

  const [toolDecision, queryEmbedding] = await Promise.all([
    planConversationToolUse({
      content: input.content,
      config: bootConfig,
      history,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
    }),
    embedQuery(input.content, bootConfig, input.abortSignal)
  ]);
  const cacheEligible = privacyMode !== "off" && !scope.shared && toolDecision.action === "none";
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
        privacyMode,
        embedding: queryEmbedding
      });
    }
    cacheStatus = semanticCache.status === "disabled" ? "disabled" : "miss";
  }

  let memories = memoryEnabled
    ? await searchMemories({
        telegramUserId: userId,
        embedding: queryEmbedding,
        sourceChatId: input.sourceChatId ?? null,
        sourceThreadId: input.sourceThreadId ?? null,
        includePrivate: !scope.shared,
        ...privateMemoryScopeFilter(privacyMode, input.sourceChatId, input.sourceThreadId),
        limit: 5,
        maxDistance: 0.55
      })
    : [];
  if (memoryEnabled && memories.length === 0 && isMemoryRecallRequest(input.content)) {
    memories = await searchMemories({
      telegramUserId: userId,
      embedding: queryEmbedding,
      sourceChatId: input.sourceChatId ?? null,
      sourceThreadId: input.sourceThreadId ?? null,
      includePrivate: !scope.shared,
      ...privateMemoryScopeFilter(privacyMode, input.sourceChatId, input.sourceThreadId),
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
    toolDecision,
    toolPermission: input.toolPermission ?? defaultToolPermission(input),
    toolAudit: input.toolAudit ?? defaultBootToolAudit(),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
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
          maxCharacters: scope.shared ? 300 : 3500,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          history
        });

  input.abortSignal?.throwIfAborted();

  let savedTurn: Awaited<ReturnType<typeof saveConversationTurn>>;
  try {
    savedTurn = await saveConversationTurn({
      scope,
      telegramUserId: userId,
      telegramChatId: input.sourceChatId ?? null,
      telegramThreadId: input.sourceThreadId ?? null,
      telegramMessageId: input.sourceMessageId ?? null,
      userContent: input.content,
      assistantContent: reply
    });
  } catch (error) {
    if (input.sourceMessageId === null || input.sourceMessageId === undefined) {
      throw error;
    }
    const existingTurn = await findConversationTurnByTelegramMessage({
      telegramUserId: userId,
      telegramChatId: input.sourceChatId ?? null,
      telegramMessageId: input.sourceMessageId
    });
    if (!existingTurn) {
      throw error;
    }

    return duplicateTelegramTurnReply(existingTurn);
  }
  const { userMessage, assistantMessage } = savedTurn;

  if (memoryEnabled) {
    await scheduleDurableMemoryIfUseful({
      userId,
      sourceChatId: input.sourceChatId ?? null,
      sourceThreadId: input.sourceThreadId ?? null,
      sharedConversation: scope.shared,
      displayName,
      content: input.content,
      reply,
      sourceMessageId: userMessage.id,
      bootConfig,
      runtimeEnv,
      queueConfig
    });
  }
  if (cacheEligible) {
    refreshConversationCacheInBackground({
      identity: input,
      scopeKey: scope.scopeKey,
      userId,
      bootConfig,
      searchConfig,
      semanticCacheConfig,
      cacheScope,
      content: input.content,
      reply,
      embedding: queryEmbedding,
      metadata: responseMetadata,
      warning: "Semantic cache write failed.",
      privacyMode
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
  toolPermission: BootToolPermissionContext;
  toolAudit: BootToolAuditHandler;
  abortSignal?: AbortSignal;
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
        {
          searchConfig: input.searchConfig,
          permission: input.toolPermission,
          audit: input.toolAudit
        }
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
    if (!toolAllowedByRuntimePolicy("makoto_image", input.toolPermission)) {
      const message = "Tool makoto_image is not allowed by runtime policy.";
      const auditEvent: BootToolAuditEvent = {
        toolName: "makoto_image",
        status: "denied",
        durationMs: 0,
        readOnly: false,
        destructive: false,
        concurrencySafe: true,
        inputSummary: input.toolDecision.prompt ?? input.input.content,
        error: message
      };
      if (input.toolPermission.actorId !== undefined) {
        auditEvent.actorId = input.toolPermission.actorId;
      }
      if (input.toolPermission.chatId !== undefined) {
        auditEvent.chatId = input.toolPermission.chatId;
      }
      await input.toolAudit(auditEvent);
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

    const originalPrompt = input.toolDecision.prompt ?? input.input.content;
    let imagePrompt = originalPrompt;
    let promptRewriteFallback = false;
    try {
      imagePrompt = await generateMakotoImagePrompt({
        userPrompt: originalPrompt,
        userName: input.displayName,
        history: input.history,
        config: input.bootConfig,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
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
              config: input.bootConfig,
              ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
            }),
          permission: input.toolPermission,
          audit: input.toolAudit
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
  privacyMode: "normal" | "isolated" | "off";
  embedding?: number[] | undefined;
}) {
  const scope = resolveBootConversationScope(input.input, {
    id: input.bootConfig.PERSONA_ID,
    version: input.bootConfig.PERSONA_VERSION,
    hash: input.bootConfig.PERSONA_HASH
  });
  let savedTurn: Awaited<ReturnType<typeof saveConversationTurn>>;
  try {
    savedTurn = await saveConversationTurn({
      scope,
      telegramUserId: input.userId,
      telegramChatId: input.input.sourceChatId ?? null,
      telegramThreadId: input.input.sourceThreadId ?? null,
      telegramMessageId: input.input.sourceMessageId ?? null,
      userContent: input.input.content,
      assistantContent: input.hit.reply
    });
  } catch (error) {
    if (input.input.sourceMessageId === null || input.input.sourceMessageId === undefined) {
      throw error;
    }
    const existingTurn = await findConversationTurnByTelegramMessage({
      telegramUserId: input.userId,
      telegramChatId: input.input.sourceChatId ?? null,
      telegramMessageId: input.input.sourceMessageId
    });
    if (!existingTurn) {
      throw error;
    }

    return duplicateTelegramTurnReply(existingTurn);
  }
  const { userMessage, assistantMessage } = savedTurn;
  if (input.hit.status === "l2_hit" || input.embedding) {
    refreshConversationCacheInBackground({
      identity: input.input,
      scopeKey: scope.scopeKey,
      userId: input.userId,
      bootConfig: input.bootConfig,
      searchConfig: input.searchConfig,
      semanticCacheConfig: input.semanticCacheConfig,
      cacheScope: input.cacheScope,
      privacyMode: input.privacyMode,
      content: input.input.content,
      reply: input.hit.reply,
      embedding: input.embedding,
      metadata: cacheHitMetadata(input.hit),
      warning: "Semantic cache refresh after hit failed."
    });
  }

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
    personaHash: input.bootConfig.PERSONA_HASH,
    userDisplayName: input.identity.firstName ?? input.identity.username ?? null,
    searchProvider: input.searchConfig.BOOT_SEARCH_PROVIDER,
    history: input.history,
    memories: input.memories
  });
}

function refreshConversationCacheInBackground(input: {
  identity: BootConversationInput;
  scopeKey: string;
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
  privacyMode: "normal" | "isolated" | "off";
}) {
  void (async () => {
    // Reload the post-save context so cache keys match database ordering and memory side effects.
    const [history, memories, embedding] = await Promise.all([
      getRecentMessages(input.scopeKey, 12),
      listMemories({
        telegramUserId: input.userId,
        ...cacheMemoryScopeFilter(input.privacyMode, input.identity.sourceChatId, input.identity.sourceThreadId),
        limit: 10,
        offset: 0
      }),
      input.embedding ? Promise.resolve(input.embedding) : embedQuery(input.content, input.bootConfig)
    ]);
    const contextFingerprint = buildCacheContextFingerprint({
      identity: input.identity,
      bootConfig: input.bootConfig,
      searchConfig: input.searchConfig,
      history,
      memories
    });
    const result = await writeConversationCache({
      userId: input.userId,
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
  // Most turns are transient conversation. Only send likely durable facts to
  // the remote extraction model; this keeps normal chat to one language-model
  // call while preserving explicit names, preferences, goals, and requests to
  // remember something.
  if (!isMemoryMutationRequest(input.content)) {
    return;
  }

  const jobInput: MemoryEnrichmentJob = {
    userId: input.userId,
    sourceChatId: input.sourceChatId,
    sourceThreadId: input.sourceThreadId,
    sharedConversation: input.sharedConversation,
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

  const memoryEmbedding = await embedDocument(memorySummary, input.bootConfig);
  await createMemory({
    telegramUserId: input.userId,
    summary: memorySummary,
    embedding: memoryEmbedding,
    embeddingModel: input.bootConfig.BOOT_EMBEDDING_MODEL,
    importance: 6,
    scope: input.sharedConversation ? "user_in_chat" : "user_private",
    kind: "fact",
    sourceChatId: input.sourceChatId,
    sourceThreadId: input.sourceThreadId,
    subjectUserId: input.userId,
    confidence: 70,
    sourceMessageId: input.sourceMessageId
  });
}

export async function processMemoryEnrichmentJob(input: MemoryEnrichmentJob) {
  const user = await getTelegramUser(input.userId);
  if (!user || user.privacyMode === "off") {
    return;
  }
  await createDurableMemory({
    ...input,
    bootConfig: await getEffectiveBootConfig()
  });
}

export async function recallBootMemories(
  input: BootUserIdentity & {
    query: string;
    limit?: number;
    sourceChatId?: string | null;
    sourceChatType?: "private" | "group" | "supergroup" | "channel" | null;
    sourceThreadId?: string | null;
  }
) {
  const scope = resolveBootConversationScope(input);
  const privacyMode = await getBootPrivacyMode(input);
  if (privacyMode === "off") {
    return [];
  }
  const embedding = await embedQuery(input.query, await getEffectiveBootConfig());
  return searchMemories({
    telegramUserId: storageUserId(input),
    embedding,
    sourceChatId: input.sourceChatId ?? null,
    sourceThreadId: input.sourceThreadId ?? null,
    includePrivate: !scope.shared,
    ...privateMemoryScopeFilter(privacyMode, input.sourceChatId, input.sourceThreadId),
    limit: input.limit ?? 6
  });
}

export async function listBootMemories(
  input: BootUserIdentity & {
    limit?: number;
    offset?: number;
    sourceChatId?: string | null;
    sourceThreadId?: string | null;
  }
) {
  return listMemories({
    telegramUserId: storageUserId(input),
    sourceChatId: input.sourceChatId ?? null,
    sourceThreadId: input.sourceThreadId ?? null,
    limit: input.limit ?? 8,
    offset: input.offset ?? 0
  });
}

export async function forgetBootMemories(input: BootUserIdentity & { sourceChatId?: string | null }) {
  const userId = storageUserId(input);
  const deleted = await softDeleteMemories(
    input.sourceChatId === undefined
      ? { telegramUserId: userId }
      : { telegramUserId: userId, sourceChatId: input.sourceChatId }
  );
  try {
    await invalidateConversationCacheForUser(userId);
  } catch (error) {
    console.warn("Semantic cache invalidation failed after memory deletion.", error instanceof Error ? error.message : error);
  }
  return deleted;
}

export async function getBootPrivacyMode(identity: BootUserIdentity) {
  const user = (await getTelegramUser(storageUserId(identity))) ?? (await rememberBootUser(identity));
  return user?.privacyMode ?? "normal";
}

export async function setBootPrivacyMode(
  identity: BootUserIdentity,
  privacyMode: "normal" | "isolated" | "off"
) {
  await rememberBootUser(identity);
  const user = await updateTelegramUserPrivacyMode(storageUserId(identity), privacyMode);
  if (!user) {
    throw new Error("Unable to update privacy mode.");
  }
  try {
    await invalidateConversationCacheForUser(storageUserId(identity));
  } catch (error) {
    console.warn(
      "Semantic cache invalidation failed after privacy mode change.",
      error instanceof Error ? error.message : error
    );
  }
  return user.privacyMode;
}

export async function clearBootConversation(
  input: BootUserIdentity & {
    sourceChatId?: string | null;
    sourceChatType?: "private" | "group" | "supergroup" | "channel" | null;
    sourceThreadId?: string | null;
  }
) {
  const scope = resolveBootConversationScope(input);
  return clearConversationMessages(scope.scopeKey);
}

export async function summarizeBootConversation(
  input: BootUserIdentity & {
    sourceChatId?: string | null;
    sourceChatType?: "private" | "group" | "supergroup" | "channel" | null;
    sourceThreadId?: string | null;
    limit?: number;
  }
) {
  const scope = resolveBootConversationScope(input);
  const history = await getRecentMessages(scope.scopeKey, input.limit ?? 60);
  return summarizeConversation({
    history: history.map((message) => ({
      role: message.role as "user" | "assistant" | "system",
      content: message.content
    })),
    config: await getEffectiveBootConfig(),
    maxCharacters: scope.shared ? 1200 : 1800
  });
}

export * from "./jobs.js";
export * from "./semantic-cache.js";
