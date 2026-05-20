import { scrypt as scryptCallback, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AdminRole } from "@raiden/shared";
import {
  createAdminSession,
  createAuditLog,
  findAdminSessionByTokenHash,
  revokeAdminSession
} from "@raiden/database";
import type { AdminSession, AdminUser } from "@raiden/database";

const scrypt = promisify(scryptCallback);
const passwordVersion = "scrypt-v1";
const scryptKeyLength = 64;
const sessionTtlHours = Number(process.env.ADMIN_SESSION_TTL_HOURS ?? "8");

export const csrfHeaderName = "x-csrf-token";
export const sessionCookieName = process.env.ADMIN_SESSION_COOKIE_NAME ?? "raiden_admin_session";

export type Permission =
  | "admin:read"
  | "admin:write"
  | "session:read"
  | "session:revoke"
  | "telegram:read"
  | "telegram:moderate"
  | "conversation:read"
  | "conversation:write"
  | "memory:read"
  | "memory:write"
  | "audit:read"
  | "system:read"
  | "system:write";

export type AuthenticatedAdmin = Omit<AdminUser, "passwordHash">;

export type AuthVariables = {
  admin: AuthenticatedAdmin;
  adminSession: AdminSession;
};

const rolePermissions: Record<AdminRole, Set<Permission>> = {
  super_admin: new Set<Permission>([
    "admin:read",
    "admin:write",
    "session:read",
    "session:revoke",
    "telegram:read",
    "telegram:moderate",
    "conversation:read",
    "conversation:write",
    "memory:read",
    "memory:write",
    "audit:read",
    "system:read",
    "system:write"
  ]),
  operator: new Set<Permission>([
    "telegram:read",
    "telegram:moderate",
    "conversation:read",
    "conversation:write",
    "memory:read",
    "memory:write",
    "audit:read",
    "system:read"
  ]),
  auditor: new Set<Permission>(["telegram:read", "conversation:read", "memory:read", "audit:read", "system:read"])
};

function base64Url(buffer: Buffer) {
  return buffer.toString("base64url");
}

function hashToken(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function safeEqualString(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function publicAdmin(user: AdminUser): AuthenticatedAdmin {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}

function shouldUseSecureCookie() {
  return process.env.NODE_ENV === "production" || process.env.ADMIN_SECURE_COOKIES === "true";
}

export function hashOpaqueToken(value: string) {
  return hashToken(value);
}

export function randomOpaqueToken() {
  return base64Url(randomBytes(32));
}

export async function hashPassword(password: string) {
  const salt = randomBytes(24);
  const derived = (await scrypt(password, salt, scryptKeyLength)) as Buffer;

  return [passwordVersion, base64Url(salt), base64Url(derived)].join("$");
}

export async function verifyPassword(password: string, storedHash: string) {
  const [version, saltValue, hashValue] = storedHash.split("$");
  if (version !== passwordVersion || !saltValue || !hashValue) {
    return false;
  }

  const salt = Buffer.from(saltValue, "base64url");
  const expected = Buffer.from(hashValue, "base64url");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function issueAdminSession(adminUserId: string) {
  const token = randomOpaqueToken();
  const csrfToken = randomOpaqueToken();
  const expiresAt = new Date(Date.now() + sessionTtlHours * 60 * 60 * 1000);
  const session = await createAdminSession({
    adminUserId,
    tokenHash: hashToken(token),
    csrfTokenHash: hashToken(csrfToken),
    expiresAt
  });

  return {
    session,
    token,
    csrfToken
  };
}

export function setAdminSessionCookie(c: Context, token: string, expiresAt: Date) {
  setCookie(c, sessionCookieName, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: shouldUseSecureCookie(),
    path: "/",
    expires: expiresAt,
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
  });
}

export function clearAdminSessionCookie(c: Context) {
  deleteCookie(c, sessionCookieName, {
    path: "/"
  });
}

export function hasPermission(role: AdminRole, permission: Permission) {
  return rolePermissions[role].has(permission);
}

export function requirePermission(c: Context<{ Variables: AuthVariables }>, permission: Permission) {
  const admin = c.get("admin");
  if (!hasPermission(admin.role, permission)) {
    throw new HTTPException(403, { message: "Forbidden" });
  }

  return admin;
}

export function auditRequestMeta(c: Context) {
  const forwardedFor = c.req.header("x-forwarded-for");
  return {
    ipAddress: forwardedFor?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? null,
    userAgent: c.req.header("user-agent") ?? null
  };
}

export async function writeAuditFromContext(
  c: Context<{ Variables: AuthVariables }>,
  input: {
    action: string;
    targetType: string;
    targetId?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    actorAdminId?: string | null;
  }
) {
  let admin: AuthenticatedAdmin | undefined;
  try {
    admin = c.get("admin");
  } catch {
    admin = undefined;
  }
  await createAuditLog({
    actorAdminId: input.actorAdminId ?? admin?.id ?? null,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    ...auditRequestMeta(c)
  });
}

export const authMiddleware: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const token = getCookie(c, sessionCookieName);
  if (!token) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const record = await findAdminSessionByTokenHash(hashToken(token));
  if (!record || record.session.revokedAt || record.session.expiresAt <= new Date() || record.admin.status !== "active") {
    if (record?.session && !record.session.revokedAt) {
      await revokeAdminSession(record.session.id);
    }
    clearAdminSessionCookie(c);
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const csrfToken = c.req.header(csrfHeaderName);
    if (!csrfToken || !safeEqualString(hashToken(csrfToken), record.session.csrfTokenHash)) {
      throw new HTTPException(403, { message: "Invalid CSRF token" });
    }
  }

  c.set("admin", publicAdmin(record.admin));
  c.set("adminSession", record.session);
  await next();
};
