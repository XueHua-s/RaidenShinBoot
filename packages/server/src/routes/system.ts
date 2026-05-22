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
  fixedBootEmbeddingModel,
  fixedBootImageModel,
  getBootConfig,
  isLikelyChatModelId,
  listChatModels,
  probeChatModel
} from "@raiden/shared/boot";
import { getBootSearchConfig } from "@raiden/shared/search";
import { zValidator } from "@hono/zod-validator";
import { listEffectiveChatModels, loadRuntimeEnv } from "@raiden/boot";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { auditRequestMeta, requirePermission, type AuthVariables } from "../auth.js";

const defaultBootBaseUrl = "https://proxy.xhblog.top:3000/v1";
const defaultWikipediaApiUrl = "https://zh.wikipedia.org/w/api.php";
const defaultMoegirlApiUrl = "https://zh.moegirl.org.cn/api.php";

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
    bootEmbeddingModel: bootConfig.BOOT_EMBEDDING_MODEL,
    bootImageModel: bootConfig.BOOT_IMAGE_MODEL,
    bootSearchProvider: searchConfig.BOOT_SEARCH_PROVIDER,
    bootSearchMaxResults: searchConfig.BOOT_SEARCH_MAX_RESULTS,
    bootSearchDepth: searchConfig.BOOT_SEARCH_DEPTH,
    embeddingDimensions: 3072,
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
    service: "raiden-shin-server",
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    bootBaseUrl: process.env.BOOT_BASE_URL ?? defaultBootBaseUrl,
    bootChatBaseUrl: process.env.BOOT_CHAT_BASE_URL || process.env.BOOT_BASE_URL || null,
    bootEmbeddingBaseUrl: process.env.BOOT_EMBEDDING_BASE_URL || process.env.BOOT_BASE_URL || null,
    bootImageBaseUrl: process.env.BOOT_IMAGE_BASE_URL || process.env.BOOT_BASE_URL || null,
    bootSearchBaseUrl: process.env.BOOT_SEARCH_BASE_URL || null,
    bootWikipediaApiUrl: process.env.BOOT_WIKIPEDIA_API_URL ?? defaultWikipediaApiUrl,
    bootMoegirlApiUrl: process.env.BOOT_MOEGIRL_API_URL ?? defaultMoegirlApiUrl,
    bootChatModel: process.env.BOOT_CHAT_MODEL ?? "gpt-5.5",
    bootEmbeddingModel: fixedBootEmbeddingModel,
    bootImageModel: fixedBootImageModel,
    bootSearchProvider: process.env.BOOT_SEARCH_PROVIDER ?? "disabled",
    bootSearchMaxResults: Number(process.env.BOOT_SEARCH_MAX_RESULTS ?? "5"),
    bootSearchDepth: process.env.BOOT_SEARCH_DEPTH ?? "basic",
    bootApiKeyConfigured: Boolean(process.env.BOOT_API_KEY),
    bootChatApiKeyConfigured: Boolean(process.env.BOOT_CHAT_API_KEY),
    bootEmbeddingApiKeyConfigured: Boolean(process.env.BOOT_EMBEDDING_API_KEY),
    bootImageApiKeyConfigured: Boolean(process.env.BOOT_IMAGE_API_KEY),
    bootSearchApiKeyConfigured: Boolean(process.env.BOOT_SEARCH_API_KEY),
    runtimeSettingsConfigured: false,
    runtimeSettingsSecretStorageReady: isRuntimeSettingsSecretStorageReady(),
    authEnabled: true,
    botTokenConfigured: Boolean(process.env.BOT_TOKEN)
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
    botTokenConfigured: Boolean(process.env.BOT_TOKEN)
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

async function validateRuntimeChatModelPatch(body: UpdateRuntimeSettingsRequest) {
  const chatProviderTouched =
    "bootChatModel" in body ||
    "gatewayPreset" in body ||
    "bootBaseUrl" in body ||
    "bootChatBaseUrl" in body ||
    "bootApiKey" in body ||
    "bootChatApiKey" in body;
  if (!chatProviderTouched) {
    return;
  }

  const candidateConfig = getBootConfig(applyRuntimeSettingsRequestToEnv(await loadRuntimeEnv(), body));
  const modelId = candidateConfig.BOOT_CHAT_MODEL;
  if (!isLikelyChatModelId(modelId)) {
    throw new HTTPException(400, {
      message: "BOOT_CHAT_MODEL must be a chat-capable model. Fixed embedding/image models cannot be used as the chat model."
    });
  }

  const modelList = await listChatModels(candidateConfig);
  const exists = modelList.models.some((model) => model.id === modelId);
  if (!exists) {
    throw new HTTPException(400, {
      message: `BOOT_CHAT_MODEL "${modelId}" was not found in the provider model list.`
    });
  }

  try {
    await probeChatModel(modelId, candidateConfig);
  } catch (error) {
    throw new HTTPException(400, {
      message: `BOOT_CHAT_MODEL "${modelId}" failed the chat probe: ${error instanceof Error ? error.message : "unknown error"}`
    });
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
  .get("/models/chat", async (c) => {
    requirePermission(c, "system:read");
    return c.json(await listEffectiveChatModels());
  })
  .patch("/settings", zValidator("json", updateRuntimeSettingsRequestSchema), async (c) => {
    const admin = requirePermission(c, "system:write");
    const body = c.req.valid("json");
    await validateRuntimeChatModelPatch(body);
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
