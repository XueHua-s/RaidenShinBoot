import { z } from "zod";

const botEnvSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required")
});

export function getBotEnv(env: NodeJS.ProcessEnv = process.env) {
  return botEnvSchema.parse(env);
}

