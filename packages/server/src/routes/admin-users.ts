import { zValidator } from "@hono/zod-validator";
import {
  countActiveSuperAdmins,
  countAdminUsers,
  createAdminUser,
  findAdminById,
  findAdminByUsername,
  listAdminUsers,
  updateAdminUser
} from "@raiden/database";
import { createAdminUserRequestSchema, paginationQuerySchema, updateAdminUserRequestSchema } from "@raiden/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { hashPassword, requirePermission, writeAuditFromContext, type AuthVariables } from "../auth.js";
import { redactAdminUser } from "../serializers.js";

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

    const admin = await createAdminUser({
      username: body.username,
      displayName: body.displayName ?? null,
      passwordHash: await hashPassword(body.password),
      role: body.role,
      status: "active"
    });
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
    const before = await findAdminById(id);
    if (!before) {
      throw new HTTPException(404, { message: "Admin user not found" });
    }

    const wouldLoseActiveSuperAdmin =
      before.role === "super_admin" &&
      ((body.role !== undefined && body.role !== "super_admin") || body.status === "disabled");
    if (wouldLoseActiveSuperAdmin && (await countActiveSuperAdmins()) <= 1) {
      throw new HTTPException(400, { message: "At least one active super admin is required" });
    }

    const updates: Parameters<typeof updateAdminUser>[1] = {};
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

    const updated = await updateAdminUser(id, updates);
    if (!updated) {
      throw new HTTPException(404, { message: "Admin user not found" });
    }

    await writeAuditFromContext(c, {
      action: "admin_user.update",
      targetType: "admin_user",
      targetId: id,
      before: redactAdminUser(before),
      after: redactAdminUser(updated)
    });

    return c.json({ data: redactAdminUser(updated) });
  });
