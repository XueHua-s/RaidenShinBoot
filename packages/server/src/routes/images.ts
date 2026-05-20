import { zValidator } from "@hono/zod-validator";
import { imageGenerationRequestSchema } from "@raiden/shared";
import { generateMakotoImage } from "@raiden/shared/boot";
import { Hono } from "hono";
import { requirePermission, type AuthVariables } from "../auth.js";
import { getEffectiveBootConfig } from "../runtime-config.js";

export const imagesRoute = new Hono<{ Variables: AuthVariables }>().post("/", zValidator("json", imageGenerationRequestSchema), async (c) => {
  requirePermission(c, "conversation:write");
  const body = c.req.valid("json");
  const result = await generateMakotoImage({
    prompt: body.prompt,
    size: body.size as `${number}x${number}`,
    n: body.n,
    config: await getEffectiveBootConfig()
  });

  return c.json(result);
});
