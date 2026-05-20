import type { AdminUser } from "@raiden/database";

function iso(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : value;
}

export function adminUserDto(user: Omit<AdminUser, "passwordHash">) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    lastLoginAt: iso(user.lastLoginAt),
    createdAt: iso(user.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(user.updatedAt) ?? new Date(0).toISOString()
  };
}

export function redactAdminUser(user: AdminUser) {
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return adminUserDto(safeUser);
}
