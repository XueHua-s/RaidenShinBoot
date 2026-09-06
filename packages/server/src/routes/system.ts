import {
  applyRuntimeSettingsChangesWithAudit,
  encryptRuntimeSettingValue,
  getRuntimeSettingsEnvOverrides,
  isRuntimeSettingsSecretStorageReady,
  listRuntimeSettings,
  type NewRuntimeSetting
} from "@raiden/database";
import { updateRuntimeSettingsRequestSchema, type RuntimeSettings, type UpdateRuntimeSettingsRequest } from "@raiden/shared";
import {
  getBootConfig,
  isLikelyChatModelId,
  isLikelyImageModelId,
  listChatModels,
  listImageModels,
  probeChatModel
} from "@raiden/shared/boot";
import { getBootSearchConfig } from "@raiden/shared/search";
import { zValidator } from "@hono/zod-validator";
import { listEffectiveChatModels, listEffectiveImageModels, loadRuntimeEnv } from "@raiden/boot";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auditRequestMeta, requirePermission, type AuthVariables } from "../auth.js";

const publicSettingFields = {
  gatewayPreset: "BOOT_GATEWAY_PRESET",
  bootBaseUrl: "BOOT_BASE_URL",
  bootChatBaseUrl: "BOOT_CHAT_BASE_URL",
  bootEmbeddingBaseUrl: "BOOT_EMBEDDING_BASE_URL",
  bootImageBaseUrl: "BOOT_IMAGE_BASE_URL",
  bootSearchBaseUrl: "BOOT_SEARCH_BASE_URL",
  bootWikipediaApiUrl: "BOOT_WIKIPEDIA_API_URL",
  bootMoegirlApiUrl: "BOOT_MOEGIRL_API_URL",
  bootChatModel: "BOOT_CHAT_MODEL",
  bootSummaryModel: "BOOT_SUMMARY_MODEL",
  bootMemoryModel: "BOOT_MEMORY_MODEL",
  bootToolModel: "BOOT_TOOL_MODEL",
  bootImageModel: "BOOT_IMAGE_MODEL",
  bootSearchProvider: "BOOT_SEARCH_PROVIDER",
  bootSearchMaxResults: "BOOT_SEARCH_MAX_RESULTS",
  bootSearchDepth: "BOOT_SEARCH_DEPTH"
} as const;

const secretSettingFields = {
  bootApiKey: "BOOT_API_KEY",
  bootChatApiKey: "BOOT_CHAT_API_KEY",
  bootEmbeddingApiKey: "BOOT_EMBEDDING_API_KEY",
  bootImageApiKey: "BOOT_IMAGE_API_KEY",
  bootSearchApiKey: "BOOT_SEARCH_API_KEY"
} as const;

const nullablePublicFields = new Set<keyof typeof publicSettingFields>([
  "bootChatBaseUrl",
  "bootEmbeddingBaseUrl",
  "bootImageBaseUrl",
  "bootSearchBaseUrl"
]);

type RuntimeSettingRow = Awaited<ReturnType<typeof listRuntimeSettings>>[number];

const modelListQuerySchema = z.object({
  refresh: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true")
});

function configuredFromEnvOrRows(key: string, rows: RuntimeSettingRow[]) {
  return Boolean(process.env[key]?.trim()) || rows.some((row) => row.key === key && Boolean(row.value));
}

function latestRuntimeSettingsUpdate(rows: RuntimeSettingRow[]) {
  const timestamps = rows.map((row) => row.updatedAt).filter(Boolean);
  if (timestamps.length === 0) {
    return null;
  }

  return timestamps.sort().at(-1) ?? null;
}

function gatewayPreset(value: unknown) {
  return value === "new_api" ? "new_api" : "openai_compatible";
}

async function listRuntimeSettingsSafe() {
  if (!process.env.DATABASE_URL) {
    return [];
  }

  try {
    return await listRuntimeSettings();
  } catch {
    return [];
  }
}

async function buildRuntimeSettingsPayload(): Promise<RuntimeSettings> {
  const [rows, overrides] = await Promise.all([listRuntimeSettingsSafe(), getRuntimeSettingsEnvOverrides().catch(() => ({}))]);
  const env = { ...process.env, ...overrides };
  const bootConfig = getBootConfig(env);
  const searchConfig = getBootSearchConfig(env);

  return {
    gatewayPreset: gatewayPreset(env.BOOT_GATEWAY_PRESET),
    bootBaseUrl: bootConfig.BOOT_BASE_URL,
    bootChatBaseUrl: bootConfig.BOOT_CHAT_BASE_URL ?? null,
    bootEmbeddingBaseUrl: bootConfig.BOOT_EMBEDDING_BASE_URL ?? null,
    bootImageBaseUrl: bootConfig.BOOT_IMAGE_BASE_URL ?? null,
    bootSearchBaseUrl: searchConfig.BOOT_SEARCH_BASE_URL ?? null,
    bootWikipediaApiUrl: searchConfig.BOOT_WIKIPEDIA_API_URL,
    bootMoegirlApiUrl: searchConfig.BOOT_MOEGIRL_API_URL,
    bootChatModel: bootConfig.BOOT_CHAT_MODEL,
    bootSummaryModel: bootConfig.BOOT_SUMMARY_MODEL,
    bootMemoryModel: bootConfig.BOOT_MEMORY_MODEL,
    bootToolModel: bootConfig.BOOT_TOOL_MODEL,
    bootEmbeddingModel: bootConfig.BOOT_EMBEDDING_MODEL,
    bootImageModel: bootConfig.BOOT_IMAGE_MODEL,
    bootSearchProvider: searchConfig.BOOT_SEARCH_PROVIDER,
    bootSearchMaxResults: searchConfig.BOOT_SEARCH_MAX_RESULTS,
    bootSearchDepth: searchConfig.BOOT_SEARCH_DEPTH,
    embeddingDimensions: bootConfig.BOOT_EMBEDDING_DIMENSIONS,
    personaId: bootConfig.PERSONA_ID,
    personaVersion: bootConfig.PERSONA_VERSION,
    personaHash: bootConfig.PERSONA_HASH,
    newApiCompatible: true,
    secretStorageReady: isRuntimeSettingsSecretStorageReady(),
    secrets: {
      bootApiKey: configuredFromEnvOrRows("BOOT_API_KEY", rows),
      bootChatApiKey: configuredFromEnvOrRows("BOOT_CHAT_API_KEY", rows),
      bootEmbeddingApiKey: configuredFromEnvOrRows("BOOT_EMBEDDING_API_KEY", rows),
      bootImageApiKey: configuredFromEnvOrRows("BOOT_IMAGE_API_KEY", rows),
      bootSearchApiKey: configuredFromEnvOrRows("BOOT_SEARCH_API_KEY", rows)
    },
    updatedAt: latestRuntimeSettingsUpdate(rows)
  };
}

export function healthStatusPayload() {
  return {
    ok: true,
    service: "raiden-shin-server"
  };
}

export async function systemStatusPayload() {
  const [env, rows] = await Promise.all([loadRuntimeEnv(), listRuntimeSettingsSafe()]);
  const bootConfig = getBootConfig(env);
  const searchConfig = getBootSearchConfig(env);

  return {
    ok: true,
    service: "raiden-shin-server",
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    bootBaseUrl: bootConfig.BOOT_BASE_URL,
    bootChatBaseUrl: bootConfig.BOOT_CHAT_BASE_URL ?? bootConfig.BOOT_BASE_URL,
    bootEmbeddingBaseUrl: bootConfig.BOOT_EMBEDDING_BASE_URL ?? bootConfig.BOOT_BASE_URL,
    bootImageBaseUrl: bootConfig.BOOT_IMAGE_BASE_URL ?? bootConfig.BOOT_BASE_URL,
    bootSearchBaseUrl: searchConfig.BOOT_SEARCH_BASE_URL ?? null,
    bootWikipediaApiUrl: searchConfig.BOOT_WIKIPEDIA_API_URL,
    bootMoegirlApiUrl: searchConfig.BOOT_MOEGIRL_API_URL,
    bootChatModel: bootConfig.BOOT_CHAT_MODEL,
    bootSummaryModel: bootConfig.BOOT_SUMMARY_MODEL,
    bootMemoryModel: bootConfig.BOOT_MEMORY_MODEL,
    bootToolModel: bootConfig.BOOT_TOOL_MODEL,
    bootEmbeddingModel: bootConfig.BOOT_EMBEDDING_MODEL,
    bootImageModel: bootConfig.BOOT_IMAGE_MODEL,
    bootSearchProvider: searchConfig.BOOT_SEARCH_PROVIDER,
    bootSearchMaxResults: searchConfig.BOOT_SEARCH_MAX_RESULTS,
    bootSearchDepth: searchConfig.BOOT_SEARCH_DEPTH,
    bootApiKeyConfigured: configuredFromEnvOrRows("BOOT_API_KEY", rows),
    bootChatApiKeyConfigured: configuredFromEnvOrRows("BOOT_CHAT_API_KEY", rows),
    bootEmbeddingApiKeyConfigured: configuredFromEnvOrRows("BOOT_EMBEDDING_API_KEY", rows),
    bootImageApiKeyConfigured: configuredFromEnvOrRows("BOOT_IMAGE_API_KEY", rows),
    bootSearchApiKeyConfigured: configuredFromEnvOrRows("BOOT_SEARCH_API_KEY", rows),
    runtimeSettingsConfigured: rows.length > 0,
    runtimeSettingsSecretStorageReady: isRuntimeSettingsSecretStorageReady(),
    authEnabled: true,
    botTokenConfigured: Boolean(process.env.BOT_TOKEN),
    personaId: bootConfig.PERSONA_ID,
    personaVersion: bootConfig.PERSONA_VERSION,
    personaHash: bootConfig.PERSONA_HASH
  };
}

function publicSettingChange(key: string, value: string | number | null, updatedByAdminId: string) {
  if (value === null) {
    return { deleteKey: key };
  }

  return {
    upsert: {
      key,
      value: String(value),
      encrypted: false,
      updatedByAdminId
    } satisfies NewRuntimeSetting
  };
}

function secretSettingChange(key: string, value: string | null, updatedByAdminId: string) {
  if (value === null) {
    return { deleteKey: key };
  }

  if (!isRuntimeSettingsSecretStorageReady()) {
    throw new HTTPException(400, {
      message: "BOOT_SETTINGS_ENCRYPTION_KEY is required before saving API keys in the admin panel"
    });
  }

  return {
    upsert: {
      key,
      value: encryptRuntimeSettingValue(value),
      encrypted: true,
      updatedByAdminId
    } satisfies NewRuntimeSetting
  };
}

function applyRuntimeSettingsRequestToEnv(env: NodeJS.ProcessEnv, body: UpdateRuntimeSettingsRequest): NodeJS.ProcessEnv {
  const candidate = { ...env };

  for (const [field, key] of Object.entries(publicSettingFields) as Array<
    [keyof typeof publicSettingFields, (typeof publicSettingFields)[keyof typeof publicSettingFields]]
  >) {
    if (!(field in body)) {
      continue;
    }

    const value = body[field as keyof typeof body];
    if (value === null) {
      if (process.env[key]?.trim()) {
        candidate[key] = process.env[key];
      } else {
        delete candidate[key];
      }
    } else if (value !== undefined) {
      candidate[key] = String(value);
    }
  }

  for (const [field, key] of Object.entries(secretSettingFields) as Array<
    [keyof typeof secretSettingFields, (typeof secretSettingFields)[keyof typeof secretSettingFields]]
  >) {
    if (!(field in body)) {
      continue;
    }

    const value = body[field as keyof typeof body];
    if (value === null) {
      if (process.env[key]?.trim()) {
        candidate[key] = process.env[key];
      } else {
        delete candidate[key];
      }
    } else if (typeof value === "string") {
      candidate[key] = value;
    }
  }

  return candidate;
}

async function validateRuntimeModelPatch(body: UpdateRuntimeSettingsRequest) {
  const languageFields = [
    ["bootChatModel", "BOOT_CHAT_MODEL", "conversation"],
    ["bootSummaryModel", "BOOT_SUMMARY_MODEL", "summarization"],
    ["bootMemoryModel", "BOOT_MEMORY_MODEL", "memory extraction"],
    ["bootToolModel", "BOOT_TOOL_MODEL", "tool reasoning"]
  ] as const;
  const languageProviderFields = [
    "gatewayPreset",
    "bootBaseUrl",
    "bootChatBaseUrl",
    "bootApiKey",
    "bootChatApiKey"
  ] as const;
  const imageProviderFields = [
    "gatewayPreset",
    "bootBaseUrl",
    "bootImageBaseUrl",
    "bootApiKey",
    "bootImageApiKey"
  ] as const;
  const languageProviderChanged = languageProviderFields.some((field) => field in body);
  const imageProviderChanged = imageProviderFields.some((field) => field in body);
  const languageChanged = languageFields.some(([field]) => field in body);
  const imageChanged = "bootImageModel" in body;
  if (!languageProviderChanged && !imageProviderChanged && !languageChanged && !imageChanged) {
    return;
  }

  const runtimeEnv = await loadRuntimeEnv();
  const currentConfig = getBootConfig(runtimeEnv);
  const candidateConfig = getBootConfig(applyRuntimeSettingsRequestToEnv(runtimeEnv, body));
  const changedLanguageModels = languageFields
    .filter(
      ([field, configKey]) =>
        languageProviderChanged || (field in body && candidateConfig[configKey] !== currentConfig[configKey])
    )
    .map(([, configKey, role]) => ({ modelId: candidateConfig[configKey], role }));

  if (changedLanguageModels.length > 0) {
    let chatCatalog: Awaited<ReturnType<typeof listChatModels>>;
    try {
      chatCatalog = await listChatModels(candidateConfig, languageProviderChanged);
    } catch (error) {
      throw new HTTPException(400, {
        message: `Unable to load the candidate chat model catalog: ${error instanceof Error ? error.message : "unknown error"}`
      });
    }

    for (const { modelId, role } of changedLanguageModels) {
      if (!isLikelyChatModelId(modelId, candidateConfig)) {
        throw new HTTPException(400, {
          message: `${role} model "${modelId}" is not allowed as a chat-capable model by config/models.yaml.`
        });
      }
      if (!chatCatalog.models.some((model) => model.id === modelId)) {
        throw new HTTPException(400, {
          message: `${role} model "${modelId}" was not found in the provider /v1/models catalog.`
        });
      }
    }

    for (const modelId of new Set(changedLanguageModels.map((entry) => entry.modelId))) {
      try {
        await probeChatModel(modelId, candidateConfig);
      } catch (error) {
        throw new HTTPException(400, {
          message: `Language model "${modelId}" failed the chat probe: ${error instanceof Error ? error.message : "unknown error"}`
        });
      }
    }
  }

  if (imageProviderChanged || (imageChanged && candidateConfig.BOOT_IMAGE_MODEL !== currentConfig.BOOT_IMAGE_MODEL)) {
    const modelId = candidateConfig.BOOT_IMAGE_MODEL;
    if (!isLikelyImageModelId(modelId, candidateConfig)) {
      throw new HTTPException(400, {
        message: `Image model "${modelId}" is not allowed as an image-capable model by config/models.yaml.`
      });
    }
    let imageCatalog: Awaited<ReturnType<typeof listImageModels>>;
    try {
      imageCatalog = await listImageModels(candidateConfig, imageProviderChanged);
    } catch (error) {
      throw new HTTPException(400, {
        message: `Unable to load the candidate image model catalog: ${error instanceof Error ? error.message : "unknown error"}`
      });
    }
    if (!imageCatalog.models.some((model) => model.id === modelId)) {
      throw new HTTPException(400, {
        message: `Image model "${modelId}" was not found in the provider /v1/models catalog.`
      });
    }
  }
}

export const systemRoute = new Hono<{ Variables: AuthVariables }>()
  .get("/status", async (c) => {
    requirePermission(c, "system:read");
    return c.json(await systemStatusPayload());
  })
  .get("/settings", async (c) => {
    requirePermission(c, "system:read");
    return c.json({ data: await buildRuntimeSettingsPayload() });
  })
  .get("/models/chat", zValidator("query", modelListQuerySchema), async (c) => {
    requirePermission(c, "system:read");
    return c.json(await listEffectiveChatModels(c.req.valid("query").refresh));
  })
  .get("/models/image", zValidator("query", modelListQuerySchema), async (c) => {
    requirePermission(c, "system:read");
    return c.json(await listEffectiveImageModels(c.req.valid("query").refresh));
  })
  .patch("/settings", zValidator("json", updateRuntimeSettingsRequestSchema), async (c) => {
    const admin = requirePermission(c, "system:write");
    const body = c.req.valid("json");
    await validateRuntimeModelPatch(body);
    const before = await buildRuntimeSettingsPayload();
    const deletes: string[] = [];
    const upserts: NewRuntimeSetting[] = [];

    for (const [field, key] of Object.entries(publicSettingFields) as Array<
      [keyof typeof publicSettingFields, (typeof publicSettingFields)[keyof typeof publicSettingFields]]
    >) {
      if (!(field in body)) {
        continue;
      }

      const value = body[field as keyof typeof body];
      if (value === null && !nullablePublicFields.has(field)) {
        continue;
      }

      const change = publicSettingChange(key, value as string | number | null, admin.id);
      if ("deleteKey" in change) {
        deletes.push(change.deleteKey);
      } else {
        upserts.push(change.upsert);
      }
    }

    for (const [field, key] of Object.entries(secretSettingFields) as Array<
      [keyof typeof secretSettingFields, (typeof secretSettingFields)[keyof typeof secretSettingFields]]
    >) {
      if (!(field in body)) {
        continue;
      }

      const change = secretSettingChange(key, body[field as keyof typeof body] as string | null, admin.id);
      if ("deleteKey" in change) {
        deletes.push(change.deleteKey);
      } else {
        upserts.push(change.upsert);
      }
    }

    if (deletes.length === 0 && upserts.length === 0) {
      return c.json({ data: before });
    }

    const changedKeys = [...deletes, ...upserts.map((setting) => setting.key)];
    await applyRuntimeSettingsChangesWithAudit({
      changes: { deletes, upserts },
      audit: {
        actorAdminId: admin.id,
        action: "runtime_settings.update",
        targetType: "runtime_settings",
        before,
        after: {
          changedKeys,
          deletedKeys: deletes,
          upsertedKeys: upserts.map((setting) => setting.key)
        },
        ...auditRequestMeta(c)
      }
    });

    const after = await buildRuntimeSettingsPayload();

    return c.json({ data: after });
  });
