import { zValidator } from "@hono/zod-validator";
import { webSearchRequestSchema } from "@raiden/shared";
import { executeBootTool, listBootTools } from "@raiden/shared/tools";
import { Hono } from "hono";

export const searchRoute = new Hono()
  .get("/tools", (c) => c.json({ tools: listBootTools() }))
  .post("/", zValidator("json", webSearchRequestSchema), async (c) => {
    const body = c.req.valid("json");
    const result = await executeBootTool("web_search", body);
    return c.json(result);
  });
