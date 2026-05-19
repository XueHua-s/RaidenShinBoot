import { z } from "zod";

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0)
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

export const messageSchema = z.object({
  id: z.string(),
  telegramUserId: z.string(),
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

export const chatResponseSchema = z.object({
  reply: z.string(),
  memoryCount: z.number().int().min(0)
});

export const imageGenerationRequestSchema = z.object({
  prompt: z.string().min(1).max(2000),
  size: z
    .string()
    .regex(/^\d+x\d+$/, "size must use WIDTHxHEIGHT format")
    .default("1024x1024"),
  n: z.number().int().min(1).max(4).default(1)
});

export const generatedImageSchema = z.object({
  base64: z.string(),
  mediaType: z.string()
});

export const imageGenerationResponseSchema = z.object({
  images: z.array(generatedImageSchema).min(1),
  warnings: z.array(z.string())
});

export const createMemoryRequestSchema = z.object({
  telegramUserId: z.string().min(1),
  summary: z.string().min(1).max(2000),
  importance: z.number().int().min(1).max(10).default(5)
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type TelegramUserDto = z.infer<typeof telegramUserSchema>;
export type MessageDto = z.infer<typeof messageSchema>;
export type MemoryDto = z.infer<typeof memorySchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatResponse = z.infer<typeof chatResponseSchema>;
export type ImageGenerationRequest = z.infer<typeof imageGenerationRequestSchema>;
export type ImageGenerationResponse = z.infer<typeof imageGenerationResponseSchema>;
export type CreateMemoryRequest = z.infer<typeof createMemoryRequestSchema>;
