import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { closeDatabase, getSqlClient, listMemories } from "@raiden/database";
import { app } from "@raiden/server/app";
import { replyAsMakoto } from "../packages/bot/src/conversation.js";
import { config } from "dotenv";

config({ path: new URL("../.env", import.meta.url) });
config();

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function mockEmbedding(input: unknown) {
  const text = Array.isArray(input) ? input.join(" ") : String(input ?? "");
  const direction = /记得|印象|有什么印象|remember|impression/i.test(text) ? -1 : 1;
  return Array.from({ length: 3072 }, (_, index) => direction * (((index % 29) + 1) / 1000));
}

const onePixelPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

type MockRelayState = {
  chatPrompts: string[];
  imagePrompts: string[];
  summaryPrompts: string[];
  memoryPrompts: string[];
  summaries: string[];
};

function extractUserMessage(prompt: string) {
  return prompt.match(/用户消息：([\s\S]*?)\n助手回复：/)?.[1]?.trim() ?? "";
}

function createMockRelay(state: MockRelayState) {
  return createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const body = JSON.parse(await readBody(req)) as {
          model?: string;
          stream?: boolean;
          messages?: Array<{ role: string; content: string }>;
        };
        const system = body.messages?.find((message) => message.role === "system")?.content ?? "";
        const prompt = body.messages?.find((message) => message.role === "user")?.content ?? "";
        const isSummarizer = system.includes("长期记忆提炼器");
        let content = "你好，旅行者。我是真，这次端到端验证已经安稳地接入了雷光。";

        if (isSummarizer) {
          state.summaryPrompts.push(prompt);
          const userMessage = extractUserMessage(prompt);
          if (userMessage.includes("稻妻茶点")) {
            content = "用户喜欢被称作小雪，并喜欢稻妻茶点。";
          } else if (userMessage.includes("团子牛奶")) {
            content = "用户在 bot 路径喜欢被称作小雪，并喜欢团子牛奶。";
          } else if (userMessage.includes("E2E 链路")) {
            content = "用户正在进行 RaidenShinBoot 本地端到端验证。";
          } else if (userMessage.includes("bot 核心链路")) {
            content = "用户正在验证 bot 核心链路。";
          } else {
            content = "EMPTY";
          }
          if (content !== "EMPTY") {
            state.summaries.push(content);
          }
        } else {
          state.chatPrompts.push(prompt);
          if (prompt.includes("长期记忆：\n1. 用户喜欢被称作小雪，并喜欢稻妻茶点")) {
            state.memoryPrompts.push(prompt);
            content = "小雪，我记得你喜欢稻妻茶点；这样的印象我会好好留在心里。";
          } else if (prompt.includes("长期记忆：\n1. 用户在 bot 路径喜欢被称作小雪，并喜欢团子牛奶")) {
            state.memoryPrompts.push(prompt);
            content = "小雪，我记得在 bot 路径里你喜欢团子牛奶，这也是我对你的清晰印象。";
          }
        }

        if (body.stream) {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive"
          });
          res.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-e2e",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: body.model ?? "mock-chat",
              choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }]
            })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-e2e",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: body.model ?? "mock-chat",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
            })}\n\n`
          );
          res.end("data: [DONE]\n\n");
          return;
        }

        sendJson(res, 200, {
          id: "chatcmpl-e2e",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model ?? "mock-chat",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/embeddings") {
        const body = JSON.parse(await readBody(req)) as { input?: unknown; model?: string };
        sendJson(res, 200, {
          object: "list",
          model: body.model ?? "mock-embedding",
          data: [{ object: "embedding", index: 0, embedding: mockEmbedding(body.input) }],
          usage: { prompt_tokens: 1, total_tokens: 1 }
        });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/images/generations") {
        const body = JSON.parse(await readBody(req)) as { prompt?: string; model?: string; n?: number };
        state.imagePrompts.push(body.prompt ?? "");
        sendJson(res, 200, {
          created: Math.floor(Date.now() / 1000),
          data: Array.from({ length: body.n ?? 1 }, () => ({
            b64_json: onePixelPngBase64,
            revised_prompt: body.prompt ?? ""
          }))
        });
        return;
      }

      sendJson(res, 404, { error: "mock route not found" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : "mock relay error" });
    }
  });
}

async function listen(server: ReturnType<typeof createMockRelay>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind mock relay");
  }
  return address.port;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for E2E smoke test");
  }

  const relayState: MockRelayState = {
    chatPrompts: [],
    imagePrompts: [],
    summaryPrompts: [],
    memoryPrompts: [],
    summaries: []
  };
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
