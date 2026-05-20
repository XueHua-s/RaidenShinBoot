import { config } from "dotenv";
import { closeDatabase, createAdminUser, createAuditLog, findAdminByUsername } from "@raiden/database";
import { hashPassword } from "../auth.js";

config({ path: new URL("../../../../.env", import.meta.url) });
config();

async function main() {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  const displayName = process.env.ADMIN_DISPLAY_NAME?.trim() || "Owner";

  if (!username || !password) {
    throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD are required to bootstrap the first admin");
  }

  if (password.length < 12) {
    throw new Error("ADMIN_PASSWORD must be at least 12 characters");
  }

  const existing = await findAdminByUsername(username);
  if (existing) {
    console.log(`Admin '${username}' already exists; bootstrap skipped.`);
    return;
  }

  const admin = await createAdminUser({
    username,
    displayName,
    passwordHash: await hashPassword(password),
    role: "super_admin",
    status: "active"
  });
  await createAuditLog({
    actorAdminId: admin.id,
    action: "admin_user.bootstrap",
    targetType: "admin_user",
    targetId: admin.id,
    after: {
      id: admin.id,
      username: admin.username,
      role: admin.role,
      status: admin.status
    }
  });

  console.log(`Created super admin '${username}'.`);
}

try {
  await main();
} finally {
  await closeDatabase();
}
