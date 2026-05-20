import { createOpenAI } from "@ai-sdk/openai";
import { embed, generateImage } from "ai";
import { z } from "zod";
import { errorMessage, isAbortError, timeoutSignal } from "./fetch-timeout.js";
import { buildMemoryContext, raidenMakotoSystemPrompt } from "./persona.js";
import type { WebSearchResponse } from "./schemas.js";
import { formatWebSearchResultsForPrompt } from "./tools.js";

const optionalString = z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());
const optionalUrl = z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional());
const timeoutMs = z.coerce.number().int().min(1_000).max(600_000);

const bootEnvSchema = z.object({
  BOOT_BASE_URL: z.string().url().default("https://proxy.xhblog.top:3000/v1"),
  BOOT_CHAT_BASE_URL: optionalUrl,
  BOOT_EMBEDDING_BASE_URL: optionalUrl,
  BOOT_API_KEY: optionalString,
  BOOT_CHAT_API_KEY: optionalString,
  BOOT_EMBEDDING_API_KEY: optionalString,
  BOOT_IMAGE_API_KEY: optionalString,
  BOOT_CHAT_MODEL: z.string().default("gpt-5.5"),
  BOOT_EMBEDDING_MODEL: z.string().default("text-embedding-3-large"),
  BOOT_IMAGE_BASE_URL: optionalUrl,
  BOOT_IMAGE_MODEL: z.string().default("gpt-image-1"),
  BOOT_CHAT_TIMEOUT_MS: timeoutMs.default(90_000),
  BOOT_EMBEDDING_TIMEOUT_MS: timeoutMs.default(30_000),
  BOOT_IMAGE_TIMEOUT_MS: timeoutMs.default(180_000)
});

export type BootConfig = z.infer<typeof bootEnvSchema>;

export type ChatHistoryItem = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type MemoryHit = {
  summary: string;
  score?: number | null;
};

export class BootProviderError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = "BootProviderError";
    this.statusCode = statusCode;
  }
}

export function getBootConfig(env: NodeJS.ProcessEnv = process.env): BootConfig {
  return bootEnvSchema.parse(env);
}

function resolveApiKey(value: string | undefined, purpose: "chat" | "embedding" | "image") {
  if (value) {
    return value;
  }

  throw new Error(`BOOT_${purpose.toUpperCase()}_API_KEY or BOOT_API_KEY is required`);
}

function createEmbeddingProvider(config = getBootConfig()) {
  return createOpenAI({
    apiKey: resolveApiKey(config.BOOT_EMBEDDING_API_KEY ?? config.BOOT_API_KEY, "embedding"),
    baseURL: config.BOOT_EMBEDDING_BASE_URL ?? config.BOOT_BASE_URL
  });
}

function createImageProvider(config = getBootConfig()) {
  return createOpenAI({
    apiKey: resolveApiKey(config.BOOT_IMAGE_API_KEY ?? config.BOOT_API_KEY, "image"),
    baseURL: config.BOOT_IMAGE_BASE_URL ?? config.BOOT_BASE_URL
  });
}

async function generateStreamedText(input: { system: string; prompt: string; config: BootConfig }) {
  let chatError: unknown;
  try {
    return await generateChatCompletionsText(input);
  } catch (error) {
    chatError = error;
  }

  try {
    return await generateResponsesText(input);
  } catch (responsesError) {
    if (chatError instanceof BootProviderError && responsesError instanceof BootProviderError) {
      throw new BootProviderError(
        `${chatError.message}; Responses fallback failed: ${responsesError.message}`,
        responsesError.statusCode
      );
    }
    throw responsesError;
  }
}

async function generateChatCompletionsText(input: { system: string; prompt: string; config: BootConfig }) {
  const response = await fetchProvider(
    joinUrl(input.config.BOOT_CHAT_BASE_URL ?? input.config.BOOT_BASE_URL, "/chat/completions"),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveApiKey(input.config.BOOT_CHAT_API_KEY ?? input.config.BOOT_API_KEY, "chat")}`,
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify({
        model: input.config.BOOT_CHAT_MODEL,
        stream: true,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt }
        ]
      })
    },
    input.config.BOOT_CHAT_TIMEOUT_MS,
    "AI relay chat completions"
  );

  if (!response.ok) {
    throw chatProviderError(
      response.status,
      await readProviderText(response, input.config.BOOT_CHAT_TIMEOUT_MS, "AI relay chat completions")
    );
  }

  return readProviderStream(response, parseChatStreamEvent, input.config.BOOT_CHAT_TIMEOUT_MS, "AI relay chat completions");
}

async function generateResponsesText(input: { system: string; prompt: string; config: BootConfig }) {
  const response = await fetchProvider(
    joinUrl(input.config.BOOT_CHAT_BASE_URL ?? input.config.BOOT_BASE_URL, "/responses"),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveApiKey(input.config.BOOT_CHAT_API_KEY ?? input.config.BOOT_API_KEY, "chat")}`,
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify({
        model: input.config.BOOT_CHAT_MODEL,
        stream: true,
        instructions: input.system,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: input.prompt }]
          }
        ]
      })
    },
    input.config.BOOT_CHAT_TIMEOUT_MS,
    "AI relay Responses"
  );

  if (!response.ok) {
    throw chatProviderError(
      response.status,
      await readProviderText(response, input.config.BOOT_CHAT_TIMEOUT_MS, "AI relay Responses")
    );
  }

  return readProviderStream(response, parseResponsesStreamEvent, input.config.BOOT_CHAT_TIMEOUT_MS, "AI relay Responses");
}

async function fetchProvider(url: URL, init: RequestInit, timeoutMsValue: number, source: string) {
  try {
    return await fetch(url, {
      ...init,
      signal: timeoutSignal(timeoutMsValue)
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new BootProviderError(`${source} timed out after ${timeoutMsValue}ms.`, 504);
    }
    throw new BootProviderError(`${source} request failed: ${errorMessage(error)}`, 502);
  }
}

async function readProviderStream(
  response: Response,
  parseEvent: (event: string) => string,
  timeoutMsValue: number,
  source: string
) {
  try {
    return await readStreamedText(response, parseEvent);
  } catch (error) {
    if (isAbortError(error)) {
      throw new BootProviderError(`${source} stream timed out after ${timeoutMsValue}ms.`, 504);
    }
    throw error;
  }
}

async function readProviderText(response: Response, timeoutMsValue: number, source: string) {
  try {
    return await response.text();
  } catch (error) {
    if (isAbortError(error)) {
      throw new BootProviderError(`${source} response body timed out after ${timeoutMsValue}ms.`, 504);
    }
    throw new BootProviderError(`${source} response body failed: ${errorMessage(error)}`, 502);
  }
}

async function readStreamedText(response: Response, parseEvent: (event: string) => string) {
  let text = "";
  let buffer = "";
  const reader = response.body?.getReader();
  if (!reader) {
    throw new BootProviderError("AI relay did not return a readable chat stream.");
  }

  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    for (const event of events) {
      text += parseEvent(event);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    text += parseEvent(buffer);
  }

  const result = text.trim();
  if (!result) {
    throw new BootProviderError("AI relay returned an empty chat stream. Check the chat model, key quota, and gateway compatibility.");
  }

  return result;
}

function parseChatStreamEvent(event: string) {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") {
    return "";
  }

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new BootProviderError(`AI relay returned an invalid stream chunk: ${data.slice(0, 160)}`);
  }

  const error = payload && typeof payload === "object" ? (payload as { error?: { message?: unknown } }).error : null;
  if (error?.message && typeof error.message === "string") {
    throw new BootProviderError(error.message);
  }

  const choice = payload && typeof payload === "object" ? (payload as { choices?: Array<Record<string, unknown>> }).choices?.[0] : null;
  const delta = choice?.delta;
  if (delta && typeof delta === "object") {
    const content = (delta as { content?: unknown }).content;
    return typeof content === "string" ? content : "";
  }

  const message = choice?.message;
  if (message && typeof message === "object") {
    const content = (message as { content?: unknown }).content;
    return typeof content === "string" ? content : "";
  }

  return "";
}

function parseResponsesStreamEvent(event: string) {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") {
    return "";
  }

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new BootProviderError(`AI relay returned an invalid Responses stream chunk: ${data.slice(0, 160)}`);
  }

  const error = payload && typeof payload === "object" ? (payload as { error?: { message?: unknown } }).error : null;
  if (error?.message && typeof error.message === "string") {
    throw new BootProviderError(error.message);
  }

  if (!payload || typeof payload !== "object") {
    return "";
  }

  const eventPayload = payload as {
    type?: unknown;
    delta?: unknown;
  };

  if (eventPayload.type === "response.output_text.delta" && typeof eventPayload.delta === "string") {
    return eventPayload.delta;
  }

  return "";
}

function chatProviderError(statusCode: number, body: string) {
  let message = body || "Unknown provider error.";
  try {
    const payload = JSON.parse(body) as { error?: { message?: string } };
    message = payload.error?.message ?? message;
  } catch {
    message = body.slice(0, 500) || message;
  }

  return new BootProviderError(`AI relay failed with HTTP ${statusCode}: ${message}`, statusCode);
}

function joinUrl(baseUrl: string, path: string) {
  return new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

export async function embedText(value: string, config = getBootConfig()): Promise<number[]> {
  const provider = createEmbeddingProvider(config);
  let result: Awaited<ReturnType<typeof embed>>;
  try {
    result = await embed({
      model: provider.embedding(config.BOOT_EMBEDDING_MODEL),
      value,
      abortSignal: timeoutSignal(config.BOOT_EMBEDDING_TIMEOUT_MS)
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new BootProviderError(`AI relay embedding timed out after ${config.BOOT_EMBEDDING_TIMEOUT_MS}ms.`, 504);
    }
    throw new BootProviderError(`AI relay embedding failed: ${errorMessage(error)}`, 502);
  }

  if (result.embedding.length !== 3072) {
    throw new Error(
      `BOOT_EMBEDDING_MODEL must return 3072 dimensions for halfvec(3072); received ${result.embedding.length}`
    );
  }

  return result.embedding;
}

export async function generateMakotoReply(input: {
  userName?: string | null;
  content: string;
  history?: ChatHistoryItem[];
  memories?: MemoryHit[];
  webSearch?: WebSearchResponse | null;
  webSearchError?: string | null;
  config?: BootConfig;
}): Promise<string> {
  const config = input.config ?? getBootConfig();
  const memoryContext = buildMemoryContext(input.memories ?? []);
  const webSearchContext = input.webSearch
    ? formatWebSearchResultsForPrompt(input.webSearch)
    : input.webSearchError
      ? `联网搜索尝试失败：${input.webSearchError}\n请坦诚说明无法使用实时来源，不要编造不存在的搜索结果。`
      : "本轮没有使用联网搜索。";
  const historyText = (input.history ?? [])
    .slice(-12)
    .map((item) => `${item.role}: ${item.content}`)
    .join("\n");

  return generateStreamedText({
    config,
    system: raidenMakotoSystemPrompt,
    prompt: `对话对象：${input.userName ?? "旅行者"}

长期记忆：
${memoryContext}

联网资料：
${webSearchContext}

近期对话：
${historyText || "暂无近期对话。"}

用户刚刚说：
${input.content}

请以雷电真的语气自然回应。`
  });
}

export async function summarizeForMemory(input: {
  userName?: string | null;
  userMessage: string;
  assistantReply: string;
  config?: BootConfig;
}): Promise<string | null> {
  const config = input.config ?? getBootConfig();

  const text = await generateStreamedText({
    config,
    system:
      "你是长期记忆提炼器。只提炼稳定偏好、个人背景、长期目标、重要约定或值得未来引用的事实。没有值得记忆的信息时只输出 EMPTY。",
    prompt: `用户：${input.userName ?? "未知"}
用户消息：${input.userMessage}
助手回复：${input.assistantReply}

请用不超过 80 个中文字符总结一条长期记忆。`
  });

  const summary = text;
  return summary.toUpperCase() === "EMPTY" ? null : summary;
}

export async function generateMakotoImage(input: {
  prompt: string;
  size?: `${number}x${number}`;
  n?: number;
  config?: BootConfig;
}) {
  const config = input.config ?? getBootConfig();
  const provider = createImageProvider(config);
  let result: Awaited<ReturnType<typeof generateImage>>;
  try {
    result = await generateImage({
      model: provider.imageModel(config.BOOT_IMAGE_MODEL),
      prompt: [
        "Use a gentle, elegant visual mood inspired by Raiden Makoto: soft lightning, sakura, quiet Inazuma atmosphere, humane warmth.",
        "Do not include text, logos, watermarks, UI chrome, or official game screenshots.",
        `User image request: ${input.prompt}`
      ].join("\n"),
      n: input.n ?? 1,
      size: input.size ?? "1024x1024",
      abortSignal: timeoutSignal(config.BOOT_IMAGE_TIMEOUT_MS)
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new BootProviderError(`AI relay image generation timed out after ${config.BOOT_IMAGE_TIMEOUT_MS}ms.`, 504);
    }
    throw new BootProviderError(`AI relay image generation failed: ${errorMessage(error)}`, 502);
  }

  return {
    images: result.images.map((image) => ({
      base64: image.base64,
      mediaType: image.mediaType
    })),
    warnings: result.warnings.map((warning) => `${warning.type}: ${JSON.stringify(warning)}`)
  };
}
