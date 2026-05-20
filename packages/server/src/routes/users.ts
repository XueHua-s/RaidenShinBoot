import { zValidator } from "@hono/zod-validator";
import { countTelegramUsers, listTelegramUsers } from "@raiden/database";
import { paginationQuerySchema } from "@raiden/shared";
import { Hono } from "hono";
import { requirePermission, type AuthVariables } from "../auth.js";

export const usersRoute = new Hono<{ Variables: AuthVariables }>().get("/", zValidator("query", paginationQuerySchema), async (c) => {
  requirePermission(c, "telegram:read");
  const query = c.req.valid("query");
  const [data, total] = await Promise.all([listTelegramUsers(query), countTelegramUsers()]);

  return c.json({ data, total });
});
