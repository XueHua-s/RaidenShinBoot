import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { chatRoute } from "./routes/chat.js";
import { imagesRoute } from "./routes/images.js";
import { memoriesRoute } from "./routes/memories.js";
import { messagesRoute } from "./routes/messages.js";
import { searchRoute } from "./routes/search.js";
import { usersRoute } from "./routes/users.js";

function corsOrigin(origin: string) {
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
    return origin;
  }

  return null;
}

const api = new Hono()
  .get("/health", (c) =>
    c.json({
      ok: true,
      service: "raiden-shin-server",
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      bootBaseUrl: process.env.BOOT_BASE_URL ?? "https://proxy.xhblog.top:3000/v1",
      bootChatBaseUrl: process.env.BOOT_CHAT_BASE_URL ?? process.env.BOOT_BASE_URL ?? "https://proxy.xhblog.top:3000/v1",
      bootEmbeddingBaseUrl: process.env.BOOT_EMBEDDING_BASE_URL ?? process.env.BOOT_BASE_URL ?? null,
      bootImageBaseUrl: process.env.BOOT_IMAGE_BASE_URL ?? process.env.BOOT_BASE_URL ?? null,
      bootSearchProvider: process.env.BOOT_SEARCH_PROVIDER ?? "disabled"
    })
  )
  .route("/users", usersRoute)
  .route("/messages", messagesRoute)
  .route("/memories", memoriesRoute)
  .route("/images", imagesRoute)
  .route("/search", searchRoute)
  .route("/chat", chatRoute);

export const app = new Hono()
  .use("*", logger())
  .use(
    "*",
    cors({
      origin: corsOrigin,
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
