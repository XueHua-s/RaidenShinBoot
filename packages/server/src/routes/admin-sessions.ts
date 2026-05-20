import { zValidator } from "@hono/zod-validator";
import { countAdminSessions, listAdminSessions, revokeAdminSession } from "@raiden/database";
import { paginationQuerySchema } from "@raiden/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requirePermission, writeAuditFromContext, type AuthVariables } from "../auth.js";

export const adminSessionsRoute = new Hono<{ Variables: AuthVariables }>()
  .get("/", zValidator("query", paginationQuerySchema), async (c) => {
    requirePermission(c, "session:read");
    const query = c.req.valid("query");
    const [data, total] = await Promise.all([listAdminSessions(query), countAdminSessions()]);

    return c.json({ data, total });
  })
  .delete("/:id", async (c) => {
    requirePermission(c, "session:revoke");
    const id = c.req.param("id");
    const session = await revokeAdminSession(id);
    if (!session) {
      throw new HTTPException(404, { message: "Admin session not found" });
    }

    await writeAuditFromContext(c, {
      action: "admin_session.revoke",
      targetType: "admin_session",
      targetId: id
    });

    return c.json({ data: session });
  });
