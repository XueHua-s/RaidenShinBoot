import { z } from "zod";

export const adminRoleSchema = z.enum(["super_admin", "operator", "auditor"]);
export const adminStatusSchema = z.enum(["active", "disabled"]);
export const telegramChatTypeSchema = z.enum(["private", "group", "supergroup", "channel"]);
export const telegramChatStatusSchema = z.enum(["pending", "approved", "blocked", "muted"]);
export const telegramChatPolicySchema = z.enum(["allow_all_commands", "commands_only", "read_only", "disabled"]);
export const bootGatewayPresetSchema = z.enum(["openai_compatible", "new_api"]);
export const bootSearchProviderSchema = z.enum(["disabled", "tavily", "brave", "serper"]);
export const bootSearchDepthSchema = z.enum(["basic", "advanced"]);
export const bootSearchChannelSchema = z.enum(["google", "wikipedia", "moegirl"]);
export const bootSearchPipelineStatusSchema = z.enum(["completed", "partial"]);
export const bootToolExposureSchema = z.enum(["direct", "deferred"]);
export const bootToolCapabilitySchema = z.enum([
  "router",
  "web",
  "knowledge",
  "persona_context",
  "provider_specific",
  "fallback_safe",
  "image",
  "generation"
]);

const emptyStringToNull = (value: unknown) => (value === "" ? null : value);
const optionalNullableUrlSchema = z.preprocess(emptyStringToNull, z.string().trim().url().nullable().optional());
const optionalNullableSecretSchema = z.preprocess(
  emptyStringToNull,
  z.string().trim().min(1).max(4000).nullable().optional()
);

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0)
});

export const loginRequestSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(200)
});

export const adminUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  role: adminRoleSchema,
  status: adminStatusSchema,
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const authMeResponseSchema = z.object({
  user: adminUserSchema,
  csrfToken: z.string()
});

export const loginResponseSchema = authMeResponseSchema;

export const createAdminUserRequestSchema = z.object({
  username: z.string().trim().min(1).max(80),
  displayName: z.string().trim().max(120).optional(),
  password: z.string().min(12).max(200),
  role: adminRoleSchema.default("operator")
});

export const updateAdminUserRequestSchema = z.object({
  displayName: z.string().trim().max(120).nullable().optional(),
  password: z.string().min(12).max(200).optional(),
  role: adminRoleSchema.optional(),
  status: adminStatusSchema.optional()
});

export const adminSessionSchema = z.object({
  id: z.string(),
  adminUserId: z.string(),
  username: z.string(),
  role: adminRoleSchema,
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  createdAt: z.string()
});

export const auditLogSchema = z.object({
  id: z.string(),
  actorAdminId: z.string().nullable(),
  actorUsername: z.string().nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string()
});

export const telegramUserSchema = z.object({
  telegramId: z.string(),
  username: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  languageCode: z.string().nullable(),
  firstSeenAt: z.string(),
  updatedAt: z.string()
});

export const telegramChatSchema = z.object({
  chatId: z.string(),
  type: telegramChatTypeSchema,
  title: z.string().nullable(),
  username: z.string().nullable(),
  status: telegramChatStatusSchema,
  policy: telegramChatPolicySchema,
  firstSeenAt: z.string(),
  updatedAt: z.string()
});

export const updateTelegramChatRequestSchema = z.object({
  title: z.string().trim().max(160).nullable().optional(),
  username: z.string().trim().max(120).nullable().optional(),
  status: telegramChatStatusSchema.optional(),
  policy: telegramChatPolicySchema.optional()
});

export const telegramCommandNameSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^\//, "").toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9_]{1,32}$/, "Command must be 1-32 lowercase letters, numbers, or underscores."));

export const telegramCommandPermissionSchema = z.object({
  id: z.string(),
  chatId: z.string().nullable(),
  command: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const upsertTelegramCommandPermissionRequestSchema = z.object({
  chatId: z.string().nullable().optional(),
  command: telegramCommandNameSchema.refine((command) => command !== "model", {
    message: "/model is hidden and cannot be managed by command permission rules."
  }),
  enabled: z.boolean()
});

export const messageSchema = z.object({
  id: z.string(),
  telegramUserId: z.string(),
  telegramChatId: z.string().nullable().optional(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.string()
});

export const memorySchema = z.object({
  id: z.string(),
  telegramUserId: z.string(),
  summary: z.string(),
  importance: z.number(),
  sourceMessageId: z.string().nullable(),
  createdAt: z.string(),
  lastAccessedAt: z.string().nullable()
});

export const chatRequestSchema = z.object({
  telegramUserId: z.string().min(1),
  username: z.string().optional(),
  content: z.string().min(1).max(4000)
});

export const generatedImageSchema = z.object({
  base64: z.string().min(1),
  mediaType: z.string().min(1)
});

export const bootToolActionSchema = z.enum(["none", "web_search", "makoto_image"]);
export const bootConversationToolNameSchema = z.enum(["web_search", "makoto_image"]);
export const bootToolExecutionStatusSchema = z.enum(["skipped", "completed", "failed"]);

export const bootToolDecisionSchema = z.object({
  action: bootToolActionSchema.default("none"),
  reason: z.string().trim().max(500).default(""),
  query: z.string().trim().min(1).max(500).nullable().default(null),
  prompt: z.string().trim().min(1).max(2000).nullable().default(null)
});

export const bootToolStatusSchema = z.object({
  name: bootConversationToolNameSchema.nullable().default(null),
  status: bootToolExecutionStatusSchema.default("skipped"),
  message: z.string().trim().max(1000).nullable().default(null)
});

export const chatResponseSchema = z.object({
  reply: z.string(),
  memoryCount: z.number().int().min(0),
  webSearchResultCount: z.number().int().min(0).default(0),
  webSearchStatus: z.enum(["skipped", "completed", "failed"]).default("skipped"),
  cacheStatus: z.enum(["disabled", "miss", "l1_hit", "l2_hit"]).default("disabled"),
  cacheSimilarity: z.number().nullable().default(null),
  toolDecision: bootToolDecisionSchema.default({ action: "none", reason: "", query: null, prompt: null }),
  toolStatus: bootToolStatusSchema.default({ name: null, status: "skipped", message: null }),
  images: z.array(generatedImageSchema).default([])
});

export const imageGenerationRequestSchema = z.object({
  prompt: z.string().min(1).max(2000),
  size: z
    .string()
    .regex(/^\d+x\d+$/, "size must use WIDTHxHEIGHT format")
    .default("1024x1024"),
  n: z.number().int().min(1).max(4).default(1)
});

export const imageGenerationResponseSchema = z.object({
  images: z.array(generatedImageSchema).min(1).max(4),
  warnings: z.array(z.string())
});

export const providerModelSchema = z
  .object({
    id: z.string().min(1),
    object: z.string().optional(),
    owned_by: z.string().optional(),
    created: z.number().optional()
  })
  .passthrough();

export const providerModelListResponseSchema = z.object({
  object: z.string().optional(),
  data: z.array(providerModelSchema)
});

export const chatModelListResponseSchema = z.object({
  currentModel: z.string(),
  models: z.array(providerModelSchema),
  source: z.string().url()
});

export const webSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(500),
  maxResults: z.number().int().min(1).max(10).default(5)
});

export const webSearchResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  snippet: z.string().optional(),
  publishedAt: z.string().optional(),
  source: z.string().optional()
});

export const webSearchResponseSchema = z.object({
  query: z.string(),
  provider: z.string(),
  status: bootSearchPipelineStatusSchema.default("completed"),
  channels: z.array(bootSearchChannelSchema).default([]),
  failures: z.array(z.string()).default([]),
  results: z.array(webSearchResultSchema)
});

export const bootToolDescriptorSchema = z.object({
  name: z.string(),
  description: z.string(),
  exposure: bootToolExposureSchema,
  searchHint: z.string(),
  capabilities: z.array(bootToolCapabilitySchema),
  channels: z.array(bootSearchChannelSchema).default([]),
  readOnly: z.boolean(),
  destructive: z.boolean(),
  concurrencySafe: z.boolean(),
  maxResultCount: z.number().int().min(1),
  resultBudgetChars: z.number().int().min(1)
});

export const bootToolSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(160),
  maxResults: z.number().int().min(1).max(10).default(5)
});

export const bootToolSearchMatchSchema = bootToolDescriptorSchema.extend({
  score: z.number()
});

export const bootToolSearchResponseSchema = z.object({
  query: z.string(),
  totalTools: z.number().int().min(0),
  matches: z.array(bootToolSearchMatchSchema)
});

export const createMemoryRequestSchema = z.object({
  telegramUserId: z.string().min(1),
  summary: z.string().min(1).max(2000),
  importance: z.number().int().min(1).max(10).default(5)
});

export const memorySearchRequestSchema = z.object({
  telegramUserId: z.string().min(1),
  query: z.string().trim().min(1).max(1000),
  limit: z.number().int().min(1).max(20).default(6)
});

export const memorySearchHitSchema = memorySchema.extend({
  distance: z.number(),
  score: z.number()
});

export const memorySearchResponseSchema = z.object({
  data: z.array(memorySearchHitSchema)
});

export const systemStatusSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  databaseConfigured: z.boolean(),
  bootBaseUrl: z.string(),
  bootChatBaseUrl: z.string().nullable(),
  bootEmbeddingBaseUrl: z.string().nullable(),
  bootImageBaseUrl: z.string().nullable(),
  bootSearchBaseUrl: z.string().nullable(),
  bootWikipediaApiUrl: z.string(),
  bootMoegirlApiUrl: z.string(),
  bootChatModel: z.string(),
  bootEmbeddingModel: z.string(),
  bootImageModel: z.string(),
  bootSearchProvider: z.string(),
  bootSearchMaxResults: z.number(),
  bootSearchDepth: z.string(),
  bootApiKeyConfigured: z.boolean(),
  bootChatApiKeyConfigured: z.boolean(),
  bootEmbeddingApiKeyConfigured: z.boolean(),
  bootImageApiKeyConfigured: z.boolean(),
  bootSearchApiKeyConfigured: z.boolean(),
  runtimeSettingsConfigured: z.boolean(),
  runtimeSettingsSecretStorageReady: z.boolean(),
  authEnabled: z.boolean(),
  botTokenConfigured: z.boolean()
});

export const runtimeSettingsSchema = z.object({
  gatewayPreset: bootGatewayPresetSchema,
  bootBaseUrl: z.string().url(),
  bootChatBaseUrl: z.string().url().nullable(),
  bootEmbeddingBaseUrl: z.string().url().nullable(),
  bootImageBaseUrl: z.string().url().nullable(),
  bootSearchBaseUrl: z.string().url().nullable(),
  bootWikipediaApiUrl: z.string().url(),
  bootMoegirlApiUrl: z.string().url(),
  bootChatModel: z.string(),
  bootEmbeddingModel: z.string(),
  bootImageModel: z.string(),
  bootSearchProvider: bootSearchProviderSchema,
  bootSearchMaxResults: z.number().int().min(1).max(10),
  bootSearchDepth: bootSearchDepthSchema,
  embeddingDimensions: z.literal(3072),
  newApiCompatible: z.boolean(),
  secretStorageReady: z.boolean(),
  secrets: z.object({
    bootApiKey: z.boolean(),
    bootChatApiKey: z.boolean(),
    bootEmbeddingApiKey: z.boolean(),
    bootImageApiKey: z.boolean(),
    bootSearchApiKey: z.boolean()
  }),
  updatedAt: z.string().nullable()
});

export const updateRuntimeSettingsRequestSchema = z.object({
  gatewayPreset: bootGatewayPresetSchema.optional(),
  bootBaseUrl: z.string().trim().url().optional(),
  bootChatBaseUrl: optionalNullableUrlSchema,
  bootEmbeddingBaseUrl: optionalNullableUrlSchema,
  bootImageBaseUrl: optionalNullableUrlSchema,
  bootSearchBaseUrl: optionalNullableUrlSchema,
  bootWikipediaApiUrl: z.string().trim().url().optional(),
  bootMoegirlApiUrl: z.string().trim().url().optional(),
  bootChatModel: z.string().trim().min(1).max(200).optional(),
  bootEmbeddingModel: z.never().optional(),
  bootImageModel: z.never().optional(),
  bootSearchProvider: bootSearchProviderSchema.optional(),
  bootSearchMaxResults: z.number().int().min(1).max(10).optional(),
  bootSearchDepth: bootSearchDepthSchema.optional(),
  bootApiKey: optionalNullableSecretSchema,
  bootChatApiKey: optionalNullableSecretSchema,
  bootEmbeddingApiKey: optionalNullableSecretSchema,
  bootImageApiKey: optionalNullableSecretSchema,
  bootSearchApiKey: optionalNullableSecretSchema
});

export type AdminRole = z.infer<typeof adminRoleSchema>;
export type AdminStatus = z.infer<typeof adminStatusSchema>;
export type TelegramChatType = z.infer<typeof telegramChatTypeSchema>;
export type TelegramChatStatus = z.infer<typeof telegramChatStatusSchema>;
export type TelegramChatPolicy = z.infer<typeof telegramChatPolicySchema>;
export type BootGatewayPreset = z.infer<typeof bootGatewayPresetSchema>;
export type BootSearchProviderName = z.infer<typeof bootSearchProviderSchema>;
export type BootSearchDepth = z.infer<typeof bootSearchDepthSchema>;
export type BootSearchChannel = z.infer<typeof bootSearchChannelSchema>;
export type BootSearchPipelineStatus = z.infer<typeof bootSearchPipelineStatusSchema>;
export type BootToolExposure = z.infer<typeof bootToolExposureSchema>;
export type BootToolCapability = z.infer<typeof bootToolCapabilitySchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type AuthMeResponse = z.infer<typeof authMeResponseSchema>;
export type AdminUserDto = z.infer<typeof adminUserSchema>;
export type CreateAdminUserRequest = z.infer<typeof createAdminUserRequestSchema>;
export type UpdateAdminUserRequest = z.infer<typeof updateAdminUserRequestSchema>;
export type AdminSessionDto = z.infer<typeof adminSessionSchema>;
export type AuditLogDto = z.infer<typeof auditLogSchema>;
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type TelegramUserDto = z.infer<typeof telegramUserSchema>;
export type TelegramChatDto = z.infer<typeof telegramChatSchema>;
export type UpdateTelegramChatRequest = z.infer<typeof updateTelegramChatRequestSchema>;
export type TelegramCommandPermissionDto = z.infer<typeof telegramCommandPermissionSchema>;
export type UpsertTelegramCommandPermissionRequest = z.infer<typeof upsertTelegramCommandPermissionRequestSchema>;
export type MessageDto = z.infer<typeof messageSchema>;
export type MemoryDto = z.infer<typeof memorySchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatResponse = z.infer<typeof chatResponseSchema>;
export type GeneratedImage = z.infer<typeof generatedImageSchema>;
export type BootToolAction = z.infer<typeof bootToolActionSchema>;
export type BootToolExecutionStatus = z.infer<typeof bootToolExecutionStatusSchema>;
export type BootToolDecision = z.infer<typeof bootToolDecisionSchema>;
export type BootToolStatus = z.infer<typeof bootToolStatusSchema>;
export type ImageGenerationRequest = z.infer<typeof imageGenerationRequestSchema>;
export type ImageGenerationResponse = z.infer<typeof imageGenerationResponseSchema>;
export type ProviderModel = z.infer<typeof providerModelSchema>;
export type ProviderModelListResponse = z.infer<typeof providerModelListResponseSchema>;
export type ChatModelListResponse = z.infer<typeof chatModelListResponseSchema>;
export type WebSearchRequest = z.infer<typeof webSearchRequestSchema>;
export type WebSearchResult = z.infer<typeof webSearchResultSchema>;
export type WebSearchResponse = z.infer<typeof webSearchResponseSchema>;
export type BootToolDescriptor = z.infer<typeof bootToolDescriptorSchema>;
export type BootToolSearchRequest = z.infer<typeof bootToolSearchRequestSchema>;
export type BootToolSearchResponse = z.infer<typeof bootToolSearchResponseSchema>;
export type CreateMemoryRequest = z.infer<typeof createMemoryRequestSchema>;
export type MemorySearchRequest = z.infer<typeof memorySearchRequestSchema>;
export type MemorySearchHitDto = z.infer<typeof memorySearchHitSchema>;
export type MemorySearchResponse = z.infer<typeof memorySearchResponseSchema>;
export type SystemStatus = z.infer<typeof systemStatusSchema>;
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export type UpdateRuntimeSettingsRequest = z.infer<typeof updateRuntimeSettingsRequestSchema>;
