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

function mockEmbedding() {
  return Array.from({ length: 3072 }, (_, index) => ((index % 29) + 1) / 1000);
}

function createMockRelay() {
  return createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const body = JSON.parse(await readBody(req)) as {
          model?: string;
          stream?: boolean;
          messages?: Array<{ role: string; content: string }>;
        };
        const system = body.messages?.find((message) => message.role === "system")?.content ?? "";
        const content = system.includes("长期记忆提炼器")
          ? "用户正在进行 RaidenShinBoot 本地端到端验证。"
          : "你好，旅行者。我是真，这次端到端验证已经安稳地接入了雷光。";
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
        const body = JSON.parse(await readBody(req)) as { model?: string };
        sendJson(res, 200, {
          object: "list",
          model: body.model ?? "mock-embedding",
          data: [{ object: "embedding", index: 0, embedding: mockEmbedding() }],
          usage: { prompt_tokens: 1, total_tokens: 1 }
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

  const server = createMockRelay();
  const port = await listen(server);
  const apiTelegramUserId = `e2e-api-${Date.now()}`;
  const botUserNumericId = Date.now() % 1_000_000_000;
  const botTelegramUserId = String(botUserNumericId);
  const sql = getSqlClient();

  process.env.BOOT_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.BOOT_API_KEY = "e2e-local-key";
  process.env.BOOT_CHAT_MODEL = "mock-chat";
  process.env.BOOT_EMBEDDING_MODEL = "mock-embedding";

  try {
    await sql`delete from telegram_users where telegram_id in (${apiTelegramUserId}, ${botTelegramUserId})`;

    const health = await app.request("/api/health");
    if (!health.ok) {
      throw new Error(`Health check failed with ${health.status}`);
    }

    const chat = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        telegramUserId: apiTelegramUserId,
        username: "e2e_user",
        content: "请用一句话确认本地 E2E 链路可用。"
      })
    });

    if (!chat.ok) {
      throw new Error(`Chat route failed with ${chat.status}: ${await chat.text()}`);
    }

    const payload = (await chat.json()) as { reply?: string; memoryCount?: number };
    if (!payload.reply || typeof payload.memoryCount !== "number") {
      throw new Error("Chat route returned an invalid payload");
    }

    const apiMemories = await listMemories({ telegramUserId: apiTelegramUserId, limit: 5, offset: 0 });
    if (apiMemories.length < 1) {
      throw new Error("Expected at least one API memory created by summarizeForMemory");
    }

    const botResult = await replyAsMakoto(
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
      "请从 bot 核心链路确认 E2E 可用。"
    );
    if (!botResult.reply) {
      throw new Error("Bot conversation core returned an empty reply");
    }

    const botMemories = await listMemories({ telegramUserId: botTelegramUserId, limit: 5, offset: 0 });
    if (botMemories.length < 1) {
      throw new Error("Expected at least one bot memory created by summarizeForMemory");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          apiTelegramUserId,
          botTelegramUserId,
          apiReplyPreview: payload.reply.slice(0, 80),
          botReplyPreview: botResult.reply.slice(0, 80),
          apiMemoryCount: apiMemories.length,
          botMemoryCount: botMemories.length,
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
