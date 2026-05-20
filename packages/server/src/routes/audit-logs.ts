import { zValidator } from "@hono/zod-validator";
import { countAuditLogs, listAuditLogs } from "@raiden/database";
import { paginationQuerySchema } from "@raiden/shared";
import { Hono } from "hono";
import { requirePermission, type AuthVariables } from "../auth.js";

export const auditLogsRoute = new Hono<{ Variables: AuthVariables }>().get(
  "/",
  zValidator("query", paginationQuerySchema),
  async (c) => {
    requirePermission(c, "audit:read");
    const query = c.req.valid("query");
    const [data, total] = await Promise.all([listAuditLogs(query), countAuditLogs()]);

    return c.json({ data, total });
  }
);
