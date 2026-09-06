import { createHash } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { embed, generateImage } from "ai";
import { z } from "zod";
import { errorMessage, isAbortError, timeoutSignal } from "./fetch-timeout.js";
import {
  getModelConfiguration,
  modelAllowedByConfiguration,
  modelCapabilities,
  modelSelectableByUser,
  type ModelConfiguration
} from "./model-config.js";
import { buildMemoryContext } from "./persona.js";
import { getRaidenMakotoPersona } from "./persona-runtime.js";
import {
  bootToolDecisionSchema,
  generatedImageSchema,
  providerModelListResponseSchema,
  type BootToolDecision,
  type ChatModelListResponse,
  type WebSearchResponse
} from "./schemas.js";
import { formatWebSearchResultsForPrompt, shouldUseBootSearchForMessage } from "./tools.js";

const optionalString = z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());
const optionalUrl = z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional());
const timeoutMs = z.coerce.number().int().min(1_000).max(600_000);

const bootEnvSchema = z.object({
  BOOT_BASE_URL: optionalUrl,
  BOOT_CHAT_BASE_URL: optionalUrl,
  BOOT_EMBEDDING_BASE_URL: optionalUrl,
  BOOT_API_KEY: optionalString,
  BOOT_CHAT_API_KEY: optionalString,
  BOOT_EMBEDDING_API_KEY: optionalString,
  BOOT_IMAGE_API_KEY: optionalString,
  BOOT_CHAT_MODEL: optionalString,
  BOOT_SUMMARY_MODEL: optionalString,
  BOOT_MEMORY_MODEL: optionalString,
  BOOT_TOOL_MODEL: optionalString,
  BOOT_EMBEDDING_MODEL: optionalString,
  BOOT_EMBEDDING_DIMENSIONS: z.coerce
    .number()
    .int()
    .refine((value) => value === 512, "BOOT_EMBEDDING_DIMENSIONS must remain 512 for the local memory schema")
    .optional(),
  BOOT_IMAGE_BASE_URL: optionalUrl,
  BOOT_IMAGE_MODEL: optionalString,
  BOOT_CHAT_TIMEOUT_MS: timeoutMs.default(90_000),
  BOOT_EMBEDDING_TIMEOUT_MS: timeoutMs.default(30_000),
  BOOT_IMAGE_TIMEOUT_MS: timeoutMs.default(180_000)
});

export type BootConfig = {
  BOOT_BASE_URL: string;
  BOOT_CHAT_BASE_URL?: string | undefined;
  BOOT_EMBEDDING_BASE_URL: string;
  BOOT_IMAGE_BASE_URL?: string | undefined;
  BOOT_API_KEY?: string | undefined;
  BOOT_CHAT_API_KEY?: string | undefined;
  BOOT_EMBEDDING_API_KEY?: string | undefined;
  BOOT_IMAGE_API_KEY?: string | undefined;
  BOOT_CHAT_MODEL: string;
  BOOT_SUMMARY_MODEL: string;
  BOOT_MEMORY_MODEL: string;
  BOOT_TOOL_MODEL: string;
  BOOT_EMBEDDING_MODEL: string;
  BOOT_EMBEDDING_DIMENSIONS: 512;
  BOOT_EMBEDDING_QUERY_PREFIX: string;
  BOOT_IMAGE_MODEL: string;
  BOOT_CHAT_TIMEOUT_MS: number;
  BOOT_EMBEDDING_TIMEOUT_MS: number;
  BOOT_IMAGE_TIMEOUT_MS: number;
  BOOT_CHAT_ENDPOINT: string;
  BOOT_RESPONSES_ENDPOINT: string;
  BOOT_CHAT_STREAM_REQUIRED: boolean;
  BOOT_CATALOG_ENDPOINT: string;
  BOOT_CATALOG_REFRESH_SECONDS: number;
  BOOT_CATALOG_STALE_AFTER_SECONDS: number;
  BOOT_IMAGE_CATALOG_ENDPOINT: string;
  BOOT_IMAGE_CATALOG_REFRESH_SECONDS: number;
  BOOT_IMAGE_CATALOG_STALE_AFTER_SECONDS: number;
  MODEL_CONFIGURATION: ModelConfiguration;
  PERSONA_ID: string;
  PERSONA_VERSION: number;
  PERSONA_HASH: string;
  PERSONA_SYSTEM_PROMPT: string;
};

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
  const parsed = bootEnvSchema.parse(env);
  const modelConfiguration = getModelConfiguration(env);
  const languageProvider = modelConfiguration.providers[modelConfiguration.routing.language.provider];
  const imageProvider = modelConfiguration.providers[modelConfiguration.routing.image.provider];
  if (!languageProvider || !imageProvider) {
    throw new Error("Model configuration references a missing provider");
  }
  const persona = getRaidenMakotoPersona(env);
  const baseUrl =
    parsed.BOOT_BASE_URL ?? (env[languageProvider.baseUrlEnv]?.trim() || "https://proxy.xhblog.top/v1");
  const chatBaseUrl = (parsed.BOOT_CHAT_BASE_URL ?? env[languageProvider.chatBaseUrlEnv]?.trim()) || undefined;
  const configuredImageProviderBaseUrl = env[imageProvider.baseUrlEnv]?.trim();
  const imageBaseUrl =
    (parsed.BOOT_IMAGE_BASE_URL ??
      env[imageProvider.imageBaseUrlEnv]?.trim() ??
      (imageProvider === languageProvider ? undefined : configuredImageProviderBaseUrl)) ||
    undefined;
  const imageModel = parsed.BOOT_IMAGE_MODEL ?? modelConfiguration.routing.image.default;
  if (
    !modelAllowedByConfiguration(modelConfiguration, imageModel) ||
    !modelSelectableByUser(modelConfiguration, imageModel, "image") ||
    !modelCapabilities(modelConfiguration, imageModel).includes("image")
  ) {
    throw new Error(`BOOT_IMAGE_MODEL "${imageModel}" is not allowed by the image routing configuration`);
  }
  return {
    BOOT_BASE_URL: baseUrl,
    BOOT_CHAT_BASE_URL: chatBaseUrl,
    BOOT_IMAGE_BASE_URL: imageBaseUrl,
    BOOT_EMBEDDING_BASE_URL:
      parsed.BOOT_EMBEDDING_BASE_URL ??
      (env[modelConfiguration.embedding.baseUrlEnv]?.trim() || modelConfiguration.embedding.baseUrl),
    BOOT_API_KEY: (parsed.BOOT_API_KEY ?? env[languageProvider.apiKeyEnv]?.trim()) || undefined,
    BOOT_CHAT_API_KEY: (parsed.BOOT_CHAT_API_KEY ?? env[languageProvider.chatApiKeyEnv]?.trim()) || undefined,
    BOOT_IMAGE_API_KEY:
      (parsed.BOOT_IMAGE_API_KEY ??
        env[imageProvider.imageApiKeyEnv]?.trim() ??
        (imageProvider === languageProvider ? undefined : env[imageProvider.apiKeyEnv]?.trim())) ||
      undefined,
    BOOT_EMBEDDING_API_KEY:
      (parsed.BOOT_EMBEDDING_API_KEY ?? env[modelConfiguration.embedding.apiKeyEnv]?.trim()) || undefined,
    BOOT_CHAT_MODEL: parsed.BOOT_CHAT_MODEL ?? modelConfiguration.routing.language.defaults.conversation,
    BOOT_SUMMARY_MODEL: parsed.BOOT_SUMMARY_MODEL ?? modelConfiguration.routing.language.defaults.summarization,
    BOOT_MEMORY_MODEL: parsed.BOOT_MEMORY_MODEL ?? modelConfiguration.routing.language.defaults.memoryExtraction,
    BOOT_TOOL_MODEL: parsed.BOOT_TOOL_MODEL ?? modelConfiguration.routing.language.defaults.toolReasoning,
    BOOT_EMBEDDING_MODEL: parsed.BOOT_EMBEDDING_MODEL ?? modelConfiguration.embedding.model,
    BOOT_EMBEDDING_DIMENSIONS: modelConfiguration.embedding.dimensions,
    BOOT_EMBEDDING_QUERY_PREFIX: modelConfiguration.embedding.queryPrefix,
    BOOT_IMAGE_MODEL: imageModel,
    BOOT_CHAT_TIMEOUT_MS: parsed.BOOT_CHAT_TIMEOUT_MS,
    BOOT_EMBEDDING_TIMEOUT_MS: parsed.BOOT_EMBEDDING_TIMEOUT_MS,
    BOOT_IMAGE_TIMEOUT_MS: parsed.BOOT_IMAGE_TIMEOUT_MS,
    BOOT_CHAT_ENDPOINT: languageProvider.protocol.chatEndpoint,
    BOOT_RESPONSES_ENDPOINT: languageProvider.protocol.responsesEndpoint,
    BOOT_CHAT_STREAM_REQUIRED: languageProvider.protocol.streamRequired,
    BOOT_CATALOG_ENDPOINT: languageProvider.catalog.endpoint,
    BOOT_CATALOG_REFRESH_SECONDS: languageProvider.catalog.refreshSeconds,
    BOOT_CATALOG_STALE_AFTER_SECONDS: languageProvider.catalog.staleAfterSeconds,
    BOOT_IMAGE_CATALOG_ENDPOINT: imageProvider.catalog.endpoint,
    BOOT_IMAGE_CATALOG_REFRESH_SECONDS: imageProvider.catalog.refreshSeconds,
    BOOT_IMAGE_CATALOG_STALE_AFTER_SECONDS: imageProvider.catalog.staleAfterSeconds,
    MODEL_CONFIGURATION: modelConfiguration,
    PERSONA_ID: persona.id,
    PERSONA_VERSION: persona.version,
    PERSONA_HASH: persona.hash,
    PERSONA_SYSTEM_PROMPT: persona.systemPrompt
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
    apiKey: config.BOOT_EMBEDDING_API_KEY ?? "local-embedding-only",
    baseURL: config.BOOT_EMBEDDING_BASE_URL
  });
}

function createImageProvider(config = getBootConfig()) {
  return createOpenAI({
    apiKey: resolveApiKey(config.BOOT_IMAGE_API_KEY ?? config.BOOT_API_KEY, "image"),
    baseURL: config.BOOT_IMAGE_BASE_URL ?? config.BOOT_BASE_URL
  });
}

async function generateStreamedText(input: {
  system: string;
  prompt: string;
  config: BootConfig;
  model?: string;
  abortSignal?: AbortSignal;
  allowConfiguredFallbacks?: boolean;
}) {
  const primaryModel = input.model ?? input.config.BOOT_CHAT_MODEL;
  const models = [
    primaryModel,
    ...(input.allowConfiguredFallbacks === false ? [] : input.config.MODEL_CONFIGURATION.routing.language.fallbacks)
  ].filter((model, index, candidates) => model && candidates.indexOf(model) === index);
  let lastError: unknown;

  for (const model of models) {
    let chatError: unknown;
    try {
      return await generateChatCompletionsText({ ...input, model });
    } catch (error) {
      if (isCancelledProviderError(error, input.abortSignal)) {
        throw error;
      }
      chatError = error;
    }

    if (!shouldTryResponsesProtocol(chatError)) {
      lastError = chatError;
      continue;
    }

    try {
      return await generateResponsesText({ ...input, model });
    } catch (responsesError) {
      if (isCancelledProviderError(responsesError, input.abortSignal)) {
        throw responsesError;
      }
      lastError = combineProtocolErrors(model, chatError, responsesError);
    }
  }

  throw lastError ?? new BootProviderError("No language model was available.");
}

function shouldTryResponsesProtocol(error: unknown) {
  if (!(error instanceof BootProviderError)) {
    return true;
  }
  if ([400, 404, 405, 415, 422, 501].includes(error.statusCode)) {
    return true;
  }
  return /invalid|empty|readable chat stream/i.test(error.message) && !/HTTP (?:401|403|429|5\d\d)/i.test(error.message);
}

function combineProtocolErrors(model: string, chatError: unknown, responsesError: unknown) {
  if (chatError instanceof BootProviderError && responsesError instanceof BootProviderError) {
    return new BootProviderError(
      `Model "${model}" failed on Chat Completions: ${chatError.message}; Responses fallback failed: ${responsesError.message}`,
      responsesError.statusCode
    );
  }
  return responsesError;
}

function isCancelledProviderError(error: unknown, abortSignal?: AbortSignal) {
  return abortSignal?.aborted || (error instanceof BootProviderError && error.statusCode === 499);
}

async function generateChatCompletionsText(input: {
  system: string;
  prompt: string;
  config: BootConfig;
  model?: string;
  abortSignal?: AbortSignal;
}) {
  const response = await fetchProvider(
    joinUrl(input.config.BOOT_CHAT_BASE_URL ?? input.config.BOOT_BASE_URL, input.config.BOOT_CHAT_ENDPOINT),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveApiKey(input.config.BOOT_CHAT_API_KEY ?? input.config.BOOT_API_KEY, "chat")}`,
        "content-type": "application/json",
        accept: input.config.BOOT_CHAT_STREAM_REQUIRED ? "text/event-stream" : "application/json"
      },
      body: JSON.stringify({
        model: input.model ?? input.config.BOOT_CHAT_MODEL,
        stream: input.config.BOOT_CHAT_STREAM_REQUIRED,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt }
        ]
      })
    },
    input.config.BOOT_CHAT_TIMEOUT_MS,
    "AI relay chat completions",
    input.abortSignal
  );

  if (!response.ok) {
    throw chatProviderError(
      response.status,
      await readProviderText(response, input.config.BOOT_CHAT_TIMEOUT_MS, "AI relay chat completions", input.abortSignal)
    );
  }

  if (input.config.BOOT_CHAT_STREAM_REQUIRED) {
    return readProviderStream(
      response,
      parseChatStreamEvent,
      input.config.BOOT_CHAT_TIMEOUT_MS,
      "AI relay chat completions",
      input.abortSignal
    );
  }
  return parseChatCompletionResponse(
    await readProviderText(response, input.config.BOOT_CHAT_TIMEOUT_MS, "AI relay chat completions", input.abortSignal)
  );
}

async function generateResponsesText(input: {
  system: string;
  prompt: string;
  config: BootConfig;
  model?: string;
  abortSignal?: AbortSignal;
}) {
  const response = await fetchProvider(
    joinUrl(input.config.BOOT_CHAT_BASE_URL ?? input.config.BOOT_BASE_URL, input.config.BOOT_RESPONSES_ENDPOINT),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveApiKey(input.config.BOOT_CHAT_API_KEY ?? input.config.BOOT_API_KEY, "chat")}`,
        "content-type": "application/json",
        accept: input.config.BOOT_CHAT_STREAM_REQUIRED ? "text/event-stream" : "application/json"
      },
      body: JSON.stringify({
        model: input.model ?? input.config.BOOT_CHAT_MODEL,
        stream: input.config.BOOT_CHAT_STREAM_REQUIRED,
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
    "AI relay Responses",
    input.abortSignal
  );

  if (!response.ok) {
    throw chatProviderError(
      response.status,
      await readProviderText(response, input.config.BOOT_CHAT_TIMEOUT_MS, "AI relay Responses", input.abortSignal)
    );
  }

  if (input.config.BOOT_CHAT_STREAM_REQUIRED) {
    return readProviderStream(
      response,
      parseResponsesStreamEvent,
      input.config.BOOT_CHAT_TIMEOUT_MS,
      "AI relay Responses",
      input.abortSignal
    );
  }
  return parseResponsesResponse(
    await readProviderText(response, input.config.BOOT_CHAT_TIMEOUT_MS, "AI relay Responses", input.abortSignal)
  );
}

async function fetchProvider(
  url: URL,
  init: RequestInit,
  timeoutMsValue: number,
  source: string,
  abortSignal?: AbortSignal
) {
  try {
    return await fetch(url, {
      ...init,
      signal: abortSignal ? AbortSignal.any([abortSignal, timeoutSignal(timeoutMsValue)]) : timeoutSignal(timeoutMsValue)
    });
  } catch (error) {
    if (isAbortError(error)) {
      if (abortSignal?.aborted) {
        throw new BootProviderError(`${source} was cancelled.`, 499);
      }
      throw new BootProviderError(`${source} timed out after ${timeoutMsValue}ms.`, 504);
    }
    throw new BootProviderError(`${source} request failed: ${errorMessage(error)}`, 502);
  }
}

async function readProviderStream(
  response: Response,
  parseEvent: (event: string) => string,
  timeoutMsValue: number,
  source: string,
  abortSignal?: AbortSignal
) {
  try {
    return await readStreamedText(response, parseEvent);
  } catch (error) {
    if (isAbortError(error)) {
      if (abortSignal?.aborted) {
        throw new BootProviderError(`${source} was cancelled.`, 499);
      }
      throw new BootProviderError(`${source} stream timed out after ${timeoutMsValue}ms.`, 504);
    }
    throw error;
  }
}

async function readProviderText(response: Response, timeoutMsValue: number, source: string, abortSignal?: AbortSignal) {
  try {
    return await response.text();
  } catch (error) {
    if (isAbortError(error)) {
      if (abortSignal?.aborted) {
        throw new BootProviderError(`${source} was cancelled.`, 499);
      }
      throw new BootProviderError(`${source} response body timed out after ${timeoutMsValue}ms.`, 504);
    }
    throw new BootProviderError(`${source} response body failed: ${errorMessage(error)}`, 502);
  }
}

function parseChatCompletionResponse(body: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new BootProviderError("AI relay returned an invalid Chat Completions response.");
  }
  const content =
    payload && typeof payload === "object"
      ? (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
      : undefined;
  if (typeof content !== "string" || !content.trim()) {
    throw new BootProviderError("AI relay returned an empty Chat Completions response.");
  }
  return content.trim();
}

function parseResponsesResponse(body: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new BootProviderError("AI relay returned an invalid Responses response.");
  }
  if (!payload || typeof payload !== "object") {
    throw new BootProviderError("AI relay returned an empty Responses response.");
  }
  const response = payload as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }>;
  };
  const outputText =
    typeof response.output_text === "string"
      ? response.output_text
      : response.output
          ?.flatMap((item) => item.content ?? [])
          .filter((item) => item.type === "output_text" && typeof item.text === "string")
          .map((item) => item.text)
          .join("");
  if (!outputText?.trim()) {
    throw new BootProviderError("AI relay returned an empty Responses response.");
  }
  return outputText.trim();
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

type ProviderModels = z.infer<typeof providerModelListResponseSchema>["data"];
type ModelCatalogCache = { models: ProviderModels; fetchedAt: number };
type ModelCatalogResult = {
  models: ProviderModels;
  source: URL;
  fetchedAt: number;
  cacheStatus: "live" | "fresh_cache" | "stale_cache";
};

const modelCatalogCache = new Map<string, ModelCatalogCache>();
const modelCatalogRequests = new Map<string, Promise<ModelCatalogResult>>();
const successfulChatProbes = new Map<string, number>();

async function listProviderModels(config: BootConfig, capability: "chat" | "image", forceRefresh = false) {
  const imageCatalog = capability === "image";
  const source = joinUrl(
    imageCatalog ? (config.BOOT_IMAGE_BASE_URL ?? config.BOOT_BASE_URL) : (config.BOOT_CHAT_BASE_URL ?? config.BOOT_BASE_URL),
    imageCatalog ? config.BOOT_IMAGE_CATALOG_ENDPOINT : config.BOOT_CATALOG_ENDPOINT
  );
  const apiKey = resolveApiKey(
    imageCatalog
      ? (config.BOOT_IMAGE_API_KEY ?? config.BOOT_API_KEY)
      : (config.BOOT_CHAT_API_KEY ?? config.BOOT_API_KEY),
    imageCatalog ? "image" : "chat"
  );
  const refreshSeconds = imageCatalog
    ? config.BOOT_IMAGE_CATALOG_REFRESH_SECONDS
    : config.BOOT_CATALOG_REFRESH_SECONDS;
  const staleAfterSeconds = imageCatalog
    ? config.BOOT_IMAGE_CATALOG_STALE_AFTER_SECONDS
    : config.BOOT_CATALOG_STALE_AFTER_SECONDS;
  const sourceLabel = imageCatalog ? "AI relay image models" : "AI relay chat models";
  const cacheKey = createHash("sha256").update(`${source}\0${apiKey}`).digest("hex");
  const cached = modelCatalogCache.get(cacheKey);
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.fetchedAt < refreshSeconds * 1_000) {
    return { models: cached.models, source, fetchedAt: cached.fetchedAt, cacheStatus: "fresh_cache" as const };
  }

  const pending = modelCatalogRequests.get(cacheKey);
  if (pending) {
    return pending;
  }

  const request = (async (): Promise<ModelCatalogResult> => {
    try {
      const response = await fetchProvider(
        source,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${apiKey}`,
            accept: "application/json"
          }
        },
        config.BOOT_CHAT_TIMEOUT_MS,
        sourceLabel
      );
      const body = await readProviderText(response, config.BOOT_CHAT_TIMEOUT_MS, sourceLabel);
      if (!response.ok) {
        throw chatProviderError(response.status, body);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new BootProviderError("AI relay returned an invalid models response");
      }
      const models = providerModelListResponseSchema.parse(payload).data.sort((left, right) =>
        left.id.localeCompare(right.id)
      );
      const fetchedAt = Date.now();
      modelCatalogCache.set(cacheKey, { models, fetchedAt });
      pruneModelCatalogCache(cacheKey);
      return { models, source, fetchedAt, cacheStatus: "live" };
    } catch (error) {
      if (cached && now - cached.fetchedAt <= staleAfterSeconds * 1_000) {
        return {
          models: cached.models,
          source,
          fetchedAt: cached.fetchedAt,
          cacheStatus: "stale_cache"
        };
      }
      throw error;
    } finally {
      modelCatalogRequests.delete(cacheKey);
    }
  })();
  modelCatalogRequests.set(cacheKey, request);
  return request;
}

function pruneModelCatalogCache(currentKey: string) {
  for (const key of modelCatalogCache.keys()) {
    if (modelCatalogCache.size <= 20) {
      return;
    }
    if (key !== currentKey) {
      modelCatalogCache.delete(key);
    }
  }
}

export function clearProviderModelCatalogCache() {
  modelCatalogCache.clear();
  modelCatalogRequests.clear();
  successfulChatProbes.clear();
}

export async function listChatModels(config = getBootConfig(), forceRefresh = false): Promise<ChatModelListResponse> {
  const catalog = await listProviderModels(config, "chat", forceRefresh);
  const models = catalog.models.filter((model) => isLikelyChatModelId(model.id, config));
  return {
    currentModel: config.BOOT_CHAT_MODEL,
    models,
    source: catalog.source.toString(),
    capability: "chat",
    fetchedAt: new Date(catalog.fetchedAt).toISOString(),
    cacheStatus: catalog.cacheStatus
  };
}

export async function listImageModels(config = getBootConfig(), forceRefresh = false): Promise<ChatModelListResponse> {
  const catalog = await listProviderModels(config, "image", forceRefresh);
  return {
    currentModel: config.BOOT_IMAGE_MODEL,
    models: catalog.models.filter((model) => isLikelyImageModelId(model.id, config)),
    source: catalog.source.toString(),
    capability: "image",
    fetchedAt: new Date(catalog.fetchedAt).toISOString(),
    cacheStatus: catalog.cacheStatus
  };
}

export function isLikelyChatModelId(modelId: string, config = getBootConfig()) {
  return (
    modelAllowedByConfiguration(config.MODEL_CONFIGURATION, modelId) &&
    modelSelectableByUser(config.MODEL_CONFIGURATION, modelId, "chat") &&
    modelCapabilities(config.MODEL_CONFIGURATION, modelId).includes("chat")
  );
}

export function isLikelyImageModelId(modelId: string, config = getBootConfig()) {
  return (
    modelAllowedByConfiguration(config.MODEL_CONFIGURATION, modelId) &&
    modelSelectableByUser(config.MODEL_CONFIGURATION, modelId, "image") &&
    modelCapabilities(config.MODEL_CONFIGURATION, modelId).includes("image")
  );
}

export async function probeChatModel(modelId: string, config = getBootConfig()) {
  if (!config.MODEL_CONFIGURATION.probes.beforePublish) {
    return;
  }
  const now = Date.now();
  const maxAgeMs = config.MODEL_CONFIGURATION.probes.cacheSeconds * 1_000;
  const cacheKey = chatProbeCacheKey(modelId, config);
  const lastSuccess = successfulChatProbes.get(cacheKey);
  if (lastSuccess !== undefined && now - lastSuccess < maxAgeMs) {
    return;
  }
  const candidateConfig = {
    ...config,
    BOOT_CHAT_MODEL: modelId
  };
  await generateStreamedText({
    config: candidateConfig,
    model: modelId,
    allowConfiguredFallbacks: false,
    system: "You are a health probe. Reply with exactly OK.",
    prompt: config.MODEL_CONFIGURATION.probes.chatPrompt
  });
  successfulChatProbes.set(cacheKey, now);
  pruneChatProbeCache(now, maxAgeMs);
}

function chatProbeCacheKey(modelId: string, config: BootConfig) {
  return createHash("sha256")
    .update(
      [
        modelId,
        config.BOOT_CHAT_BASE_URL ?? config.BOOT_BASE_URL,
        config.BOOT_CHAT_ENDPOINT,
        config.BOOT_RESPONSES_ENDPOINT,
        String(config.BOOT_CHAT_STREAM_REQUIRED),
        config.BOOT_CHAT_API_KEY ?? config.BOOT_API_KEY ?? "",
        config.MODEL_CONFIGURATION.probes.chatPrompt
      ].join("\0")
    )
    .digest("hex");
}

function pruneChatProbeCache(now: number, maxAgeMs: number) {
  for (const [key, successfulAt] of successfulChatProbes) {
    if (successfulChatProbes.size <= 200 && now - successfulAt < maxAgeMs) {
      continue;
    }
    successfulChatProbes.delete(key);
  }
}

async function embedLocalText(
  value: string,
  inputType: "query" | "document",
  config = getBootConfig(),
  abortSignal?: AbortSignal
): Promise<number[]> {
  const provider = createEmbeddingProvider(config);
  let result: Awaited<ReturnType<typeof embed>>;
  try {
    result = await embed({
      model: provider.embedding(config.BOOT_EMBEDDING_MODEL),
      value: inputType === "query" ? `${config.BOOT_EMBEDDING_QUERY_PREFIX}${value}` : value,
      abortSignal: abortSignal
        ? AbortSignal.any([abortSignal, timeoutSignal(config.BOOT_EMBEDDING_TIMEOUT_MS)])
        : timeoutSignal(config.BOOT_EMBEDDING_TIMEOUT_MS)
    });
  } catch (error) {
    if (isAbortError(error)) {
      if (abortSignal?.aborted) {
        throw new BootProviderError("Local embedding was cancelled.", 499);
      }
      throw new BootProviderError(`Local embedding timed out after ${config.BOOT_EMBEDDING_TIMEOUT_MS}ms.`, 504);
    }
    throw new BootProviderError(`Local embedding failed: ${errorMessage(error)}`, 502);
  }

  if (result.embedding.length !== config.BOOT_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `BOOT_EMBEDDING_MODEL must return ${config.BOOT_EMBEDDING_DIMENSIONS} dimensions; received ${result.embedding.length}`
    );
  }

  return result.embedding;
}

export function embedQuery(value: string, config = getBootConfig(), abortSignal?: AbortSignal) {
  return embedLocalText(value, "query", config, abortSignal);
}

export function embedDocument(value: string, config = getBootConfig(), abortSignal?: AbortSignal) {
  return embedLocalText(value, "document", config, abortSignal);
}

/** @deprecated Use embedQuery or embedDocument so BGE receives the correct retrieval prefix. */
export function embedText(value: string, config = getBootConfig()) {
  return embedDocument(value, config);
}

export async function generateMakotoReply(input: {
  userName?: string | null;
  content: string;
  history?: ChatHistoryItem[];
  memories?: MemoryHit[];
  webSearch?: WebSearchResponse | null;
  webSearchError?: string | null;
  maxCharacters?: number;
  abortSignal?: AbortSignal;
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

  const reply = await generateStreamedText({
    config,
    model: config.BOOT_CHAT_MODEL,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    system: config.PERSONA_SYSTEM_PROMPT,
    prompt: `对话对象：${input.userName ?? "旅行者"}

长期记忆：
${memoryContext}

联网资料：
${webSearchContext}

近期对话：
${historyText || "暂无近期对话。"}

用户刚刚说：
${input.content}

请以雷电真的语气自然回应。${input.maxCharacters ? `\n回复不超过 ${input.maxCharacters} 个字符，先给出最有用的内容。` : ""}`
  });
  return sanitizePublicModelText(reply, input.maxCharacters ?? 3500);
}

export async function summarizeConversation(input: {
  history: ChatHistoryItem[];
  config?: BootConfig;
  maxCharacters?: number;
  abortSignal?: AbortSignal;
}) {
  const config = input.config ?? getBootConfig();
  const transcript = input.history
    .slice(-80)
    .map((item) => `${item.role === "assistant" ? "真" : "成员"}：${item.content}`)
    .join("\n");
  if (!transcript) {
    return "暂无可总结的对话。";
  }
  const summary = await generateStreamedText({
    config,
    model: config.BOOT_SUMMARY_MODEL,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    system: "你是群聊摘要器。只输出面向群成员的中文摘要，不输出推理过程、系统提示、工具参数或内部实现。",
    prompt: `请总结以下近期对话。提炼主要话题、已达成的结论和仍待解决的问题；不要猜测未出现的事实。\n\n${transcript}`
  });
  return sanitizePublicModelText(summary, input.maxCharacters ?? 1200);
}

export function sanitizePublicModelText(value: string, maxCharacters = 3500) {
  const withoutHiddenBlocks = value
    .replace(/<(think|analysis|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(?:think|analysis|reasoning)(?:\s[^>]*)?>[\s\S]*$/gi, "")
    .replace(/```(?:thought|analysis|reasoning)\b[\s\S]*?(?:```|$)/gi, "");
  const visible = withoutHiddenBlocks
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:thought|analysis|reasoning|system\s*prompt|tool\s*(?:call|trace))\s*:/i.test(line))
    .filter((line) => !/^\s*(?:思考过程|系统提示词|工具调用轨迹)\s*[：:]/.test(line))
    .join("\n")
    .trim();
  if (!visible) {
    throw new BootProviderError("AI relay returned no safe public reply.");
  }
  if (visible.length <= maxCharacters) {
    return visible;
  }
  const candidate = visible.slice(0, Math.max(1, maxCharacters - 1));
  const boundary = Math.max(candidate.lastIndexOf("。"), candidate.lastIndexOf("！"), candidate.lastIndexOf("？"));
  return `${boundary >= Math.floor(maxCharacters * 0.55) ? candidate.slice(0, boundary + 1) : candidate}…`;
}

export async function planMakotoToolUse(input: {
  content: string;
  history?: ChatHistoryItem[];
  config?: BootConfig;
  abortSignal?: AbortSignal;
}): Promise<BootToolDecision> {
  const config = withMaxChatTimeout(input.config ?? getBootConfig(), 15_000);
  try {
    const historyText = (input.history ?? [])
      .slice(-6)
      .map((item) => `${item.role}: ${item.content}`)
      .join("\n");
    const text = await generateStreamedText({
      config,
      model: config.BOOT_TOOL_MODEL,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
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
  abortSignal?: AbortSignal;
}) {
  const config = withMaxChatTimeout(input.config ?? getBootConfig(), 20_000);
  const historyText = (input.history ?? [])
    .slice(-6)
    .map((item) => `${item.role}: ${item.content}`)
    .join("\n");
  const prompt = await generateStreamedText({
    config,
    model: config.BOOT_TOOL_MODEL,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
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
  const requestPattern =
    /(画图|画(?:一下|(?:一|两|几)?(?:张|幅|个|只))|生图|出图|绘制|生成(?:一张|图片|图像|头像|壁纸|插画)|做(?:一张|个)?(?:头像|壁纸|插画)|draw\s+(?:an?\s+)?image|image\s*gen|generate\s+(?:an?\s+)?image|illustrat(?:e|ion))/giu;
  for (const match of content.matchAll(requestPattern)) {
    const prefix = content.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0);
    if (
      !/(?:不要|别|无需|不必|不需要|请勿)(?:(?:再|你|给我|帮我)\s*)*$|(?:do\s+not|don't|dont|no\s+need\s+to)\s*$/iu.test(
        prefix
      )
    ) {
      return true;
    }
  }
  return false;
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
    model: config.BOOT_MEMORY_MODEL,
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
  abortSignal?: AbortSignal;
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
      abortSignal: input.abortSignal
        ? AbortSignal.any([input.abortSignal, timeoutSignal(config.BOOT_IMAGE_TIMEOUT_MS)])
        : timeoutSignal(config.BOOT_IMAGE_TIMEOUT_MS)
    });
  } catch (error) {
    if (isAbortError(error)) {
      if (input.abortSignal?.aborted) {
        throw new BootProviderError("AI relay image generation was cancelled.", 499);
      }
      throw new BootProviderError(`AI relay image generation timed out after ${config.BOOT_IMAGE_TIMEOUT_MS}ms.`, 504);
    }
    throw new BootProviderError(`AI relay image generation failed: ${errorMessage(error)}`, 502);
  }

  try {
    return {
      images: result.images.map((image) =>
        generatedImageSchema.parse({
          base64: image.base64,
          mediaType: image.mediaType
        })
      ),
      warnings: result.warnings.map((warning) => `${warning.type}: ${JSON.stringify(warning)}`)
    };
  } catch {
    throw new BootProviderError("AI relay returned unsupported or oversized image data.", 502);
  }
}
