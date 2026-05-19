import { zValidator } from "@hono/zod-validator";
import { imageGenerationRequestSchema } from "@raiden/shared";
import { generateMakotoImage } from "@raiden/shared/boot";
import { Hono } from "hono";

export const imagesRoute = new Hono().post("/", zValidator("json", imageGenerationRequestSchema), async (c) => {
  const body = c.req.valid("json");
  const result = await generateMakotoImage({
    prompt: body.prompt,
    size: body.size as `${number}x${number}`,
    n: body.n
  });

  return c.json(result);
});
