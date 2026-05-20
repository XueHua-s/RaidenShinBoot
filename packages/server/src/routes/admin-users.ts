import { zValidator } from "@hono/zod-validator";
import {
  countAdminUsers,
  createAdminUser,
  findAdminByUsername,
  listAdminUsers,
  updateAdminUserWithSuperAdminGuard
} from "@raiden/database";
import { createAdminUserRequestSchema, paginationQuerySchema, updateAdminUserRequestSchema } from "@raiden/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { hashPassword, requirePermission, writeAuditFromContext, type AuthVariables } from "../auth.js";
import { redactAdminUser } from "../serializers.js";

function isUniqueConstraintViolation(error: unknown, constraintName: string) {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { code?: unknown; constraint_name?: unknown; constraint?: unknown }).code === "23505" &&
    ((error as { constraint_name?: unknown }).constraint_name === constraintName ||
      (error as { constraint?: unknown }).constraint === constraintName)
  );
}

export const adminUsersRoute = new Hono<{ Variables: AuthVariables }>()
  .get("/", zValidator("query", paginationQuerySchema), async (c) => {
    requirePermission(c, "admin:read");
    const query = c.req.valid("query");
    const [data, total] = await Promise.all([listAdminUsers(query), countAdminUsers()]);

    return c.json({ data, total });
  })
  .post("/", zValidator("json", createAdminUserRequestSchema), async (c) => {
    requirePermission(c, "admin:write");
    const body = c.req.valid("json");
    const existing = await findAdminByUsername(body.username);
    if (existing) {
      throw new HTTPException(409, { message: "Admin username already exists" });
    }

    let admin: Awaited<ReturnType<typeof createAdminUser>>;
    try {
      admin = await createAdminUser({
        username: body.username,
        displayName: body.displayName ?? null,
        passwordHash: await hashPassword(body.password),
        role: body.role,
        status: "active"
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error, "admin_users_username_idx")) {
        throw new HTTPException(409, { message: "Admin username already exists" });
      }
      throw error;
    }
    await writeAuditFromContext(c, {
      action: "admin_user.create",
      targetType: "admin_user",
      targetId: admin.id,
      after: redactAdminUser(admin)
    });

    return c.json({ data: redactAdminUser(admin) }, 201);
  })
  .patch("/:id", zValidator("json", updateAdminUserRequestSchema), async (c) => {
    requirePermission(c, "admin:write");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const updates: Parameters<typeof updateAdminUserWithSuperAdminGuard>[1] = {};
    if (body.displayName !== undefined) {
      updates.displayName = body.displayName;
    }
    if (body.password) {
      updates.passwordHash = await hashPassword(body.password);
    }
    if (body.role !== undefined) {
      updates.role = body.role;
    }
    if (body.status !== undefined) {
      updates.status = body.status;
    }

    const result = await updateAdminUserWithSuperAdminGuard(id, updates);
    if (!result.before) {
      throw new HTTPException(404, { message: "Admin user not found" });
    }
    if (result.blockedLastActiveSuperAdmin) {
      throw new HTTPException(400, { message: "At least one active super admin is required" });
    }
    if (!result.after) {
      throw new HTTPException(404, { message: "Admin user not found" });
    }

    await writeAuditFromContext(c, {
      action: "admin_user.update",
      targetType: "admin_user",
      targetId: id,
      before: redactAdminUser(result.before),
      after: redactAdminUser(result.after)
    });

    return c.json({ data: redactAdminUser(result.after) });
  });
