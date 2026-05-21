import { zValidator } from "@hono/zod-validator";
import { executeEffectiveBootTool } from "@raiden/boot";
import { imageGenerationRequestSchema } from "@raiden/shared";
import { formatBootToolError, getBootToolErrorStatus } from "@raiden/shared/tools";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requirePermission, type AuthVariables } from "../auth.js";

export const imagesRoute = new Hono<{ Variables: AuthVariables }>().post("/", zValidator("json", imageGenerationRequestSchema), async (c) => {
  const admin = requirePermission(c, "conversation:write");
  const body = c.req.valid("json");

  try {
    const result = await executeEffectiveBootTool("makoto_image", body, {
      permission: {
        actorId: admin.id,
        chatId: null
      }
    });

    return c.json(result);
  } catch (error) {
    return c.json({ error: formatBootToolError(error) }, getBootToolErrorStatus(error) as ContentfulStatusCode);
  }
});
