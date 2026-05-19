import { createOpenAI } from "@ai-sdk/openai";
import { embed, generateImage, streamText } from "ai";
import { z } from "zod";
import { buildMemoryContext, raidenMakotoSystemPrompt } from "./persona.js";
import type { WebSearchResponse } from "./schemas.js";
import { formatWebSearchResultsForPrompt } from "./tools.js";

const optionalString = z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());
const optionalUrl = z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional());

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
  BOOT_IMAGE_MODEL: z.string().default("gpt-image-1")
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

export function getBootConfig(env: NodeJS.ProcessEnv = process.env): BootConfig {
  return bootEnvSchema.parse(env);
}

function resolveApiKey(value: string | undefined, purpose: "chat" | "embedding" | "image") {
  if (value) {
    return value;
  }

  throw new Error(`BOOT_${purpose.toUpperCase()}_API_KEY or BOOT_API_KEY is required`);
}

function createChatProvider(config = getBootConfig()) {
  return createOpenAI({
    apiKey: resolveApiKey(config.BOOT_CHAT_API_KEY ?? config.BOOT_API_KEY, "chat"),
    baseURL: config.BOOT_CHAT_BASE_URL ?? config.BOOT_BASE_URL
  });
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
  const provider = createChatProvider(input.config);
  const result = streamText({
    model: provider.chat(input.config.BOOT_CHAT_MODEL),
    system: input.system,
    prompt: input.prompt
  });
  let text = "";
  for await (const chunk of result.textStream) {
    text += chunk;
  }
  return text.trim();
}

export async function embedText(value: string, config = getBootConfig()): Promise<number[]> {
  const provider = createEmbeddingProvider(config);
  const result = await embed({
    model: provider.embedding(config.BOOT_EMBEDDING_MODEL),
    value
  });

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
  const result = await generateImage({
    model: provider.imageModel(config.BOOT_IMAGE_MODEL),
    prompt: [
      "Use a gentle, elegant visual mood inspired by Raiden Makoto: soft lightning, sakura, quiet Inazuma atmosphere, humane warmth.",
      "Do not include text, logos, watermarks, UI chrome, or official game screenshots.",
      `User image request: ${input.prompt}`
    ].join("\n"),
    n: input.n ?? 1,
    size: input.size ?? "1024x1024"
  });

  return {
    images: result.images.map((image) => ({
      base64: image.base64,
      mediaType: image.mediaType
    })),
    warnings: result.warnings.map((warning) => `${warning.type}: ${JSON.stringify(warning)}`)
  };
}
