import { zValidator } from "@hono/zod-validator";
import { executeEffectiveBootTool } from "@raiden/boot";
import { bootToolSearchRequestSchema, webSearchRequestSchema } from "@raiden/shared";
import { formatBootToolError, getBootToolErrorStatus, listBootTools, searchBootTools } from "@raiden/shared/tools";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requirePermission, type AuthVariables } from "../auth.js";

export const searchRoute = new Hono<{ Variables: AuthVariables }>()
  .get("/tools", (c) => {
    requirePermission(c, "system:read");
    return c.json({ tools: listBootTools() });
  })
  .post("/tools/search", zValidator("json", bootToolSearchRequestSchema), (c) => {
    requirePermission(c, "system:read");
    return c.json(searchBootTools(c.req.valid("json")));
  })
  .post("/", zValidator("json", webSearchRequestSchema), async (c) => {
    const admin = requirePermission(c, "conversation:write");
    const body = c.req.valid("json");
    try {
      const result = await executeEffectiveBootTool("web_search", body, {
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
