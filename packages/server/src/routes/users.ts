import { zValidator } from "@hono/zod-validator";
import { countTelegramUsers, listTelegramUsers } from "@raiden/database";
import { paginationQuerySchema } from "@raiden/shared";
import { Hono } from "hono";

export const usersRoute = new Hono().get("/", zValidator("query", paginationQuerySchema), async (c) => {
  const query = c.req.valid("query");
  const [data, total] = await Promise.all([listTelegramUsers(query), countTelegramUsers()]);

  return c.json({ data, total });
});

