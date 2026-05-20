import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { BootProviderError } from "@raiden/shared/boot";
import { authMiddleware, type AuthVariables } from "./auth.js";
import { adminSessionsRoute } from "./routes/admin-sessions.js";
import { adminUsersRoute } from "./routes/admin-users.js";
import { auditLogsRoute } from "./routes/audit-logs.js";
import { authRoute } from "./routes/auth.js";
import { chatRoute } from "./routes/chat.js";
import { imagesRoute } from "./routes/images.js";
import { memoriesRoute } from "./routes/memories.js";
import { messagesRoute } from "./routes/messages.js";
import { searchRoute } from "./routes/search.js";
import { healthStatusPayload, systemRoute } from "./routes/system.js";
import { telegramRoute } from "./routes/telegram.js";
import { usersRoute } from "./routes/users.js";

function corsOrigin(origin: string) {
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
    return origin;
  }

  return null;
}

const api = new Hono<{ Variables: AuthVariables }>()
  .get("/health", (c) => c.json(healthStatusPayload()))
  .route("/auth", authRoute)
  .use("*", authMiddleware)
  .route("/admin-users", adminUsersRoute)
  .route("/admin-sessions", adminSessionsRoute)
  .route("/audit-logs", auditLogsRoute)
  .route("/telegram", telegramRoute)
  .route("/system", systemRoute)
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
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"]
    })
  )
  .route("/api", api)
  .notFound((c) => c.json({ error: "Not found" }, 404))
  .onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: error.message }, error.status);
    }
    if (error instanceof BootProviderError) {
      return c.json({ error: error.message }, error.statusCode as 500);
    }

    console.error(error);
    return c.json(
      {
        error: "Internal server error"
      },
      500
    );
  });

export type AppType = typeof app;
