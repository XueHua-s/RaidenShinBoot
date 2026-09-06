import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

const modelIdSchema = z.string().trim().min(1).max(200);
const envNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const capabilitySchema = z.enum(["chat", "image"]);
const selectableModelsSchema = z.union([
  z.enum(["discovered-chat", "discovered-image"]),
  z.array(modelIdSchema).max(200)
]);

const providerSchema = z
  .object({
    kind: z.literal("openai-compatible"),
    baseUrlEnv: envNameSchema.default("BOOT_BASE_URL"),
    chatBaseUrlEnv: envNameSchema.default("BOOT_CHAT_BASE_URL"),
    imageBaseUrlEnv: envNameSchema.default("BOOT_IMAGE_BASE_URL"),
    apiKeyEnv: envNameSchema.default("BOOT_API_KEY"),
    chatApiKeyEnv: envNameSchema.default("BOOT_CHAT_API_KEY"),
    imageApiKeyEnv: envNameSchema.default("BOOT_IMAGE_API_KEY"),
    protocol: z
      .object({
        chatEndpoint: z.string().trim().min(1).default("/chat/completions"),
        responsesEndpoint: z.string().trim().min(1).default("/responses"),
        streamRequired: z.boolean().default(true)
      })
      .strict()
      .default({ chatEndpoint: "/chat/completions", responsesEndpoint: "/responses", streamRequired: true }),
    catalog: z
      .object({
        endpoint: z.string().trim().min(1).default("/models"),
        refreshSeconds: z.number().int().min(30).max(86_400).default(900),
        staleAfterSeconds: z.number().int().min(60).max(604_800).default(86_400)
      })
      .strict()
      .default({ endpoint: "/models", refreshSeconds: 900, staleAfterSeconds: 86_400 })
  })
  .strict();

const languageDefaultsSchema = z
  .object({
    conversation: modelIdSchema.default("gpt-5.5"),
    summarization: modelIdSchema.default("gpt-5.5"),
    memoryExtraction: modelIdSchema.default("gpt-5.5"),
    toolReasoning: modelIdSchema.default("gpt-5.5")
  })
  .strict();

export const modelConfigurationSchema = z
  .object({
    version: z.literal(1),
    providers: z.record(z.string().min(1), providerSchema).refine((providers) => Object.keys(providers).length > 0, {
      message: "At least one provider is required"
    }),
    catalog: z
      .object({
        allow: z.union([z.literal("discovered"), z.array(modelIdSchema).max(500)]).default("discovered"),
        capabilityOverrides: z.record(modelIdSchema, z.array(capabilitySchema).min(1).max(2)).default({})
      })
      .strict(),
    routing: z
      .object({
        language: z
          .object({
            provider: z.string().min(1),
            defaults: languageDefaultsSchema,
            fallbacks: z.array(modelIdSchema).max(20).default([]),
            userSelectable: selectableModelsSchema.default("discovered-chat")
          })
          .strict(),
        image: z
          .object({
            provider: z.string().min(1),
            default: modelIdSchema.default("gpt-image-2-codex"),
            userSelectable: selectableModelsSchema.default(["gpt-image-2-codex"]),
            async: z.literal(true).default(true)
          })
          .strict()
      })
      .strict(),
    embedding: z
      .object({
        kind: z.literal("local-openai-compatible"),
        baseUrl: z.string().url().default("http://127.0.0.1:8080/v1"),
        baseUrlEnv: envNameSchema.default("BOOT_EMBEDDING_BASE_URL"),
        apiKeyEnv: envNameSchema.default("BOOT_EMBEDDING_API_KEY"),
        model: modelIdSchema.default("BAAI/bge-small-zh-v1.5"),
        dimensions: z.literal(512).default(512),
        normalized: z.literal(true).default(true),
        queryPrefix: z.string().max(200).default("为这个句子生成表示以用于检索相关文章：")
      })
      .strict(),
    probes: z
      .object({
        beforePublish: z.boolean().default(true),
        cacheSeconds: z.number().int().min(1).max(86_400).default(300),
        chatPrompt: z.string().trim().min(1).max(100).default("只回复 OK")
      })
      .strict()
      .default({ beforePublish: true, cacheSeconds: 300, chatPrompt: "只回复 OK" })
  })
  .strict()
  .superRefine((configuration, context) => {
    for (const [route, providerId] of [
      ["routing.language.provider", configuration.routing.language.provider],
      ["routing.image.provider", configuration.routing.image.provider]
    ] as const) {
      if (!configuration.providers[providerId]) {
        context.addIssue({
          code: "custom",
          message: `${route} references unknown provider ${providerId}`,
          path: route.split(".")
        });
      }
    }
  });

export type ModelConfiguration = z.infer<typeof modelConfigurationSchema>;
export type ModelCapability = z.infer<typeof capabilitySchema>;
export type LanguageModelRole = keyof ModelConfiguration["routing"]["language"]["defaults"];

export const defaultModelConfiguration = modelConfigurationSchema.parse({
  version: 1,
  providers: {
    relay: {
      kind: "openai-compatible"
    }
  },
  catalog: {
    allow: "discovered",
    capabilityOverrides: {
      "chatgpt-image-latest": ["image"],
      "gpt-image-2-codex": ["image"],
      imagegen: ["image"]
    }
  },
  routing: {
    language: {
      provider: "relay",
      defaults: {
        conversation: "gpt-5.5",
        summarization: "gpt-5.5",
        memoryExtraction: "gpt-5.5",
        toolReasoning: "gpt-5.5"
      },
      fallbacks: [],
      userSelectable: "discovered-chat"
    },
    image: {
      provider: "relay",
      default: "gpt-image-2-codex",
      userSelectable: ["gpt-image-2-codex"],
      async: true
    }
  },
  embedding: {
    kind: "local-openai-compatible",
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "BAAI/bge-small-zh-v1.5",
    dimensions: 512,
    normalized: true
  }
});

type CachedConfiguration = {
  path: string;
  modifiedAtMs: number;
  configuration: ModelConfiguration;
};

let cachedConfiguration: CachedConfiguration | null = null;
let lastFailedReload: string | null = null;

export function parseModelConfigurationYaml(source: string): ModelConfiguration {
  return modelConfigurationSchema.parse(parseYaml(source));
}

export function getModelConfiguration(env: NodeJS.ProcessEnv = process.env): ModelConfiguration {
  const configuredPath = env.RAIDEN_MODEL_CONFIG?.trim();
  const path = configuredPath
    ? resolve(workspaceRoot, configuredPath)
    : fileURLToPath(new URL("../../../config/models.yaml", import.meta.url));

  if (!existsSync(path)) {
    if (cachedConfiguration?.path === path) {
      warnOnceForFailedReload(path, "missing", "file does not exist");
      return cachedConfiguration.configuration;
    }
    if (configuredPath) {
      throw new Error(`RAIDEN_MODEL_CONFIG does not exist: ${path}`);
    }
    return defaultModelConfiguration;
  }

  let modifiedAtMs: number | null = null;
  try {
    modifiedAtMs = statSync(path).mtimeMs;
    if (cachedConfiguration?.path === path && cachedConfiguration.modifiedAtMs === modifiedAtMs) {
      return cachedConfiguration.configuration;
    }
    const configuration = parseModelConfigurationYaml(readFileSync(path, "utf8"));
    cachedConfiguration = { path, modifiedAtMs, configuration };
    lastFailedReload = null;
    return configuration;
  } catch (error) {
    if (cachedConfiguration?.path === path) {
      warnOnceForFailedReload(path, String(modifiedAtMs ?? "unreadable"), summarizeConfigurationError(error));
      return cachedConfiguration.configuration;
    }
    throw error;
  }
}

export function clearModelConfigurationCache() {
  cachedConfiguration = null;
  lastFailedReload = null;
}

function warnOnceForFailedReload(path: string, version: string, message: string) {
  const failureKey = `${path}:${version}:${message}`;
  if (failureKey === lastFailedReload) {
    return;
  }
  lastFailedReload = failureKey;
  console.warn(`Model configuration reload failed; keeping the last valid snapshot: ${message}`);
}

function summarizeConfigurationError(error: unknown) {
  if (error instanceof z.ZodError) {
    const shown = error.issues.slice(0, 3).map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "configuration";
      return `${location}: ${issue.message}`;
    });
    const remaining = error.issues.length - shown.length;
    return `${shown.join("; ")}${remaining > 0 ? `; +${remaining} more` : ""}`;
  }

  const message = error instanceof Error ? error.message : "unknown reload error";
  return message.replace(/\s+/g, " ").slice(0, 500);
}

export function modelCapabilities(configuration: ModelConfiguration, modelId: string): ModelCapability[] {
  const overridden = configuration.catalog.capabilityOverrides[modelId];
  if (overridden) {
    return overridden;
  }

  const normalized = modelId.toLowerCase();
  if (["image", "dall-e"].some((marker) => normalized.includes(marker))) {
    return ["image"];
  }
  if (["embedding", "whisper", "tts", "moderation", "rerank"].some((marker) => normalized.includes(marker))) {
    return [];
  }
  return ["chat"];
}

export function modelAllowedByConfiguration(configuration: ModelConfiguration, modelId: string) {
  return configuration.catalog.allow === "discovered" || configuration.catalog.allow.includes(modelId);
}

export function modelSelectableByUser(
  configuration: ModelConfiguration,
  modelId: string,
  capability: ModelCapability
) {
  const selection =
    capability === "chat" ? configuration.routing.language.userSelectable : configuration.routing.image.userSelectable;
  if (Array.isArray(selection)) {
    return selection.includes(modelId);
  }
  return selection === `discovered-${capability}`;
}
