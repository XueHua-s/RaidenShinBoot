import { createOpenAI } from "@ai-sdk/openai";
import { embed, generateImage } from "ai";
import { z } from "zod";
import { errorMessage, isAbortError, timeoutSignal } from "./fetch-timeout.js";
import { buildMemoryContext, raidenMakotoSystemPrompt } from "./persona.js";
import {
  bootToolDecisionSchema,
  providerModelListResponseSchema,
  type BootToolDecision,
  type ChatModelListResponse,
  type WebSearchResponse
} from "./schemas.js";
import { formatWebSearchResultsForPrompt, shouldUseBootSearchForMessage } from "./tools.js";

const optionalString = z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());
const optionalUrl = z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional());
const timeoutMs = z.coerce.number().int().min(1_000).max(600_000);

export const fixedBootEmbeddingModel = "text-embedding-3-large";
export const fixedBootImageModel = "chatgpt-image-latest";

const bootEnvSchema = z.object({
  BOOT_BASE_URL: z.string().url().default("https://proxy.xhblog.top:3000/v1"),
  BOOT_CHAT_BASE_URL: optionalUrl,
  BOOT_EMBEDDING_BASE_URL: optionalUrl,
  BOOT_API_KEY: optionalString,
  BOOT_CHAT_API_KEY: optionalString,
  BOOT_EMBEDDING_API_KEY: optionalString,
  BOOT_IMAGE_API_KEY: optionalString,
  BOOT_CHAT_MODEL: z.string().default("gpt-5.5"),
  BOOT_EMBEDDING_MODEL: z.string().default(fixedBootEmbeddingModel),
  BOOT_IMAGE_BASE_URL: optionalUrl,
  BOOT_IMAGE_MODEL: z.string().default(fixedBootImageModel),
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
  const config = bootEnvSchema.parse(env);
  return {
    ...config,
    BOOT_EMBEDDING_MODEL: fixedBootEmbeddingModel,
    BOOT_IMAGE_MODEL: fixedBootImageModel
  };
}

function withMaxChatTimeout(config: BootConfig, maxTimeoutMs: number): BootConfig {
  return config.BOOT_CHAT_TIMEOUT_MS > maxTimeoutMs
    ? {
        ...config,
        BOOT_CHAT_TIMEOUT_MS: maxTimeoutMs
      }
    : config;
}

function resolveApiKey(value: string | undefined, purpose: "chat" | "embedding" | "image") {
  if (value) {
    return value;
  }

  throw new BootProviderError(`BOOT_${purpose.toUpperCase()}_API_KEY or BOOT_API_KEY is required`, 503);
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

  const exposedStatusCode = statusCode === 401 || statusCode === 403 ? 502 : statusCode;
  return new BootProviderError(`AI relay failed with HTTP ${statusCode}: ${message}`, exposedStatusCode);
}

function joinUrl(baseUrl: string, path: string) {
  return new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

export async function listChatModels(config = getBootConfig()): Promise<ChatModelListResponse> {
  const source = joinUrl(config.BOOT_CHAT_BASE_URL ?? config.BOOT_BASE_URL, "/models");
  const response = await fetchProvider(
    source,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${resolveApiKey(config.BOOT_CHAT_API_KEY ?? config.BOOT_API_KEY, "chat")}`,
        accept: "application/json"
      }
    },
    config.BOOT_CHAT_TIMEOUT_MS,
    "AI relay models"
  );

  const body = await readProviderText(response, config.BOOT_CHAT_TIMEOUT_MS, "AI relay models");
  if (!response.ok) {
    throw chatProviderError(response.status, body);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new BootProviderError(`AI relay returned an invalid models response: ${body.slice(0, 160)}`);
  }

  const parsed = providerModelListResponseSchema.parse(payload);
  const models = parsed.data
    .filter((model) => isLikelyChatModelId(model.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    currentModel: config.BOOT_CHAT_MODEL,
    models,
    source: source.toString()
  };
}

export function isLikelyChatModelId(modelId: string) {
  const normalized = modelId.toLowerCase();
  if (normalized === fixedBootEmbeddingModel || normalized === fixedBootImageModel) {
    return false;
  }

  return ![
    "embedding",
    "text-embedding",
    "image",
    "gpt-image",
    "dall-e",
    "whisper",
    "tts",
    "moderation",
    "rerank"
  ].some((marker) => normalized.includes(marker));
}

export async function probeChatModel(modelId: string, config = getBootConfig()) {
  const candidateConfig = {
    ...config,
    BOOT_CHAT_MODEL: modelId
  };
  await generateStreamedText({
    config: candidateConfig,
    system: "You are a health probe. Reply with exactly OK.",
    prompt: "OK"
  });
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

export async function planMakotoToolUse(input: {
  content: string;
  history?: ChatHistoryItem[];
  config?: BootConfig;
}): Promise<BootToolDecision> {
  const config = withMaxChatTimeout(input.config ?? getBootConfig(), 15_000);
  try {
    const historyText = (input.history ?? [])
      .slice(-6)
      .map((item) => `${item.role}: ${item.content}`)
      .join("\n");
    const text = await generateStreamedText({
      config,
      system: "你是雷电真对话链路的工具规划器。只输出一个 JSON 对象，不要输出 Markdown、解释或代码块。",
      prompt: `请判断本轮是否需要调用工具。

可选 action：
- "none"：普通对话、闲聊、解释、写作、记忆相关表达，不需要外部工具。
- "web_search"：用户要求查询、搜索、联网、来源、链接、最新/今天/现在/新闻/价格/版本/事实核验，或问题明显依赖实时信息。
- "makoto_image"：用户要求画图、生图、生成图片、头像、壁纸、插画、视觉画面。

输出 JSON 结构：
{"action":"none|web_search|makoto_image","reason":"一句中文原因","query":"搜索词或 null","prompt":"生图意图或 null"}

约束：
- action 为 web_search 时，query 必须是适合搜索的一句话。
- action 为 makoto_image 时，prompt 必须保留用户想要的画面主体、风格和限制。
- 不要因为普通聊天主动搜索；不要因为用户要求写文字而生图。

近期对话：
${historyText || "暂无。"}

用户消息：
${input.content}`
    });
    const parsed = parseToolDecision(text);
    if (isPlannerFormatFallbackReason(parsed.reason)) {
      const deterministic = deterministicToolDecisionFallback(input.content, parsed.reason);
      if (deterministic) {
        return deterministic;
      }
    }

    return normalizeToolDecision(parsed, input.content);
  } catch {
    return deterministicToolDecisionFallback(input.content, "工具规划失败，使用确定性意图兜底。") ?? {
      action: "none",
      reason: "工具规划失败，回退为普通对话。",
      query: null,
      prompt: null
    };
  }
}

export async function generateMakotoImagePrompt(input: {
  userPrompt: string;
  userName?: string | null;
  history?: ChatHistoryItem[];
  config?: BootConfig;
}) {
  const config = withMaxChatTimeout(input.config ?? getBootConfig(), 20_000);
  const historyText = (input.history ?? [])
    .slice(-6)
    .map((item) => `${item.role}: ${item.content}`)
    .join("\n");
  const prompt = await generateStreamedText({
    config,
    system:
      "你是图像提示词生成器。将用户意图改写成可直接用于图像生成模型的高质量提示词。只输出提示词正文，不要 Markdown。",
    prompt: `角色基调：雷电真，温柔、优雅、稻妻、樱花、柔和雷光、人情味。不要生成文字、logo、水印、UI、官方截图。

用户：${input.userName ?? "旅行者"}
近期对话：
${historyText || "暂无。"}

用户画面需求：
${input.userPrompt}

请输出不超过 900 字符的提示词，保留用户指定主体；必要时补充构图、光线、氛围和细节。`
  });

  return prompt.slice(0, 900).trim() || input.userPrompt;
}

function parseToolDecision(text: string): BootToolDecision {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const jsonText = fenced ?? trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    return {
      action: "none",
      reason: "工具规划返回格式不可解析。",
      query: null,
      prompt: null
    } satisfies BootToolDecision;
  }

  const parsed = bootToolDecisionSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      action: "none",
      reason: "工具规划返回字段不完整。",
      query: null,
      prompt: null
    } satisfies BootToolDecision;
  }

  return parsed.data;
}

function normalizeToolDecision(decision: BootToolDecision, content: string): BootToolDecision {
  if (decision.action === "web_search") {
    return {
      ...decision,
      query: decision.query?.trim() || content.slice(0, 500),
      prompt: null
    };
  }

  if (decision.action === "makoto_image") {
    return {
      ...decision,
      query: null,
      prompt: decision.prompt?.trim() || content.slice(0, 2000)
    };
  }

  const explicitFallback = deterministicToolDecisionFallback(content, "用户表达包含明确工具意图，覆盖规划器 none 判断。", "strict");
  if (explicitFallback) {
    return explicitFallback;
  }

  return {
    action: "none",
    reason: decision.reason,
    query: null,
    prompt: null
  };
}

function isPlannerFormatFallbackReason(reason: string) {
  return reason === "工具规划返回格式不可解析。" || reason === "工具规划返回字段不完整。";
}

function deterministicToolDecisionFallback(
  content: string,
  reason: string,
  mode: "broad" | "strict" = "broad"
): BootToolDecision | null {
  const shouldImage = mode === "strict" ? shouldUseExplicitMakotoImageForMessage(content) : shouldUseMakotoImageForMessage(content);
  if (shouldImage) {
    return {
      action: "makoto_image",
      reason,
      query: null,
      prompt: content.slice(0, 2000)
    };
  }

  const shouldSearch = mode === "strict" ? shouldUseExplicitBootSearchForMessage(content) : shouldUseBootSearchForMessage(content);
  if (shouldSearch) {
    return {
      action: "web_search",
      reason,
      query: content.slice(0, 500),
      prompt: null
    };
  }

  return null;
}

export function shouldUseExplicitMakotoImageForMessage(content: string) {
  return /(画图|生图|出图|绘制|生成(一张|图片|图像|头像|壁纸|插画)|做(一张|个)?(头像|壁纸|插画)|draw\s+(an?\s+)?image|image\s*gen|generate\s+(an?\s+)?image|illustrat(e|ion))/i.test(
    content
  );
}

function shouldUseMakotoImageForMessage(content: string) {
  return shouldUseExplicitMakotoImageForMessage(content);
}

function shouldUseExplicitBootSearchForMessage(content: string) {
  return /(联网|搜索|搜一下|查一下|帮我查|查找|资料来源|来源|链接|最新|新闻|当前|现在的|目前的|今天.*(新闻|消息|价格|进展|版本)|事实核验|核实|google|谷歌|web\s*search|search\s+the\s+web|look\s+up)/i.test(
    content
  );
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
