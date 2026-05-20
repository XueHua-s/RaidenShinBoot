import { zValidator } from "@hono/zod-validator";
import { findAdminByUsername, markAdminLogin, revokeAdminSession, updateAdminSessionCsrf } from "@raiden/database";
import { loginRequestSchema } from "@raiden/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  auditRequestMeta,
  authMiddleware,
  clearAdminSessionCookie,
  hashOpaqueToken,
  issueAdminSession,
  randomOpaqueToken,
  setAdminSessionCookie,
  verifyPassword,
  writeAuditFromContext,
  type AuthVariables
} from "../auth.js";
import { adminUserDto, redactAdminUser } from "../serializers.js";

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const maxLoginAttempts = 8;
const loginWindowMs = 10 * 60 * 1000;
const maxTrackedLoginAttemptKeys = 1_000;

function loginAttemptKey(ipAddress: string | null, username: string) {
  return `${ipAddress ?? "unknown"}:${username.toLowerCase()}`;
}

function assertLoginAllowed(key: string) {
  const now = Date.now();
  if (loginAttempts.size > maxTrackedLoginAttemptKeys) {
    for (const [attemptKey, attempt] of loginAttempts) {
      if (attempt.resetAt <= now) {
        loginAttempts.delete(attemptKey);
      }
    }
  }

  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 0, resetAt: now + loginWindowMs });
    return;
  }

  if (current.count >= maxLoginAttempts) {
    throw new HTTPException(429, { message: "Too many login attempts" });
  }
}

function recordFailedLogin(key: string) {
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + loginWindowMs });
    return;
  }

  current.count += 1;
}

export const authRoute = new Hono<{ Variables: AuthVariables }>()
  .post("/login", zValidator("json", loginRequestSchema), async (c) => {
    const body = c.req.valid("json");
    const meta = auditRequestMeta(c);
    const attemptKey = loginAttemptKey(meta.ipAddress, body.username);
    assertLoginAllowed(attemptKey);

    const admin = await findAdminByUsername(body.username);
    const isValid = admin && admin.status === "active" && (await verifyPassword(body.password, admin.passwordHash));

    if (!isValid) {
      recordFailedLogin(attemptKey);
      await writeAuditFromContext(c, {
        actorAdminId: null,
        action: "auth.login_failed",
        targetType: "admin_user",
        targetId: admin?.id ?? body.username,
        after: { username: body.username }
      });
      throw new HTTPException(401, { message: "Invalid username or password" });
    }

    loginAttempts.delete(attemptKey);
    const { session, token, csrfToken } = await issueAdminSession(admin.id);
    setAdminSessionCookie(c, token, session.expiresAt);
    await markAdminLogin(admin.id);
    await writeAuditFromContext(c, {
      actorAdminId: admin.id,
      action: "auth.login",
      targetType: "admin_user",
      targetId: admin.id
    });

    return c.json({
      user: redactAdminUser({ ...admin, lastLoginAt: new Date() }),
      csrfToken
    });
  })
  .get("/me", authMiddleware, async (c) => {
    const csrfToken = randomOpaqueToken();
    const session = c.get("adminSession");
    await updateAdminSessionCsrf(session.id, hashOpaqueToken(csrfToken));

    return c.json({
      user: adminUserDto(c.get("admin")),
      csrfToken
    });
  })
  .post("/logout", authMiddleware, async (c) => {
    const session = c.get("adminSession");
    await revokeAdminSession(session.id);
    clearAdminSessionCookie(c);
    await writeAuditFromContext(c, {
      action: "auth.logout",
      targetType: "admin_session",
      targetId: session.id
    });

    return c.json({ ok: true });
  });
