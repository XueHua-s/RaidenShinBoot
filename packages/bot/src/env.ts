import { z } from "zod";

const botEnvSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  BOT_POLLING_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(8),
  BOT_UPDATE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000)
});

export function getBotEnv(env: NodeJS.ProcessEnv = process.env) {
  return botEnvSchema.parse(env);
}
