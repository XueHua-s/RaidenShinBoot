import {
  deleteRuntimeSetting,
  encryptRuntimeSettingValue,
  getRuntimeSettingsEnvOverrides,
  isRuntimeSettingsSecretStorageReady,
  listRuntimeSettings,
  upsertRuntimeSetting
} from "@raiden/database";
import { updateRuntimeSettingsRequestSchema, type RuntimeSettings } from "@raiden/shared";
import { getBootConfig } from "@raiden/shared/boot";
import { getBootSearchConfig } from "@raiden/shared/search";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requirePermission, type AuthVariables, writeAuditFromContext } from "../auth.js";
import { loadRuntimeEnv } from "../runtime-config.js";

const defaultBootBaseUrl = "https://proxy.xhblog.top:3000/v1";

const publicSettingFields = {
  gatewayPreset: "BOOT_GATEWAY_PRESET",
  bootBaseUrl: "BOOT_BASE_URL",
  bootChatBaseUrl: "BOOT_CHAT_BASE_URL",
  bootEmbeddingBaseUrl: "BOOT_EMBEDDING_BASE_URL",
  bootImageBaseUrl: "BOOT_IMAGE_BASE_URL",
  bootSearchBaseUrl: "BOOT_SEARCH_BASE_URL",
  bootChatModel: "BOOT_CHAT_MODEL",
  bootEmbeddingModel: "BOOT_EMBEDDING_MODEL",
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
    bootChatModel: process.env.BOOT_CHAT_MODEL ?? "gpt-5.5",
    bootEmbeddingModel: process.env.BOOT_EMBEDDING_MODEL ?? "text-embedding-3-large",
    bootImageModel: process.env.BOOT_IMAGE_MODEL ?? "gpt-image-1",
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

async function persistPublicSetting(key: string, value: string | number | null, updatedByAdminId: string) {
  if (value === null) {
    await deleteRuntimeSetting(key);
    return;
  }

  await upsertRuntimeSetting({
    key,
    value: String(value),
    encrypted: false,
    updatedByAdminId
  });
}

async function persistSecretSetting(key: string, value: string | null, updatedByAdminId: string) {
  if (value === null) {
    await deleteRuntimeSetting(key);
    return;
  }

  if (!isRuntimeSettingsSecretStorageReady()) {
    throw new HTTPException(400, {
      message: "BOOT_SETTINGS_ENCRYPTION_KEY is required before saving API keys in the admin panel"
    });
  }

  await upsertRuntimeSetting({
    key,
    value: encryptRuntimeSettingValue(value),
    encrypted: true,
    updatedByAdminId
  });
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
  .patch("/settings", zValidator("json", updateRuntimeSettingsRequestSchema), async (c) => {
    const admin = requirePermission(c, "system:write");
    const body = c.req.valid("json");
    const before = await buildRuntimeSettingsPayload();

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

      await persistPublicSetting(key, value as string | number | null, admin.id);
    }

    for (const [field, key] of Object.entries(secretSettingFields) as Array<
      [keyof typeof secretSettingFields, (typeof secretSettingFields)[keyof typeof secretSettingFields]]
    >) {
      if (!(field in body)) {
        continue;
      }

      await persistSecretSetting(key, body[field as keyof typeof body] as string | null, admin.id);
    }

    const after = await buildRuntimeSettingsPayload();
    await writeAuditFromContext(c, {
      action: "runtime_settings.update",
      targetType: "runtime_settings",
      before,
      after
    });

    return c.json({ data: after });
  });
