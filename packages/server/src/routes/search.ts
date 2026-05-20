import { zValidator } from "@hono/zod-validator";
import { webSearchRequestSchema } from "@raiden/shared";
import { formatBootSearchError, getBootSearchErrorStatus } from "@raiden/shared/search";
import { executeBootTool, listBootTools } from "@raiden/shared/tools";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { requirePermission, type AuthVariables } from "../auth.js";
import { getEffectiveBootSearchConfig } from "../runtime-config.js";

export const searchRoute = new Hono<{ Variables: AuthVariables }>()
  .get("/tools", (c) => {
    requirePermission(c, "system:read");
    return c.json({ tools: listBootTools() });
  })
  .post("/", zValidator("json", webSearchRequestSchema), async (c) => {
    requirePermission(c, "conversation:write");
    const body = c.req.valid("json");
    try {
      const result = await executeBootTool("web_search", body, { searchConfig: await getEffectiveBootSearchConfig() });
      return c.json(result);
    } catch (error) {
      return c.json({ error: formatBootSearchError(error) }, getBootSearchErrorStatus(error) as ContentfulStatusCode);
    }
  });
