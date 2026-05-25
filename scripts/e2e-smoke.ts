import {
  buildConversationCacheContextFingerprint,
  closeSemanticCache,
  conversationCacheScope,
  getEffectiveBootConfig,
  getEffectiveBootSearchConfig,
  getSemanticCacheConfig,
  isStandaloneCacheCandidate,
  lookupConversationCache,
  processMemoryEnrichmentJob,
  runBootConversation
} from "@raiden/boot";
import {
  closeDatabase,
  createAdminUser,
  countActiveSuperAdmins,
  deleteRuntimeSetting,
  getRecentMessages,
  getSqlClient,
  listRuntimeSettings,
  listMemories,
  resolveTelegramChatAccess,
  updateTelegramChat,
  upsertTelegramCommandPermission,
  upsertRuntimeSetting
} from "@raiden/database";
import { app } from "@raiden/server/app";
import { hashPassword } from "@raiden/server/auth";
import type { BootToolDescriptor, BootToolSearchResponse } from "@raiden/shared";
import { planMakotoToolUse } from "@raiden/shared/boot";
import { replyAsMakoto } from "../packages/bot/src/conversation.js";
import { config } from "dotenv";
import { createMockRelay, createMockRelayState, listen } from "./e2e/mock-relay.js";

config({ path: new URL("../.env", import.meta.url) });
config();

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for E2E smoke test");
  }

  const relayState = createMockRelayState();
  const server = createMockRelay(relayState);
  const port = await listen(server);
  const apiTelegramUserId = `e2e-api-${Date.now()}`;
  const semanticCacheTelegramUserId = `e2e-cache-${Date.now()}`;
  const botUserNumericId = Date.now() % 1_000_000_000;
  const botTelegramUserId = String(botUserNumericId);
  const adminUsername = `e2e-admin-${Date.now()}`;
  const adminPassword = "e2e-admin-password-123";
  const sql = getSqlClient();
  const runtimeSettingKeys = [
    "BOOT_GATEWAY_PRESET",
    "BOOT_BASE_URL",
    "BOOT_CHAT_BASE_URL",
    "BOOT_EMBEDDING_BASE_URL",
    "BOOT_IMAGE_BASE_URL",
    "BOOT_SEARCH_BASE_URL",
    "BOOT_WIKIPEDIA_API_URL",
    "BOOT_MOEGIRL_API_URL",
    "BOOT_API_KEY",
    "BOOT_CHAT_API_KEY",
    "BOOT_EMBEDDING_API_KEY",
    "BOOT_IMAGE_API_KEY",
    "BOOT_SEARCH_API_KEY",
    "BOOT_CHAT_MODEL",
    "BOOT_EMBEDDING_MODEL",
    "BOOT_IMAGE_MODEL",
    "BOOT_SEARCH_PROVIDER",
    "BOOT_SEARCH_MAX_RESULTS",
    "BOOT_SEARCH_DEPTH",
    "BOOT_CHAT_TIMEOUT_MS",
    "BOOT_EMBEDDING_TIMEOUT_MS",
    "BOOT_IMAGE_TIMEOUT_MS",
    "BOOT_SEARCH_TIMEOUT_MS"
  ];
  const runtimeSettingsSnapshot = (await listRuntimeSettings()).filter((setting) =>
    runtimeSettingKeys.includes(setting.key)
  );

  process.env.BOOT_SETTINGS_ENCRYPTION_KEY = "e2e-runtime-settings-secret";
  process.env.BOOT_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.BOOT_CHAT_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.BOOT_EMBEDDING_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.BOOT_IMAGE_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.BOOT_API_KEY = "e2e-local-key";
  process.env.BOOT_CHAT_MODEL = "mock-chat";
  process.env.BOOT_EMBEDDING_MODEL = "mock-embedding";
  process.env.BOOT_IMAGE_MODEL = "mock-image";
  process.env.BOOT_SEARCH_PROVIDER = "tavily";
  process.env.BOOT_SEARCH_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.BOOT_WIKIPEDIA_API_URL = `http://127.0.0.1:${port}/wiki/api.php`;
  process.env.BOOT_MOEGIRL_API_URL = `http://127.0.0.1:${port}/moegirl/api.php`;
  process.env.BOOT_SEARCH_API_KEY = "e2e-local-search-key";
  process.env.BOOT_SEARCH_MAX_RESULTS = "5";
  process.env.BOOT_CHAT_TIMEOUT_MS = "90000";
  process.env.BOOT_EMBEDDING_TIMEOUT_MS = "30000";
  process.env.BOOT_IMAGE_TIMEOUT_MS = "180000";
  process.env.BOOT_SEARCH_TIMEOUT_MS = "15000";
  process.env.BOOT_MEMORY_ENRICHMENT_ASYNC_ENABLED = "false";
  process.env.BOOT_SEMANTIC_CACHE_ENABLED = "false";

  const baseCacheFingerprint = buildConversationCacheContextFingerprint({
    protocol: "telegram",
    userId: "e2e-cache-user",
    chatModel: "mock-chat",
    embeddingModel: "mock-embedding",
    searchProvider: "disabled",
    history: [],
    memories: []
  });
  const changedHistoryFingerprint = buildConversationCacheContextFingerprint({
    protocol: "telegram",
    userId: "e2e-cache-user",
    chatModel: "mock-chat",
    embeddingModel: "mock-embedding",
    searchProvider: "disabled",
    history: [{ id: "m1", role: "assistant", content: "previous reply", createdAt: "2026-01-01T00:00:00.000Z" }],
    memories: []
  });
  const changedMemoryFingerprint = buildConversationCacheContextFingerprint({
    protocol: "telegram",
    userId: "e2e-cache-user",
    chatModel: "mock-chat",
    embeddingModel: "mock-embedding",
    searchProvider: "disabled",
    history: [],
    memories: [
      {
        id: "memory-1",
        summary: "用户喜欢稻妻茶点。",
        importance: 6,
        sourceMessageId: null,
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ]
  });
  if (baseCacheFingerprint === changedHistoryFingerprint || baseCacheFingerprint === changedMemoryFingerprint) {
    throw new Error("Conversation cache fingerprint should change when history or memory context changes");
  }
  if (isStandaloneCacheCandidate("继续说刚才那件事")) {
    throw new Error("Contextual follow-up prompts must not be semantic-cache candidates");
  }
  if (isStandaloneCacheCandidate("请生成一张稻妻樱花头像")) {
    throw new Error("Explicit image-generation prompts must not be semantic-cache candidates");
  }
  for (const memoryMutationPrompt of ["请记住我喜欢苹果", "我的名字是小雪", "I like dango milk, please remember that"]) {
    if (isStandaloneCacheCandidate(memoryMutationPrompt)) {
      throw new Error(`Memory/profile mutation prompt should not be a semantic-cache candidate: ${memoryMutationPrompt}`);
    }
  }
  if (!isStandaloneCacheCandidate("请温柔地说明这次验证链路")) {
    throw new Error("Standalone non-search prompts should be semantic-cache candidates");
  }
  const plannerSearchDecision = await planMakotoToolUse({
    content: "E2E_PLANNER_WEB_ACTION ordinary planner passthrough"
  });
  if (plannerSearchDecision.action !== "web_search" || plannerSearchDecision.query !== "planner supplied search query") {
    throw new Error(`Planner web_search decisions should pass through without regex denial, got ${plannerSearchDecision.action}`);
  }
  const plannerImageDecision = await planMakotoToolUse({
    content: "E2E_PLANNER_IMAGE_ACTION ordinary planner passthrough"
  });
  if (plannerImageDecision.action !== "makoto_image" || plannerImageDecision.prompt !== "planner supplied image prompt") {
    throw new Error(`Planner makoto_image decisions should pass through without regex denial, got ${plannerImageDecision.action}`);
  }
  const validNoneSearchDecision = await planMakotoToolUse({
    content: "E2E_VALID_NONE_SEARCH 请联网搜索 RaidenShinBoot 工具架构。"
  });
  if (validNoneSearchDecision.action !== "web_search") {
    throw new Error(`Explicit search intent should override valid planner none, got ${validNoneSearchDecision.action}`);
  }
  const validNoneImageDecision = await planMakotoToolUse({
    content: "E2E_VALID_NONE_IMAGE 请生成一张稻妻樱花头像。"
  });
  if (validNoneImageDecision.action !== "makoto_image") {
    throw new Error(`Explicit image intent should override valid planner none, got ${validNoneImageDecision.action}`);
  }
  const validNoneNonImageDecision = await planMakotoToolUse({
    content: "E2E_VALID_NONE_NON_IMAGE 请帮我画重点总结这段文字。"
  });
  if (validNoneNonImageDecision.action !== "none") {
    throw new Error(`Non-image writing intent should remain none after valid planner none, got ${validNoneNonImageDecision.action}`);
  }

  try {
    await Promise.all(runtimeSettingKeys.map((key) => deleteRuntimeSetting(key)));
    await sql`delete from telegram_users where telegram_id in (${apiTelegramUserId}, ${semanticCacheTelegramUserId}, ${botTelegramUserId})`;
    await sql`delete from telegram_command_permissions where command in ('start', 'model') and (chat_id is null or chat_id = '-1001234567890')`;
    await sql`delete from admin_users where username = ${adminUsername}`;

    await createAdminUser({
      username: adminUsername,
      displayName: "E2E Admin",
      passwordHash: await hashPassword(adminPassword),
      role: "super_admin",
      status: "active"
    });

    const loginResponse = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: adminUsername,
        password: adminPassword
      })
    });
    if (!loginResponse.ok) {
      throw new Error(`Admin login failed with ${loginResponse.status}: ${await loginResponse.text()}`);
    }
    const sessionCookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
    const loginPayload = (await loginResponse.json()) as { user?: { id?: string }; csrfToken?: string };
    if (!sessionCookie || !loginPayload.csrfToken || !loginPayload.user?.id) {
      throw new Error("Admin login did not return session cookie and CSRF token");
    }

    const authedRequest = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", sessionCookie);
      if (init.method && !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase())) {
        headers.set("x-csrf-token", loginPayload.csrfToken ?? "");
      }

      return app.request(path, {
        ...init,
        headers
      });
    };

    const patchRuntimeSettings = async (patch: Record<string, unknown>) => {
      const response = await authedRequest("/api/system/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (!response.ok) {
        throw new Error(`Runtime settings patch failed with ${response.status}: ${await response.text()}`);
      }

      return response.json() as Promise<{
        data: {
          bootBaseUrl?: string;
          bootChatBaseUrl?: string | null;
          bootEmbeddingModel?: string;
          bootImageModel?: string;
          bootSearchProvider?: string;
          secrets?: Record<string, boolean>;
        };
      }>;
    };
    const putCommandPermission = async (patch: { chatId: string | null; command: string; enabled: boolean }) => {
      const response = await authedRequest("/api/telegram/command-permissions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (!response.ok) {
        throw new Error(`Telegram command permission upsert failed with ${response.status}: ${await response.text()}`);
      }

      return response.json();
    };

    const health = await app.request("/api/health");
    if (!health.ok) {
      throw new Error(`Health check failed with ${health.status}`);
    }

    const originalWebhookSecret = process.env.BOOT_TELEGRAM_WEBHOOK_SECRET;
    const originalRedisUrl = process.env.REDIS_URL;
    const originalQueueEnqueueTimeout = process.env.BOOT_QUEUE_ENQUEUE_TIMEOUT_MS;
    process.env.BOOT_TELEGRAM_WEBHOOK_SECRET = "e2e-webhook-secret";
    process.env.REDIS_URL = "";
    try {
      const rejectedWebhook = await app.request("/api/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "wrong-secret"
        },
        body: JSON.stringify({ update_id: 9001 })
      });
      if (rejectedWebhook.status !== 401) {
        throw new Error(`Telegram webhook should reject a wrong secret with 401, got ${rejectedWebhook.status}`);
      }

      const unavailableWebhook = await app.request("/api/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "e2e-webhook-secret"
        },
        body: JSON.stringify({ update_id: 9002 })
      });
      if (unavailableWebhook.status !== 503) {
        throw new Error(`Telegram webhook should report queue unavailability with 503, got ${unavailableWebhook.status}`);
      }
      const unavailableWebhookPayload = (await unavailableWebhook.json()) as { error?: string };
      if (unavailableWebhookPayload.error !== "Telegram webhook queue unavailable") {
        throw new Error("Telegram webhook leaked an internal queue error instead of returning a stable public error");
      }

      process.env.REDIS_URL = "redis://127.0.0.1:1";
      process.env.BOOT_QUEUE_ENQUEUE_TIMEOUT_MS = "250";
      const failedRedisStartedAt = Date.now();
      const failedRedisWebhook = await app.request("/api/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "e2e-webhook-secret"
        },
        body: JSON.stringify({ update_id: 9003 })
      });
      const failedRedisElapsedMs = Date.now() - failedRedisStartedAt;
      if (failedRedisWebhook.status !== 503) {
        throw new Error(`Telegram webhook should report Redis connection failure with 503, got ${failedRedisWebhook.status}`);
      }
      if (failedRedisElapsedMs > 2_000) {
        throw new Error(`Telegram webhook Redis failure should fail fast, took ${failedRedisElapsedMs}ms`);
      }
    } finally {
      restoreEnv("BOOT_TELEGRAM_WEBHOOK_SECRET", originalWebhookSecret);
      restoreEnv("REDIS_URL", originalRedisUrl);
      restoreEnv("BOOT_QUEUE_ENQUEUE_TIMEOUT_MS", originalQueueEnqueueTimeout);
    }

    const lastSuperAdminGuardStatus =
      (await countActiveSuperAdmins()) <= 1
        ? (
            await authedRequest(`/api/admin-users/${loginPayload.user.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status: "disabled" })
            })
          ).status
        : "skipped-existing-super-admins";
    if (lastSuperAdminGuardStatus !== "skipped-existing-super-admins" && lastSuperAdminGuardStatus !== 400) {
      throw new Error(`Last active super admin guard should return 400, got ${lastSuperAdminGuardStatus}`);
    }

    const runtimeSettings = await patchRuntimeSettings({
      gatewayPreset: "new_api",
      bootBaseUrl: `http://127.0.0.1:${port}/v1`,
      bootChatBaseUrl: `http://127.0.0.1:${port}/v1`,
      bootEmbeddingBaseUrl: `http://127.0.0.1:${port}/v1`,
      bootImageBaseUrl: `http://127.0.0.1:${port}/v1`,
      bootChatModel: "mock-chat",
      bootSearchProvider: "tavily",
      bootSearchBaseUrl: `http://127.0.0.1:${port}`,
      bootWikipediaApiUrl: `http://127.0.0.1:${port}/wiki/api.php`,
      bootMoegirlApiUrl: `http://127.0.0.1:${port}/moegirl/api.php`,
      bootSearchMaxResults: 5,
      bootSearchDepth: "basic",
      bootApiKey: "e2e-local-key",
      bootSearchApiKey: "e2e-local-search-key"
    });
    if (
      runtimeSettings.data.bootBaseUrl !== `http://127.0.0.1:${port}/v1` ||
      runtimeSettings.data.bootEmbeddingModel !== "text-embedding-3-large" ||
      runtimeSettings.data.bootImageModel !== "chatgpt-image-latest" ||
      runtimeSettings.data.bootSearchProvider !== "tavily" ||
      !runtimeSettings.data.secrets?.bootApiKey ||
      !runtimeSettings.data.secrets.bootSearchApiKey
    ) {
      throw new Error("Runtime settings did not persist new-api relay and secret status");
    }

    const isolatedChatBasePatch = await patchRuntimeSettings({
      bootChatBaseUrl: "http://127.0.0.1:1/v1"
    });
    if (isolatedChatBasePatch.data.bootChatBaseUrl !== "http://127.0.0.1:1/v1") {
      throw new Error("Runtime settings should allow chat base URL updates without probing the unchanged chat model");
    }
    const restoredChatBasePatch = await patchRuntimeSettings({
      bootChatBaseUrl: `http://127.0.0.1:${port}/v1`
    });
    if (restoredChatBasePatch.data.bootChatBaseUrl !== `http://127.0.0.1:${port}/v1`) {
      throw new Error("Runtime settings did not restore the chat base URL after isolated patch validation");
    }

    const failedAtomicSettingsResponse = await (async () => {
      const originalSettingsEncryptionKey = process.env.BOOT_SETTINGS_ENCRYPTION_KEY;
      process.env.BOOT_SETTINGS_ENCRYPTION_KEY = "";
      try {
        return await authedRequest("/api/system/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bootBaseUrl: "http://127.0.0.1:1/v1",
            bootApiKey: "should-not-persist"
          })
        });
      } finally {
        process.env.BOOT_SETTINGS_ENCRYPTION_KEY = originalSettingsEncryptionKey;
      }
    })();
    if (failedAtomicSettingsResponse.status !== 400) {
      throw new Error(`Runtime settings secret validation should fail with 400, got ${failedAtomicSettingsResponse.status}`);
    }
    const settingsAfterFailedAtomicPatchResponse = await authedRequest("/api/system/settings");
    if (!settingsAfterFailedAtomicPatchResponse.ok) {
      throw new Error(
        `Runtime settings read after failed patch failed with ${settingsAfterFailedAtomicPatchResponse.status}: ${await settingsAfterFailedAtomicPatchResponse.text()}`
      );
    }
    const settingsAfterFailedAtomicPatch = (await settingsAfterFailedAtomicPatchResponse.json()) as {
      data?: { bootBaseUrl?: string };
    };
    if (settingsAfterFailedAtomicPatch.data?.bootBaseUrl !== `http://127.0.0.1:${port}/v1`) {
      throw new Error("Runtime settings partial public change persisted after secret validation failed");
    }

    const firstChat = await authedRequest("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        telegramUserId: apiTelegramUserId,
        username: "e2e_user",
        content: "我喜欢你叫我小雪，也喜欢稻妻茶点。请记住这点。"
      })
    });

    if (!firstChat.ok) {
      throw new Error(`First chat route failed with ${firstChat.status}: ${await firstChat.text()}`);
    }

    const firstPayload = (await firstChat.json()) as { reply?: string; memoryCount?: number; cacheStatus?: string };
    if (!firstPayload.reply || typeof firstPayload.memoryCount !== "number") {
      throw new Error("First chat route returned an invalid payload");
    }
    if (firstPayload.cacheStatus !== "disabled") {
      throw new Error(`Semantic cache should be disabled during E2E smoke, got ${firstPayload.cacheStatus ?? "missing"}`);
    }

    const memoryWorkerStrictFailure = await (async () => {
      try {
        await processMemoryEnrichmentJob({
          userId: apiTelegramUserId,
          displayName: "E2E",
          content: "这是一条 E2E 链路 worker 严格失败传播验证。",
          reply: "我会尝试提炼这条记忆。",
          sourceMessageId: "not-a-valid-uuid"
        });
        return false;
      } catch {
        return true;
      }
    })();
    if (!memoryWorkerStrictFailure) {
      throw new Error("Memory enrichment worker should propagate persistence failures so BullMQ can retry");
    }

    const apiMemories = await listMemories({ telegramUserId: apiTelegramUserId, limit: 5, offset: 0 });
    if (!apiMemories.some((memory) => memory.summary.includes("小雪") && memory.summary.includes("稻妻茶点"))) {
      throw new Error("Expected API memory to preserve the user's nickname and preference");
    }

    const secondChat = await authedRequest("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        telegramUserId: apiTelegramUserId,
        username: "e2e_user",
        content: "你还记得对我的印象吗？"
      })
    });

    if (!secondChat.ok) {
      throw new Error(`Second chat route failed with ${secondChat.status}: ${await secondChat.text()}`);
    }

    const secondPayload = (await secondChat.json()) as { reply?: string; memoryCount?: number };
    if (!secondPayload.reply || (secondPayload.memoryCount ?? 0) < 1) {
      throw new Error("Second chat route did not retrieve long-term memory");
    }
    if (!secondPayload.reply.includes("小雪") || !secondPayload.reply.includes("稻妻茶点")) {
      throw new Error("Second chat reply did not naturally use the stored user impression");
    }

    const firstBotResult = await replyAsMakoto(
      {
        from: {
          id: botUserNumericId,
          is_bot: false,
          first_name: "E2E",
          username: "e2e_bot_user",
          language_code: "zh"
        },
        chat: { id: -1009876543210, type: "supergroup" },
        message: { message_id: 42 }
      } as never,
      "我是 bot 路径里的小雪，也喜欢团子牛奶。请记住。"
    );
    if (!firstBotResult.reply) {
      throw new Error("First bot conversation core returned an empty reply");
    }
    const duplicateBotResult = await replyAsMakoto(
      {
        from: {
          id: botUserNumericId,
          is_bot: false,
          first_name: "E2E",
          username: "e2e_bot_user",
          language_code: "zh"
        },
        chat: { id: -1009876543210, type: "supergroup" },
        message: { message_id: 42 }
      } as never,
      "我是 bot 路径里的小雪，也喜欢团子牛奶。请记住。"
    );
    if (
      duplicateBotResult.userMessageId !== firstBotResult.userMessageId ||
      duplicateBotResult.assistantMessageId !== firstBotResult.assistantMessageId
    ) {
      throw new Error("Duplicate Telegram message_id should reuse the saved conversation turn");
    }
    const differentChatSameTelegramMessageId = await replyAsMakoto(
      {
        from: {
          id: botUserNumericId,
          is_bot: false,
          first_name: "E2E",
          username: "e2e_bot_user",
          language_code: "zh"
        },
        chat: { id: -1009876543211, type: "supergroup" },
        message: { message_id: 42 }
      } as never,
      "同一个 Telegram message_id 但来自不同 chat，应该保存为独立轮次。"
    );
    if (differentChatSameTelegramMessageId.userMessageId === firstBotResult.userMessageId) {
      throw new Error("Same Telegram message_id from a different chat must not reuse the first chat's turn");
    }

    const botMemories = await listMemories({ telegramUserId: botTelegramUserId, limit: 5, offset: 0 });
    if (!botMemories.some((memory) => memory.summary.includes("小雪") && memory.summary.includes("团子牛奶"))) {
      throw new Error("Expected bot memory to preserve the user's nickname and preference");
    }

    const secondBotResult = await replyAsMakoto(
      {
        from: {
          id: botUserNumericId,
          is_bot: false,
          first_name: "E2E",
          username: "e2e_bot_user",
          language_code: "zh"
        },
        chat: { id: -1009876543210, type: "supergroup" },
        message: { message_id: 43 }
      } as never,
      "你对我有什么印象？"
    );
    if (secondBotResult.memoryCount < 1) {
      throw new Error("Second bot conversation did not retrieve long-term memory");
    }
    if (!secondBotResult.reply.includes("小雪") || !secondBotResult.reply.includes("团子牛奶")) {
      throw new Error("Second bot reply did not naturally use the stored user impression");
    }

    if (relayState.memoryPrompts.length < 2) {
      throw new Error("Expected both API and bot prompts to include retrieved long-term memory");
    }

    const pendingGroupAccess = await resolveTelegramChatAccess({
      chatId: "-1001234567890",
      type: "supergroup",
      title: "E2E Pending Group",
      command: "start"
    });
    if (pendingGroupAccess.allowed || pendingGroupAccess.chat.status !== "pending") {
      throw new Error("Unknown Telegram group should start as pending and blocked");
    }
    await updateTelegramChat("-1001234567890", { status: "approved" });
    const approvedGroupAccess = await resolveTelegramChatAccess({
      chatId: "-1001234567890",
      type: "supergroup",
      title: "E2E Pending Group",
      command: "start"
    });
    if (!approvedGroupAccess.allowed) {
      throw new Error("Approved Telegram group should be allowed");
    }
    await putCommandPermission({ chatId: null, command: "start", enabled: false });
    const globallyBlockedCommandAccess = await resolveTelegramChatAccess({
      chatId: "-1001234567890",
      type: "supergroup",
      title: "E2E Pending Group",
      command: "start"
    });
    if (globallyBlockedCommandAccess.allowed || globallyBlockedCommandAccess.reason !== "command_disabled") {
      throw new Error("Global Telegram command permission should block the command");
    }
    await putCommandPermission({ chatId: "-1001234567890", command: "start", enabled: true });
    const scopedCommandOverrideAccess = await resolveTelegramChatAccess({
      chatId: "-1001234567890",
      type: "supergroup",
      title: "E2E Pending Group",
      command: "start"
    });
    if (!scopedCommandOverrideAccess.allowed) {
      throw new Error("Chat-scoped Telegram command permission should override the global rule");
    }
    const modelCommandRuleResponse = await authedRequest("/api/telegram/command-permissions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: null, command: "model", enabled: false })
    });
    if (modelCommandRuleResponse.status !== 400) {
      throw new Error(`Reserved /model command permission should be rejected, got ${modelCommandRuleResponse.status}`);
    }
    const slashModelCommandRuleResponse = await authedRequest("/api/telegram/command-permissions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: null, command: "/model", enabled: false })
    });
    if (slashModelCommandRuleResponse.status !== 400) {
      throw new Error(`Reserved /model command permission with leading slash should be rejected, got ${slashModelCommandRuleResponse.status}`);
    }
    const repositoryRejectedModelCommand = await (async () => {
      try {
        await upsertTelegramCommandPermission({ chatId: null, command: "model", enabled: false });
        return false;
      } catch {
        return true;
      }
    })();
    if (!repositoryRejectedModelCommand) {
      throw new Error("Repository should reject reserved /model command permission writes");
    }
    const repositoryRejectedSlashModelCommand = await (async () => {
      try {
        await upsertTelegramCommandPermission({ chatId: null, command: "/model", enabled: false });
        return false;
      } catch {
        return true;
      }
    })();
    if (!repositoryRejectedSlashModelCommand) {
      throw new Error("Repository should reject reserved /model command permission writes with leading slash");
    }
    const modelCommandAccess = await resolveTelegramChatAccess({
      chatId: "-1001234567890",
      type: "supergroup",
      title: "E2E Pending Group",
      command: "model"
    });
    if (!modelCommandAccess.allowed) {
      throw new Error("Hidden /model command should remain readable for approved chats when no permission rule exists");
    }
    const slashModelCommandAccess = await resolveTelegramChatAccess({
      chatId: "-1001234567890",
      type: "supergroup",
      title: "E2E Pending Group",
      command: "/model"
    });
    if (!slashModelCommandAccess.allowed) {
      throw new Error("Hidden /model command access should normalize a leading slash");
    }
    const scopedPermission = (await putCommandPermission({ chatId: "-1001234567890", command: "start", enabled: true })) as {
      data: { id: string };
    };
    const deleteScopedPermissionResponse = await authedRequest(`/api/telegram/command-permissions/${scopedPermission.data.id}`, {
      method: "DELETE"
    });
    if (!deleteScopedPermissionResponse.ok) {
      throw new Error(
        `Telegram command permission delete failed with ${deleteScopedPermissionResponse.status}: ${await deleteScopedPermissionResponse.text()}`
      );
    }
    const resetScopedCommandAccess = await resolveTelegramChatAccess({
      chatId: "-1001234567890",
      type: "supergroup",
      title: "E2E Pending Group",
      command: "start"
    });
    if (resetScopedCommandAccess.allowed || resetScopedCommandAccess.reason !== "command_disabled") {
      throw new Error("Deleting chat-scoped Telegram command permission should restore global inheritance");
    }

    const toolsResponse = await authedRequest("/api/search/tools");
    if (!toolsResponse.ok) {
      throw new Error(`Search tools route failed with ${toolsResponse.status}: ${await toolsResponse.text()}`);
    }
    const toolsPayload = (await toolsResponse.json()) as { tools?: BootToolDescriptor[] };
    const tools = toolsPayload.tools ?? [];
    const webTool = tools.find((tool) => tool.name === "web_search");
    const googleTool = tools.find((tool) => tool.name === "google_search");
    const imageTool = tools.find((tool) => tool.name === "makoto_image");
    if (
      !webTool ||
      !googleTool ||
      !imageTool ||
      !tools.some((tool) => tool.name === "wikipedia_search") ||
      !tools.some((tool) => tool.name === "moegirl_search")
    ) {
      throw new Error("Boot tool registry did not expose routed search, specialized search, and image tools");
    }
    if (
      webTool.exposure !== "direct" ||
      googleTool.exposure !== "deferred" ||
      !webTool.readOnly ||
      webTool.destructive ||
      !webTool.concurrencySafe ||
      !webTool.capabilities.includes("router")
    ) {
      throw new Error("Boot tool registry did not expose expected safety and discovery metadata");
    }
    if (
      imageTool.exposure !== "direct" ||
      imageTool.readOnly ||
      imageTool.destructive ||
      !imageTool.concurrencySafe ||
      !imageTool.capabilities.includes("image") ||
      !imageTool.capabilities.includes("generation")
    ) {
      throw new Error("Boot tool registry did not expose expected image tool metadata");
    }

    const exactToolSearchResponse = await authedRequest("/api/search/tools/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "select:moegirl_search,web_search,moegirl_search",
        maxResults: 5
      })
    });
    if (!exactToolSearchResponse.ok) {
      throw new Error(`Tool exact-search route failed with ${exactToolSearchResponse.status}: ${await exactToolSearchResponse.text()}`);
    }
    const exactToolSearchPayload = (await exactToolSearchResponse.json()) as BootToolSearchResponse;
    if (exactToolSearchPayload.matches.map((tool) => tool.name).join(",") !== "moegirl_search,web_search") {
      throw new Error("Tool exact-search route should preserve requested order and de-duplicate matches");
    }

    const keywordToolSearchResponse = await authedRequest("/api/search/tools/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "+persona anime",
        maxResults: 2
      })
    });
    if (!keywordToolSearchResponse.ok) {
      throw new Error(`Tool keyword-search route failed with ${keywordToolSearchResponse.status}: ${await keywordToolSearchResponse.text()}`);
    }
    const keywordToolSearchPayload = (await keywordToolSearchResponse.json()) as BootToolSearchResponse;
    if (keywordToolSearchPayload.matches[0]?.name !== "moegirl_search") {
      throw new Error("Tool keyword-search route did not rank curated persona search hints first");
    }

    const missingToolSearchResponse = await authedRequest("/api/search/tools/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "+not-a-real-capability web",
        maxResults: 2
      })
    });
    if (!missingToolSearchResponse.ok) {
      throw new Error(`Tool required-term search route failed with ${missingToolSearchResponse.status}: ${await missingToolSearchResponse.text()}`);
    }
    const missingToolSearchPayload = (await missingToolSearchResponse.json()) as BootToolSearchResponse;
    if (missingToolSearchPayload.matches.length !== 0) {
      throw new Error("Tool required-term search should return no matches when required terms are absent");
    }

    const searchResponse = await authedRequest("/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "RaidenShinBoot 工具架构",
        maxResults: 2
      })
    });
    if (!searchResponse.ok) {
      throw new Error(`Search route failed with ${searchResponse.status}: ${await searchResponse.text()}`);
    }
    const searchPayload = (await searchResponse.json()) as {
      provider?: string;
      channels?: string[];
      results?: Array<{ title?: string; url?: string; snippet?: string }>;
    };
    if (searchPayload.provider !== "router:google" || !searchPayload.channels?.includes("google") || searchPayload.results?.length !== 2) {
      throw new Error("Search route returned an invalid payload");
    }
    if (!searchPayload.results[0]?.url?.startsWith("https://example.com/")) {
      throw new Error("Search route did not normalize provider results");
    }

    await patchRuntimeSettings({ bootSearchProvider: "disabled" });
    const disabledSearchResponse = await authedRequest("/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "should return a configuration error",
        maxResults: 1
      })
    });
    if (disabledSearchResponse.status !== 503) {
      throw new Error(`Disabled search route should return 503, got ${disabledSearchResponse.status}`);
    }
    await patchRuntimeSettings({ bootSearchProvider: "tavily" });

    const searchChat = await authedRequest("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        telegramUserId: apiTelegramUserId,
        username: "e2e_user",
        content: "请联网搜索 RaidenShinBoot 工具架构，并结合来源回答。"
      })
    });
    if (!searchChat.ok) {
      throw new Error(`Search-enabled chat route failed with ${searchChat.status}: ${await searchChat.text()}`);
    }
    const searchChatPayload = (await searchChat.json()) as { reply?: string; webSearchResultCount?: number };
    if (!searchChatPayload.reply || (searchChatPayload.webSearchResultCount ?? 0) < 1) {
      throw new Error("Search-enabled chat did not execute web_search");
    }
    if (!relayState.chatPrompts.some((prompt) => prompt.includes("搜索状态") && prompt.includes("raiden-tools"))) {
      throw new Error("Search-enabled chat did not inject web results into the Makoto prompt");
    }

    const knowledgeChat = await authedRequest("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        telegramUserId: apiTelegramUserId,
        username: "e2e_user",
        content: "雷电真是谁？请结合二次元角色设定和百科背景回答。"
      })
    });
    if (!knowledgeChat.ok) {
      throw new Error(`Knowledge-routed chat failed with ${knowledgeChat.status}: ${await knowledgeChat.text()}`);
    }
    const knowledgeChatPayload = (await knowledgeChat.json()) as { reply?: string; webSearchResultCount?: number };
    if (!knowledgeChatPayload.reply || (knowledgeChatPayload.webSearchResultCount ?? 0) < 1) {
      throw new Error("Knowledge-routed chat did not execute specialized search");
    }
    if (relayState.wikipediaQueries.length < 1 || relayState.moegirlQueries.length < 1) {
      throw new Error("Knowledge-routed chat did not query Wikipedia and Moegirl channels");
    }

    const failedSearchChatStatus = await (async () => {
      const searchQueryCountBeforeFailure = relayState.searchQueries.length;
      const originalSearchApiKey = process.env.BOOT_SEARCH_API_KEY;
      process.env.BOOT_SEARCH_API_KEY = "";
      try {
        await patchRuntimeSettings({ bootSearchApiKey: null });
        const failedSearchChat = await authedRequest("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            telegramUserId: apiTelegramUserId,
            username: "e2e_user",
            content: "请联网搜索 这个配置不可用时也不要中断聊天。"
          })
        });
        if (!failedSearchChat.ok) {
          throw new Error(`Search failure fallback chat failed with ${failedSearchChat.status}: ${await failedSearchChat.text()}`);
        }
        const failedSearchChatPayload = (await failedSearchChat.json()) as { reply?: string; webSearchStatus?: string };
        if (!failedSearchChatPayload.reply || failedSearchChatPayload.webSearchStatus !== "failed") {
          throw new Error("Search failure fallback chat did not report a failed web search state");
        }
        if (relayState.searchQueries.length !== searchQueryCountBeforeFailure) {
          throw new Error("Search failure fallback should not call the provider when the key is missing");
        }
        return failedSearchChatPayload.webSearchStatus;
      } finally {
        process.env.BOOT_SEARCH_API_KEY = originalSearchApiKey;
      }
    })();
    await patchRuntimeSettings({ bootSearchApiKey: "e2e-local-search-key" });

    const responseFallbackFailuresBefore = relayState.chatCompletionFailures;
    await patchRuntimeSettings({ bootChatModel: "mock-responses-only" });
    const responsesFallbackChat = await authedRequest("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        telegramUserId: apiTelegramUserId,
        username: "e2e_user",
        content: "请验证 Responses fallback 是否已经接入 bot 核心链路。"
      })
    });
    if (!responsesFallbackChat.ok) {
      throw new Error(`Responses fallback chat failed with ${responsesFallbackChat.status}: ${await responsesFallbackChat.text()}`);
    }
    const responsesFallbackPayload = (await responsesFallbackChat.json()) as { reply?: string };
    if (!responsesFallbackPayload.reply?.includes("Responses fallback")) {
      throw new Error("Responses fallback chat did not return the expected reply");
    }
    if (
      relayState.chatCompletionFailures <= responseFallbackFailuresBefore ||
      !relayState.responsesPrompts.some((prompt) => prompt.includes("Responses fallback"))
    ) {
      throw new Error("Responses fallback did not exercise the /v1/responses stream path");
    }
    await patchRuntimeSettings({ bootChatModel: "mock-chat" });

    const imageResponse = await authedRequest("/api/images", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "稻妻夜色里的樱花与柔和雷光",
        size: "1024x1024",
        n: 1
      })
    });
    if (!imageResponse.ok) {
      throw new Error(`Image route failed with ${imageResponse.status}: ${await imageResponse.text()}`);
    }
    const imagePayload = (await imageResponse.json()) as {
      images?: Array<{ base64?: string; mediaType?: string }>;
    };
    const generatedImage = imagePayload.images?.[0];
    if (!generatedImage?.base64 || !generatedImage.mediaType?.startsWith("image/")) {
      throw new Error("Image route returned an invalid image payload");
    }
    if (!relayState.imagePrompts.some((prompt) => prompt.includes("稻妻夜色") && prompt.includes("Raiden Makoto"))) {
      throw new Error("Image prompt did not include the user request and Makoto visual guidance");
    }
    const autonomousImagePromptCountBefore = relayState.imagePrompts.length;
    const autonomousImageChat = await authedRequest("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        telegramUserId: apiTelegramUserId,
        content: "E2E_CHAT_AUTONOMOUS_IMAGE ordinary planner-selected visual request"
      })
    });
    if (!autonomousImageChat.ok) {
      throw new Error(`Autonomous image chat failed with ${autonomousImageChat.status}: ${await autonomousImageChat.text()}`);
    }
    const autonomousImagePayload = (await autonomousImageChat.json()) as {
      images?: Array<{ base64?: string; mediaType?: string }>;
      toolDecision?: { action?: string };
      toolStatus?: { name?: string | null; status?: string };
    };
    if (
      autonomousImagePayload.toolDecision?.action !== "makoto_image" ||
      autonomousImagePayload.toolStatus?.name !== "makoto_image" ||
      autonomousImagePayload.toolStatus.status !== "completed" ||
      !autonomousImagePayload.images?.[0]?.base64
    ) {
      throw new Error("Autonomous image chat did not execute makoto_image and return an image");
    }
    if (
      relayState.imagePrompts.length <= autonomousImagePromptCountBefore ||
      !relayState.imagePrompts.some((prompt) => prompt.includes("自主生图画面") && prompt.includes("Raiden Makoto"))
    ) {
      throw new Error("Autonomous image chat did not rewrite and send the image prompt");
    }

    const semanticCacheSmoke = await (async () => {
      if (!process.env.REDIS_URL?.trim()) {
        return { skipped: true as const };
      }

      const originalSemanticCacheEnabled = process.env.BOOT_SEMANTIC_CACHE_ENABLED;
      const originalSemanticCacheNamespace = process.env.BOOT_SEMANTIC_CACHE_NAMESPACE;
      const originalSemanticCacheTimeout = process.env.BOOT_SEMANTIC_CACHE_TIMEOUT_MS;
      process.env.BOOT_SEMANTIC_CACHE_ENABLED = "true";
      process.env.BOOT_SEMANTIC_CACHE_NAMESPACE = `e2e-${Date.now()}`;
      process.env.BOOT_SEMANTIC_CACHE_TIMEOUT_MS = "5000";

      try {
        const cacheInput = {
          protocol: "telegram" as const,
          userId: semanticCacheTelegramUserId,
          username: "e2e_cache_user",
          content: "请温柔地说明这次验证链路"
        };
        const firstCacheChat = await runBootConversation(cacheInput);
        if (firstCacheChat.cacheStatus !== "miss") {
          throw new Error(`Semantic cache first chat should miss, got ${firstCacheChat.cacheStatus}`);
        }
        await waitForConversationExactCacheHit(cacheInput);
        const chatPromptCountAfterFirstCacheChat = relayState.chatPrompts.length;
        const cacheQueryEmbeddingCountAfterFirst = relayState.embeddingInputs.filter((input) => input === cacheInput.content).length;

        const secondCacheChat = await runBootConversation(cacheInput);
        if (secondCacheChat.cacheStatus !== "l1_hit") {
          throw new Error(`Semantic cache second chat should hit L1, got ${secondCacheChat.cacheStatus}`);
        }
        if (relayState.chatPrompts.length !== chatPromptCountAfterFirstCacheChat) {
          throw new Error("Semantic cache hit should not call the chat model again");
        }
        const cacheQueryEmbeddingCountAfterSecond = relayState.embeddingInputs.filter((input) => input === cacheInput.content).length;
        if (cacheQueryEmbeddingCountAfterSecond !== cacheQueryEmbeddingCountAfterFirst) {
          throw new Error("L1 semantic cache hit should not refresh cache through a new query embedding");
        }

        return { skipped: false as const, first: firstCacheChat.cacheStatus, second: secondCacheChat.cacheStatus };
      } finally {
        restoreEnv("BOOT_SEMANTIC_CACHE_ENABLED", originalSemanticCacheEnabled);
        restoreEnv("BOOT_SEMANTIC_CACHE_NAMESPACE", originalSemanticCacheNamespace);
        restoreEnv("BOOT_SEMANTIC_CACHE_TIMEOUT_MS", originalSemanticCacheTimeout);
      }
    })();

    console.log(
      JSON.stringify(
        {
          ok: true,
          apiTelegramUserId,
          botTelegramUserId,
          apiFirstMemoryCount: firstPayload.memoryCount,
          apiRecallMemoryCount: secondPayload.memoryCount,
          botRecallMemoryCount: secondBotResult.memoryCount,
          duplicateTelegramMessageReusedTurn: duplicateBotResult.userMessageId === firstBotResult.userMessageId,
          sameMessageIdDifferentChatSavedSeparately:
            differentChatSameTelegramMessageId.userMessageId !== firstBotResult.userMessageId,
          apiRecallReplyPreview: secondPayload.reply.slice(0, 80),
          botRecallReplyPreview: secondBotResult.reply.slice(0, 80),
          apiMemoryCount: apiMemories.length,
          botMemoryCount: botMemories.length,
          imageMediaType: generatedImage.mediaType,
          imageBase64Length: generatedImage.base64.length,
          memoryPromptCount: relayState.memoryPrompts.length,
          imagePromptCount: relayState.imagePrompts.length,
          searchQueryCount: relayState.searchQueries.length,
          wikipediaQueryCount: relayState.wikipediaQueries.length,
          moegirlQueryCount: relayState.moegirlQueries.length,
          disabledSearchStatus: disabledSearchResponse.status,
          failedSearchChatStatus,
          chatCompletionFailures: relayState.chatCompletionFailures,
          responsesPromptCount: relayState.responsesPrompts.length,
          summaryCount: relayState.summaries.length,
          semanticCacheStatus: semanticCacheSmoke.skipped ? "skipped" : semanticCacheSmoke.second,
          lastSuperAdminGuardStatus,
          atomicSettingsGuardStatus: failedAtomicSettingsResponse.status,
          pendingGroupInitiallyBlocked: !pendingGroupAccess.allowed,
          approvedGroupAllowed: approvedGroupAccess.allowed,
          globalCommandBlocked: !globallyBlockedCommandAccess.allowed,
          scopedCommandOverrideAllowed: scopedCommandOverrideAccess.allowed,
          modelCommandReadableForApprovedChat: modelCommandAccess.allowed,
          scopedCommandResetBlocked: !resetScopedCommandAccess.allowed,
          mockRelayBaseUrl: process.env.BOOT_BASE_URL
        },
        null,
        2
      )
    );
  } finally {
    await sql`delete from telegram_users where telegram_id in (${apiTelegramUserId}, ${semanticCacheTelegramUserId}, ${botTelegramUserId})`;
    await sql`delete from telegram_command_permissions where command in ('start', 'model') and (chat_id is null or chat_id = '-1001234567890')`;
    await sql`delete from telegram_chats where chat_id = '-1001234567890'`;
    await sql`delete from admin_users where username = ${adminUsername}`;
    await Promise.all(runtimeSettingKeys.map((key) => deleteRuntimeSetting(key)));
    await Promise.all(
      runtimeSettingsSnapshot.map((setting) =>
        upsertRuntimeSetting({
          key: setting.key,
          value: setting.value,
          encrypted: setting.encrypted,
          updatedByAdminId: setting.updatedByAdminId ?? null
        })
      )
    );
    await closeSemanticCache();
    await closeDatabase();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

await main();

async function waitForConversationExactCacheHit(input: Parameters<typeof runBootConversation>[0]) {
  const deadline = Date.now() + 3_000;
  let lastStatus = "unknown";

  while (Date.now() < deadline) {
    const [history, memories, bootConfig, searchConfig] = await Promise.all([
      getRecentMessages(input.userId, 12),
      listMemories({ telegramUserId: input.userId, limit: 10, offset: 0 }),
      getEffectiveBootConfig(),
      getEffectiveBootSearchConfig()
    ]);
    const contextFingerprint = buildConversationCacheContextFingerprint({
      protocol: input.protocol,
      userId: input.userId,
      chatModel: bootConfig.BOOT_CHAT_MODEL,
      embeddingModel: bootConfig.BOOT_EMBEDDING_MODEL,
      searchProvider: searchConfig.BOOT_SEARCH_PROVIDER,
      history,
      memories
    });
    const lookup = await lookupConversationCache({
      scope: conversationCacheScope(input),
      contextFingerprint,
      content: input.content,
      config: getSemanticCacheConfig(process.env)
    });
    lastStatus = lookup.status;
    if (lookup.status === "l1_hit") {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Semantic cache exact entry was not ready before timeout; last status: ${lastStatus}`);
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
