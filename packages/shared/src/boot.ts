import { createOpenAI } from "@ai-sdk/openai";
import { embed, streamText } from "ai";
import { z } from "zod";
import { buildMemoryContext, raidenMakotoSystemPrompt } from "./persona.js";

const optionalUrl = z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional());

const bootEnvSchema = z.object({
  BOOT_BASE_URL: z.string().url().default("https://proxy.xhblog.top:3000/v1"),
  BOOT_CHAT_BASE_URL: optionalUrl,
  BOOT_EMBEDDING_BASE_URL: optionalUrl,
  BOOT_API_KEY: z.string().min(1, "BOOT_API_KEY is required"),
  BOOT_CHAT_MODEL: z.string().default("gpt-5.5"),
  BOOT_EMBEDDING_MODEL: z.string().default("text-embedding-3-large")
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

function createChatProvider(config = getBootConfig()) {
  return createOpenAI({
    apiKey: config.BOOT_API_KEY,
    baseURL: config.BOOT_CHAT_BASE_URL ?? config.BOOT_BASE_URL
  });
}

function createEmbeddingProvider(config = getBootConfig()) {
  return createOpenAI({
    apiKey: config.BOOT_API_KEY,
    baseURL: config.BOOT_EMBEDDING_BASE_URL ?? config.BOOT_BASE_URL
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
  config?: BootConfig;
}): Promise<string> {
  const config = input.config ?? getBootConfig();
  const memoryContext = buildMemoryContext(input.memories ?? []);
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
