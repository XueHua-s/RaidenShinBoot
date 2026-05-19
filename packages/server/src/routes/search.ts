import { zValidator } from "@hono/zod-validator";
import { webSearchRequestSchema } from "@raiden/shared";
import { formatBootSearchError, getBootSearchErrorStatus } from "@raiden/shared/search";
import { executeBootTool, listBootTools } from "@raiden/shared/tools";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const searchRoute = new Hono()
  .get("/tools", (c) => c.json({ tools: listBootTools() }))
  .post("/", zValidator("json", webSearchRequestSchema), async (c) => {
    const body = c.req.valid("json");
    try {
      const result = await executeBootTool("web_search", body);
      return c.json(result);
    } catch (error) {
      return c.json({ error: formatBootSearchError(error) }, getBootSearchErrorStatus(error) as ContentfulStatusCode);
    }
  });
