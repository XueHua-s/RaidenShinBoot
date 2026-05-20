import {
  closeDatabase,
  createAdminUser,
  deleteRuntimeSetting,
  getSqlClient,
  listRuntimeSettings,
  listMemories,
  resolveTelegramChatAccess,
  updateTelegramChat,
  upsertRuntimeSetting
} from "@raiden/database";
import { app } from "@raiden/server/app";
import { hashPassword } from "@raiden/server/auth";
import type { BootToolDescriptor, BootToolSearchResponse } from "@raiden/shared";
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
    "BOOT_SEARCH_DEPTH"
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

  try {
    await Promise.all(runtimeSettingKeys.map((key) => deleteRuntimeSetting(key)));
    await sql`delete from telegram_users where telegram_id in (${apiTelegramUserId}, ${botTelegramUserId})`;
    await sql`delete from telegram_command_permissions where command = 'start' and (chat_id is null or chat_id = '-1001234567890')`;
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
    const loginPayload = (await loginResponse.json()) as { csrfToken?: string };
    if (!sessionCookie || !loginPayload.csrfToken) {
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

    const runtimeSettings = await patchRuntimeSettings({
      gatewayPreset: "new_api",
      bootBaseUrl: `http://127.0.0.1:${port}/v1`,
      bootChatBaseUrl: `http://127.0.0.1:${port}/v1`,
      bootEmbeddingBaseUrl: `http://127.0.0.1:${port}/v1`,
      bootImageBaseUrl: `http://127.0.0.1:${port}/v1`,
      bootChatModel: "mock-chat",
      bootEmbeddingModel: "mock-embedding",
      bootImageModel: "mock-image",
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
      runtimeSettings.data.bootSearchProvider !== "tavily" ||
      !runtimeSettings.data.secrets?.bootApiKey ||
      !runtimeSettings.data.secrets.bootSearchApiKey
    ) {
      throw new Error("Runtime settings did not persist new-api relay and secret status");
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

    const firstPayload = (await firstChat.json()) as { reply?: string; memoryCount?: number };
    if (!firstPayload.reply || typeof firstPayload.memoryCount !== "number") {
      throw new Error("First chat route returned an invalid payload");
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
        message: { message_id: 42 }
      } as never,
      "我是 bot 路径里的小雪，也喜欢团子牛奶。请记住。"
    );
    if (!firstBotResult.reply) {
      throw new Error("First bot conversation core returned an empty reply");
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

    const toolsResponse = await authedRequest("/api/search/tools");
    if (!toolsResponse.ok) {
      throw new Error(`Search tools route failed with ${toolsResponse.status}: ${await toolsResponse.text()}`);
    }
    const toolsPayload = (await toolsResponse.json()) as { tools?: BootToolDescriptor[] };
    const tools = toolsPayload.tools ?? [];
    const webTool = tools.find((tool) => tool.name === "web_search");
    const googleTool = tools.find((tool) => tool.name === "google_search");
    if (
      !webTool ||
      !googleTool ||
      !tools.some((tool) => tool.name === "wikipedia_search") ||
      !tools.some((tool) => tool.name === "moegirl_search")
    ) {
      throw new Error("Boot tool registry did not expose routed and specialized search tools");
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

    const searchQueryCountBeforeFailure = relayState.searchQueries.length;
    const originalSearchApiKey = process.env.BOOT_SEARCH_API_KEY;
    process.env.BOOT_SEARCH_API_KEY = "";
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
    process.env.BOOT_SEARCH_API_KEY = originalSearchApiKey;
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

    console.log(
      JSON.stringify(
        {
          ok: true,
          apiTelegramUserId,
          botTelegramUserId,
          apiFirstMemoryCount: firstPayload.memoryCount,
          apiRecallMemoryCount: secondPayload.memoryCount,
          botRecallMemoryCount: secondBotResult.memoryCount,
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
          failedSearchChatStatus: failedSearchChatPayload.webSearchStatus,
          chatCompletionFailures: relayState.chatCompletionFailures,
          responsesPromptCount: relayState.responsesPrompts.length,
          summaryCount: relayState.summaries.length,
          pendingGroupInitiallyBlocked: !pendingGroupAccess.allowed,
          approvedGroupAllowed: approvedGroupAccess.allowed,
          globalCommandBlocked: !globallyBlockedCommandAccess.allowed,
          scopedCommandOverrideAllowed: scopedCommandOverrideAccess.allowed,
          mockRelayBaseUrl: process.env.BOOT_BASE_URL
        },
        null,
        2
      )
    );
  } finally {
    await sql`delete from telegram_users where telegram_id in (${apiTelegramUserId}, ${botTelegramUserId})`;
    await sql`delete from telegram_command_permissions where command = 'start' and (chat_id is null or chat_id = '-1001234567890')`;
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
    await closeDatabase();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

await main();
