import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { chatRoute } from "./routes/chat.js";
import { memoriesRoute } from "./routes/memories.js";
import { messagesRoute } from "./routes/messages.js";
import { usersRoute } from "./routes/users.js";

const api = new Hono()
  .get("/health", (c) =>
    c.json({
      ok: true,
      service: "raiden-shin-server",
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      bootBaseUrl: process.env.BOOT_BASE_URL ?? "https://xhblog.top:3000/v1"
    })
  )
  .route("/users", usersRoute)
  .route("/messages", messagesRoute)
  .route("/memories", memoriesRoute)
  .route("/chat", chatRoute);

export const app = new Hono()
  .use("*", logger())
  .use(
    "*",
    cors({
      origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"]
    })
  )
  .route("/api", api)
  .notFound((c) => c.json({ error: "Not found" }, 404))
  .onError((error, c) => {
    console.error(error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error"
      },
      500
    );
  });

export type AppType = typeof app;

