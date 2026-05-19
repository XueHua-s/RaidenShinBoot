import { z } from "zod";

const serverEnvSchema = z.object({
  SERVER_HOST: z.string().default("0.0.0.0"),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_URL: z.string().optional()
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function getServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  return serverEnvSchema.parse(env);
}

