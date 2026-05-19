import { closeDatabase, getSqlClient, listMemories } from "@raiden/database";
import { app } from "@raiden/server/app";
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
  const sql = getSqlClient();

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
  process.env.BOOT_SEARCH_API_KEY = "e2e-local-search-key";
  process.env.BOOT_SEARCH_MAX_RESULTS = "5";

  try {
    await sql`delete from telegram_users where telegram_id in (${apiTelegramUserId}, ${botTelegramUserId})`;

    const health = await app.request("/api/health");
    if (!health.ok) {
      throw new Error(`Health check failed with ${health.status}`);
    }

    const firstChat = await app.request("/api/chat", {
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

    const secondChat = await app.request("/api/chat", {
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

    const toolsResponse = await app.request("/api/search/tools");
    if (!toolsResponse.ok) {
      throw new Error(`Search tools route failed with ${toolsResponse.status}: ${await toolsResponse.text()}`);
    }
    const toolsPayload = (await toolsResponse.json()) as { tools?: Array<{ name?: string }> };
    if (!toolsPayload.tools?.some((tool) => tool.name === "web_search")) {
      throw new Error("Boot tool registry did not expose web_search");
    }

    const searchResponse = await app.request("/api/search", {
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
      results?: Array<{ title?: string; url?: string; snippet?: string }>;
    };
    if (searchPayload.provider !== "tavily" || searchPayload.results?.length !== 2) {
      throw new Error("Search route returned an invalid payload");
    }
    if (!searchPayload.results[0]?.url?.startsWith("https://example.com/")) {
      throw new Error("Search route did not normalize provider results");
    }

    const originalSearchProvider = process.env.BOOT_SEARCH_PROVIDER;
    process.env.BOOT_SEARCH_PROVIDER = "disabled";
    const disabledSearchResponse = await app.request("/api/search", {
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
    process.env.BOOT_SEARCH_PROVIDER = originalSearchProvider;

    const searchChat = await app.request("/api/chat", {
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
    if (!relayState.chatPrompts.some((prompt) => prompt.includes("联网搜索结果") && prompt.includes("raiden-tools"))) {
      throw new Error("Search-enabled chat did not inject web results into the Makoto prompt");
    }

    const searchQueryCountBeforeFailure = relayState.searchQueries.length;
    const originalSearchApiKey = process.env.BOOT_SEARCH_API_KEY;
    process.env.BOOT_SEARCH_API_KEY = "";
    const failedSearchChat = await app.request("/api/chat", {
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

    const imageResponse = await app.request("/api/images", {
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
          disabledSearchStatus: disabledSearchResponse.status,
          failedSearchChatStatus: failedSearchChatPayload.webSearchStatus,
          summaryCount: relayState.summaries.length,
          mockRelayBaseUrl: process.env.BOOT_BASE_URL
        },
        null,
        2
      )
    );
  } finally {
    await sql`delete from telegram_users where telegram_id in (${apiTelegramUserId}, ${botTelegramUserId})`;
    await closeDatabase();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

await main();
