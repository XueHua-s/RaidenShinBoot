import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type MockRelayState = {
  chatPrompts: string[];
  imagePrompts: string[];
  searchQueries: string[];
  summaryPrompts: string[];
  memoryPrompts: string[];
  summaries: string[];
};

export function createMockRelayState(): MockRelayState {
  return {
    chatPrompts: [],
    imagePrompts: [],
    searchQueries: [],
    summaryPrompts: [],
    memoryPrompts: [],
    summaries: []
  };
}

export function createMockRelay(state: MockRelayState) {
  return createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        await handleChatCompletion(req, res, state);
        return;
      }

      if (req.method === "POST" && req.url === "/v1/embeddings") {
        await handleEmbedding(req, res);
        return;
      }

      if (req.method === "POST" && req.url === "/v1/images/generations") {
        await handleImageGeneration(req, res, state);
        return;
      }

      if (req.method === "POST" && req.url === "/search") {
        await handleSearch(req, res, state);
        return;
      }

      sendJson(res, 404, { error: "mock route not found" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : "mock relay error" });
    }
  });
}

export async function listen(server: ReturnType<typeof createMockRelay>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind mock relay");
  }
  return address.port;
}

async function handleChatCompletion(req: IncomingMessage, res: ServerResponse, state: MockRelayState) {
  const body = JSON.parse(await readBody(req)) as {
    model?: string;
    stream?: boolean;
    messages?: Array<{ role: string; content: string }>;
  };
  const system = body.messages?.find((message) => message.role === "system")?.content ?? "";
  const prompt = body.messages?.find((message) => message.role === "user")?.content ?? "";
  const content = resolveMockChatContent(system, prompt, state);

  if (body.stream) {
    sendChatStream(res, body.model ?? "mock-chat", content);
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
}

async function handleEmbedding(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req)) as { input?: unknown; model?: string };
  sendJson(res, 200, {
    object: "list",
    model: body.model ?? "mock-embedding",
    data: [{ object: "embedding", index: 0, embedding: mockEmbedding(body.input) }],
    usage: { prompt_tokens: 1, total_tokens: 1 }
  });
}

async function handleImageGeneration(req: IncomingMessage, res: ServerResponse, state: MockRelayState) {
  const body = JSON.parse(await readBody(req)) as { prompt?: string; model?: string; n?: number };
  state.imagePrompts.push(body.prompt ?? "");
  sendJson(res, 200, {
    created: Math.floor(Date.now() / 1000),
    data: Array.from({ length: body.n ?? 1 }, () => ({
      b64_json: onePixelPngBase64,
      revised_prompt: body.prompt ?? ""
    }))
  });
}

async function handleSearch(req: IncomingMessage, res: ServerResponse, state: MockRelayState) {
  const body = JSON.parse(await readBody(req)) as { query?: string; max_results?: number };
  state.searchQueries.push(body.query ?? "");
  sendJson(res, 200, {
    query: body.query ?? "",
    results: [
      {
        title: "RaidenShinBoot 工具架构验证",
        url: "https://example.com/raiden-tools",
        content: "Boot 工具层使用注册表、输入校验和可配置搜索提供商完成闭环。",
        published_date: "2026-05-20"
      },
      {
        title: "Codex CLI Tool Router Pattern",
        url: "https://github.com/openai/codex",
        content: "工具规格、运行时注册表和延迟搜索工具可以分层管理。"
      }
    ].slice(0, body.max_results ?? 5)
  });
}

function resolveMockChatContent(system: string, prompt: string, state: MockRelayState) {
  if (system.includes("长期记忆提炼器")) {
    return resolveMockSummary(prompt, state);
  }

  state.chatPrompts.push(prompt);
  if (prompt.includes("长期记忆：\n1. 用户喜欢被称作小雪，并喜欢稻妻茶点")) {
    state.memoryPrompts.push(prompt);
    return "小雪，我记得你喜欢稻妻茶点；这样的印象我会好好留在心里。";
  }
  if (prompt.includes("长期记忆：\n1. 用户在 bot 路径喜欢被称作小雪，并喜欢团子牛奶")) {
    state.memoryPrompts.push(prompt);
    return "小雪，我记得在 bot 路径里你喜欢团子牛奶，这也是我对你的清晰印象。";
  }
  if (prompt.includes("联网搜索结果")) {
    return "我已经查到资料，并会把来源与当下信息一起纳入判断。";
  }

  return "你好，旅行者。我是真，这次端到端验证已经安稳地接入了雷光。";
}

function resolveMockSummary(prompt: string, state: MockRelayState) {
  state.summaryPrompts.push(prompt);
  const userMessage = extractUserMessage(prompt);
  let content = "EMPTY";
  if (userMessage.includes("稻妻茶点")) {
    content = "用户喜欢被称作小雪，并喜欢稻妻茶点。";
  } else if (userMessage.includes("团子牛奶")) {
    content = "用户在 bot 路径喜欢被称作小雪，并喜欢团子牛奶。";
  } else if (userMessage.includes("E2E 链路")) {
    content = "用户正在进行 RaidenShinBoot 本地端到端验证。";
  } else if (userMessage.includes("bot 核心链路")) {
    content = "用户正在验证 bot 核心链路。";
  }

  if (content !== "EMPTY") {
    state.summaries.push(content);
  }
  return content;
}

function sendChatStream(res: ServerResponse, model: string, content: string) {
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
      model,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }]
    })}\n\n`
  );
  res.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    })}\n\n`
  );
  res.end("data: [DONE]\n\n");
}

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

function extractUserMessage(prompt: string) {
  return prompt.match(/用户消息：([\s\S]*?)\n助手回复：/)?.[1]?.trim() ?? "";
}

const onePixelPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
