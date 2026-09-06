import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, notInArray, or, sql } from "drizzle-orm";
import { getDatabase } from "./client.js";
import {
  adminSessions,
  adminUsers,
  auditLogs,
  conversations,
  memories,
  messages,
  runtimeSettings,
  telegramChats,
  telegramChatMembers,
  telegramCommandPermissions,
  telegramUsers
} from "./schema.js";
import type {
  AdminUser,
  NewAdminSession,
  NewAdminUser,
  NewRuntimeSetting,
  NewMessage,
  RuntimeSetting,
  NewTelegramChat,
  NewTelegramChatMember,
  NewTelegramCommandPermission,
  NewTelegramUser
} from "./schema.js";

export type PaginationInput = {
  limit?: number;
  offset?: number;
};

export type ConversationScopeInput = {
  protocol: string;
  scopeKey: string;
  telegramUserId: string | null;
  chatId?: string | null;
  threadId?: string | null;
  personaId?: string | null;
  personaVersion?: number | null;
  personaHash?: string | null;
};

export type MemorySearchHit = {
  id: string;
  telegramUserId: string;
  summary: string;
  importance: number;
  scope: "persona_global" | "chat_shared" | "user_private" | "user_in_chat";
  kind: "fact" | "event" | "preference";
  sourceChatId: string | null;
  sourceThreadId: string | null;
  subjectUserId: string | null;
  confidence: number;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  sourceMessageId: string | null;
  createdAt: Date;
  lastAccessedAt: Date | null;
  distance: number;
  score: number;
};

export type RuntimeSettingsChangeSet = {
  deletes?: string[];
  upserts?: NewRuntimeSetting[];
};

export type AuditLogInput = {
  actorAdminId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

const defaultPagination = {
  limit: 20,
  offset: 0
};
const reservedTelegramCommandNames = new Set(["model"]);
const hiddenTelegramCommandNames = [...reservedTelegramCommandNames, "/model"];

const encryptedValuePrefix = "aes-256-gcm:v1";

function toIsoDate<
  T extends {
    createdAt?: Date;
    updatedAt?: Date;
    firstSeenAt?: Date;
    lastAccessedAt?: Date | null;
    lastLoginAt?: Date | null;
    expiresAt?: Date;
    revokedAt?: Date | null;
    embeddedAt?: Date | null;
    deletedAt?: Date | null;
  }
>(row: T) {
  return {
    ...row,
    createdAt: row.createdAt?.toISOString(),
    updatedAt: row.updatedAt?.toISOString(),
    firstSeenAt: row.firstSeenAt?.toISOString(),
    lastAccessedAt: row.lastAccessedAt?.toISOString() ?? null,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    embeddedAt: row.embeddedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null
  };
}

export function vectorLiteral(values: number[]) {
  return `[${values.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

function runtimeSettingsEncryptionKey() {
  const secret = process.env.BOOT_SETTINGS_ENCRYPTION_KEY?.trim();
  if (!secret) {
    return null;
  }

  return createHash("sha256").update(secret).digest();
}

export function isRuntimeSettingsSecretStorageReady() {
  return Boolean(runtimeSettingsEncryptionKey());
}

export function encryptRuntimeSettingValue(value: string) {
  const key = runtimeSettingsEncryptionKey();
  if (!key) {
    throw new Error("BOOT_SETTINGS_ENCRYPTION_KEY is required to store secret runtime settings");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [encryptedValuePrefix, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptRuntimeSettingValue(value: string) {
  const key = runtimeSettingsEncryptionKey();
  if (!key) {
    return null;
  }

  const [prefix, version, ivValue, tagValue, encryptedValue] = value.split(":");
  if (`${prefix}:${version}` !== encryptedValuePrefix || !ivValue || !tagValue || !encryptedValue) {
    return null;
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export async function createAdminUser(input: NewAdminUser) {
  const db = getDatabase();
  const [user] = await db.insert(adminUsers).values(input).returning();
  if (!user) {
    throw new Error("Failed to create admin user");
  }

  return user;
}

export async function findAdminByUsername(username: string) {
  const db = getDatabase();
  const [user] = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.username, username))
    .limit(1);

  return user ?? null;
}

export async function findAdminById(id: string) {
  const db = getDatabase();
  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
  return user ?? null;
}

export async function listAdminUsers(input: PaginationInput = defaultPagination) {
  const db = getDatabase();
  const limit = input.limit ?? defaultPagination.limit;
  const offset = input.offset ?? defaultPagination.offset;
  const rows = await db
    .select({
      id: adminUsers.id,
      username: adminUsers.username,
      displayName: adminUsers.displayName,
      role: adminUsers.role,
      status: adminUsers.status,
      lastLoginAt: adminUsers.lastLoginAt,
      createdAt: adminUsers.createdAt,
      updatedAt: adminUsers.updatedAt
    })
    .from(adminUsers)
    .orderBy(desc(adminUsers.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map(toIsoDate);
}

export async function countAdminUsers() {
  const db = getDatabase();
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(adminUsers);
  return row?.count ?? 0;
}

export async function countActiveSuperAdmins() {
  const db = getDatabase();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(adminUsers)
    .where(and(eq(adminUsers.role, "super_admin"), eq(adminUsers.status, "active")));

  return row?.count ?? 0;
}

export async function updateAdminUser(
  id: string,
  input: Partial<Pick<AdminUser, "displayName" | "passwordHash" | "role" | "status">>
) {
  const db = getDatabase();
  const [user] = await db
    .update(adminUsers)
    .set({
      ...input,
      updatedAt: new Date()
    })
    .where(eq(adminUsers.id, id))
    .returning();

  return user ?? null;
}

export async function updateAdminUserWithSuperAdminGuard(
  id: string,
  input: Partial<Pick<AdminUser, "displayName" | "passwordHash" | "role" | "status">>
) {
  const db = getDatabase();

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(918273645)`);

    const [before] = await tx.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
    if (!before) {
      return {
        before: null,
        after: null,
        blockedLastActiveSuperAdmin: false
      };
    }

    const wouldLoseActiveSuperAdmin =
      before.role === "super_admin" &&
      before.status === "active" &&
      ((input.role !== undefined && input.role !== "super_admin") || input.status === "disabled");
    if (wouldLoseActiveSuperAdmin) {
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(adminUsers)
        .where(and(eq(adminUsers.role, "super_admin"), eq(adminUsers.status, "active")));

      if ((row?.count ?? 0) <= 1) {
        return {
          before,
          after: null,
          blockedLastActiveSuperAdmin: true
        };
      }
    }

    const [after] = await tx
      .update(adminUsers)
      .set({
        ...input,
        updatedAt: new Date()
      })
      .where(eq(adminUsers.id, id))
      .returning();

    return {
      before,
      after: after ?? null,
      blockedLastActiveSuperAdmin: false
    };
  });
}

export async function markAdminLogin(id: string) {
  const db = getDatabase();
  await db
    .update(adminUsers)
    .set({
      lastLoginAt: new Date(),
      updatedAt: new Date()
    })
    .where(eq(adminUsers.id, id));
}

export async function createAdminSession(input: NewAdminSession) {
  const db = getDatabase();
  const [session] = await db.insert(adminSessions).values(input).returning();
  if (!session) {
    throw new Error("Failed to create admin session");
  }

  return session;
}

export async function findAdminSessionByTokenHash(tokenHash: string) {
  const db = getDatabase();
  const [row] = await db
    .select({
      session: adminSessions,
      admin: adminUsers
    })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminSessions.adminUserId, adminUsers.id))
    .where(eq(adminSessions.tokenHash, tokenHash))
    .limit(1);

  return row ?? null;
}

export async function revokeAdminSession(id: string) {
  const db = getDatabase();
  const [session] = await db
    .update(adminSessions)
    .set({ revokedAt: new Date() })
    .where(eq(adminSessions.id, id))
    .returning();

  return session ?? null;
}

export async function updateAdminSessionCsrf(id: string, csrfTokenHash: string) {
  const db = getDatabase();
  const [session] = await db
    .update(adminSessions)
    .set({ csrfTokenHash })
    .where(eq(adminSessions.id, id))
    .returning();

  return session ?? null;
}

export async function listAdminSessions(input: PaginationInput = defaultPagination) {
  const db = getDatabase();
  const limit = input.limit ?? defaultPagination.limit;
  const offset = input.offset ?? defaultPagination.offset;
  const rows = await db
    .select({
      id: adminSessions.id,
      adminUserId: adminSessions.adminUserId,
      username: adminUsers.username,
      role: adminUsers.role,
      expiresAt: adminSessions.expiresAt,
      revokedAt: adminSessions.revokedAt,
      createdAt: adminSessions.createdAt
    })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminSessions.adminUserId, adminUsers.id))
    .orderBy(desc(adminSessions.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map(toIsoDate);
}

export async function countAdminSessions() {
  const db = getDatabase();
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(adminSessions);
  return row?.count ?? 0;
}

export async function createAuditLog(input: AuditLogInput) {
  const db = getDatabase();
  const [row] = await db
    .insert(auditLogs)
    .values({
      actorAdminId: input.actorAdminId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create audit log");
  }

  return row;
}

export async function listAuditLogs(input: PaginationInput = defaultPagination) {
  const db = getDatabase();
  const limit = input.limit ?? defaultPagination.limit;
  const offset = input.offset ?? defaultPagination.offset;
  const rows = await db
    .select({
      id: auditLogs.id,
      actorAdminId: auditLogs.actorAdminId,
      actorUsername: adminUsers.username,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      before: auditLogs.before,
      after: auditLogs.after,
      ipAddress: auditLogs.ipAddress,
      userAgent: auditLogs.userAgent,
      createdAt: auditLogs.createdAt
    })
    .from(auditLogs)
    .leftJoin(adminUsers, eq(auditLogs.actorAdminId, adminUsers.id))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map(toIsoDate);
}

export async function countAuditLogs() {
  const db = getDatabase();
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(auditLogs);
  return row?.count ?? 0;
}

export async function listRuntimeSettings() {
  const db = getDatabase();
  const rows = await db.select().from(runtimeSettings).orderBy(runtimeSettings.key);
  return rows.map(toIsoDate);
}

export async function getRuntimeSetting(key: string) {
  const db = getDatabase();
  const [row] = await db.select().from(runtimeSettings).where(eq(runtimeSettings.key, key)).limit(1);
  return row ?? null;
}

export async function upsertRuntimeSetting(input: NewRuntimeSetting) {
  const db = getDatabase();
  const [row] = await db
    .insert(runtimeSettings)
    .values(input)
    .onConflictDoUpdate({
      target: runtimeSettings.key,
      set: {
        value: input.value ?? null,
        encrypted: input.encrypted ?? false,
        updatedByAdminId: input.updatedByAdminId ?? null,
        updatedAt: new Date()
      }
    })
    .returning();

  if (!row) {
    throw new Error("Failed to upsert runtime setting");
  }

  return row;
}

export async function applyRuntimeSettingsChanges(input: RuntimeSettingsChangeSet) {
  const db = getDatabase();
  const deletes = Array.from(new Set(input.deletes ?? []));
  const upserts = input.upserts ?? [];

  await db.transaction(async (tx) => {
    for (const key of deletes) {
      await tx.delete(runtimeSettings).where(eq(runtimeSettings.key, key));
    }

    for (const setting of upserts) {
      await tx
        .insert(runtimeSettings)
        .values(setting)
        .onConflictDoUpdate({
          target: runtimeSettings.key,
          set: {
            value: setting.value ?? null,
            encrypted: setting.encrypted ?? false,
            updatedByAdminId: setting.updatedByAdminId ?? null,
            updatedAt: new Date()
          }
        });
    }
  });
}

export async function applyRuntimeSettingsChangesWithAudit(input: {
  changes: RuntimeSettingsChangeSet;
  audit: AuditLogInput;
}) {
  const db = getDatabase();
  const deletes = Array.from(new Set(input.changes.deletes ?? []));
  const upserts = input.changes.upserts ?? [];

  await db.transaction(async (tx) => {
    for (const key of deletes) {
      await tx.delete(runtimeSettings).where(eq(runtimeSettings.key, key));
    }

    for (const setting of upserts) {
      await tx
        .insert(runtimeSettings)
        .values(setting)
        .onConflictDoUpdate({
          target: runtimeSettings.key,
          set: {
            value: setting.value ?? null,
            encrypted: setting.encrypted ?? false,
            updatedByAdminId: setting.updatedByAdminId ?? null,
            updatedAt: new Date()
          }
        });
    }

    const [row] = await tx
      .insert(auditLogs)
      .values({
        actorAdminId: input.audit.actorAdminId ?? null,
        action: input.audit.action,
        targetType: input.audit.targetType,
        targetId: input.audit.targetId ?? null,
        before: input.audit.before ?? null,
        after: input.audit.after ?? null,
        ipAddress: input.audit.ipAddress ?? null,
        userAgent: input.audit.userAgent ?? null
      })
      .returning();

    if (!row) {
      throw new Error("Failed to create audit log");
    }
  });
}

export async function deleteRuntimeSetting(key: string) {
  const db = getDatabase();
  const [row] = await db.delete(runtimeSettings).where(eq(runtimeSettings.key, key)).returning();
  return row ?? null;
}

export async function getRuntimeSettingsEnvOverrides() {
  const rows = await listRuntimeSettings();
  return rows.reduce<Record<string, string>>((accumulator, setting: RuntimeSetting) => {
    if (!setting.value) {
      return accumulator;
    }

    const value = setting.encrypted ? decryptRuntimeSettingValue(setting.value) : setting.value;
    if (value) {
      accumulator[setting.key] = value;
    }

    return accumulator;
  }, {});
}

export async function upsertTelegramUser(input: NewTelegramUser) {
  const db = getDatabase();
  const [user] = await db
    .insert(telegramUsers)
    .values(input)
    .onConflictDoUpdate({
      target: telegramUsers.telegramId,
      set: {
        username: input.username,
        firstName: input.firstName,
        lastName: input.lastName,
        languageCode: input.languageCode,
        updatedAt: new Date()
      }
    })
    .returning();

  return user;
}

export async function getTelegramUser(telegramId: string) {
  const db = getDatabase();
  const [user] = await db.select().from(telegramUsers).where(eq(telegramUsers.telegramId, telegramId)).limit(1);
  return user ?? null;
}

export async function updateTelegramUserPrivacyMode(
  telegramId: string,
  privacyMode: "normal" | "isolated" | "off"
) {
  const db = getDatabase();
  const [user] = await db
    .update(telegramUsers)
    .set({ privacyMode, updatedAt: new Date() })
    .where(eq(telegramUsers.telegramId, telegramId))
    .returning();
  return user ?? null;
}

function defaultChatStatus(type: NewTelegramChat["type"]) {
  return type === "private" ? "approved" : "pending";
}

export async function upsertTelegramChat(input: Omit<NewTelegramChat, "status"> & { status?: NewTelegramChat["status"] }) {
  const db = getDatabase();
  const [chat] = await db
    .insert(telegramChats)
    .values({
      ...input,
      status: input.status ?? defaultChatStatus(input.type)
    })
    .onConflictDoUpdate({
      target: telegramChats.chatId,
      set: {
        type: input.type,
        title: input.title ?? null,
        username: input.username ?? null,
        updatedAt: new Date()
      }
    })
    .returning();

  if (!chat) {
    throw new Error("Failed to upsert Telegram chat");
  }

  return chat;
}

export async function upsertTelegramChatMember(input: NewTelegramChatMember) {
  const db = getDatabase();
  const [member] = await db
    .insert(telegramChatMembers)
    .values(input)
    .onConflictDoUpdate({
      target: [telegramChatMembers.chatId, telegramChatMembers.telegramUserId],
      set: {
        role: input.role ?? null,
        updatedAt: new Date()
      }
    })
    .returning();

  return member ?? null;
}

export async function listTelegramChats(input: PaginationInput = defaultPagination) {
  const db = getDatabase();
  const limit = input.limit ?? defaultPagination.limit;
  const offset = input.offset ?? defaultPagination.offset;
  const rows = await db
    .select()
    .from(telegramChats)
    .orderBy(desc(telegramChats.updatedAt))
    .limit(limit)
    .offset(offset);

  return rows.map(toIsoDate);
}

export async function countTelegramChats() {
  const db = getDatabase();
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(telegramChats);
  return row?.count ?? 0;
}

export async function getTelegramChat(chatId: string) {
  const db = getDatabase();
  const [chat] = await db.select().from(telegramChats).where(eq(telegramChats.chatId, chatId)).limit(1);
  return chat ?? null;
}

export async function updateTelegramChat(
  chatId: string,
  input: Partial<Pick<NewTelegramChat, "status" | "policy" | "replyMode" | "title" | "username">>
) {
  const db = getDatabase();
  const before = await getTelegramChat(chatId);
  const [after] = await db
    .update(telegramChats)
    .set({
      ...input,
      updatedAt: new Date()
    })
    .where(eq(telegramChats.chatId, chatId))
    .returning();

  return {
    before,
    after: after ?? null
  };
}

export async function listTelegramCommandPermissions(
  input: PaginationInput & { chatId?: string | undefined } = defaultPagination
) {
  const db = getDatabase();
  const limit = input.limit ?? defaultPagination.limit;
  const offset = input.offset ?? defaultPagination.offset;
  const rows = await db
    .select()
    .from(telegramCommandPermissions)
    .where(
      and(
        input.chatId ? eq(telegramCommandPermissions.chatId, input.chatId) : undefined,
        notInArray(telegramCommandPermissions.command, hiddenTelegramCommandNames)
      )
    )
    .orderBy(desc(telegramCommandPermissions.updatedAt))
    .limit(limit)
    .offset(offset);

  return rows.map(toIsoDate);
}

export async function countTelegramCommandPermissions(input: { chatId?: string | undefined } = {}) {
  const db = getDatabase();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(telegramCommandPermissions)
    .where(
      and(
        input.chatId ? eq(telegramCommandPermissions.chatId, input.chatId) : undefined,
        notInArray(telegramCommandPermissions.command, hiddenTelegramCommandNames)
      )
    );

  return row?.count ?? 0;
}

function normalizeTelegramCommandName(command: string) {
  return command.trim().replace(/^\//, "").toLowerCase();
}

function assertManageableTelegramCommand(command: string) {
  const normalizedCommand = normalizeTelegramCommandName(command);
  if (reservedTelegramCommandNames.has(normalizedCommand)) {
    throw new Error("/model is hidden and cannot be managed by command permission rules.");
  }
}

export async function upsertTelegramCommandPermission(input: NewTelegramCommandPermission) {
  assertManageableTelegramCommand(input.command);
  const db = getDatabase();
  const values = {
    ...input,
    command: normalizeTelegramCommandName(input.command)
  };
  const rowUpdate = {
    enabled: values.enabled,
    updatedAt: new Date()
  };
  const isGlobalRule = values.chatId === null || values.chatId === undefined;
  const [row] = isGlobalRule
    ? await db
        .insert(telegramCommandPermissions)
        .values(values)
        .onConflictDoUpdate({
          target: telegramCommandPermissions.command,
          targetWhere: sql`${telegramCommandPermissions.chatId} is null`,
          set: rowUpdate
        })
        .returning()
    : await db
        .insert(telegramCommandPermissions)
        .values(values)
        .onConflictDoUpdate({
          target: [telegramCommandPermissions.chatId, telegramCommandPermissions.command],
          targetWhere: sql`${telegramCommandPermissions.chatId} is not null`,
          set: rowUpdate
        })
        .returning();

  if (!row) {
    throw new Error("Failed to upsert Telegram command permission");
  }

  return row;
}

export async function deleteTelegramCommandPermission(id: string) {
  const db = getDatabase();
  const [row] = await db.delete(telegramCommandPermissions).where(eq(telegramCommandPermissions.id, id)).returning();

  return row ? toIsoDate(row) : null;
}

export async function resolveTelegramChatAccess(input: {
  chatId: string;
  type: NewTelegramChat["type"];
  title?: string | null | undefined;
  username?: string | null | undefined;
  command?: string | null | undefined;
}) {
  const chat = await upsertTelegramChat({
    chatId: input.chatId,
    type: input.type,
    title: input.title ?? null,
    username: input.username ?? null,
    policy: "allow_all_commands"
  });

  const db = getDatabase();
  const command = input.command ? normalizeTelegramCommandName(input.command) : null;
  const shouldCheckCommandPermission = Boolean(command && !reservedTelegramCommandNames.has(command));
  const permissions = shouldCheckCommandPermission
    ? await db
        .select()
        .from(telegramCommandPermissions)
        .where(
          and(
            eq(telegramCommandPermissions.command, command as string),
            or(eq(telegramCommandPermissions.chatId, input.chatId), isNull(telegramCommandPermissions.chatId))
          )
        )
    : [];
  const scopedPermission = permissions.find((permission) => permission.chatId === input.chatId);
  const globalPermission = permissions.find((permission) => permission.chatId === null);
  const permission = scopedPermission ?? globalPermission;

  const commandEnabled = permission?.enabled ?? true;
  const statusAllows = chat.status === "approved";
  const policyAllows =
    chat.policy === "allow_all_commands" ||
    (chat.policy === "commands_only" && Boolean(input.command));
  const allowed = statusAllows && policyAllows && commandEnabled;
  let reason = "approved";

  if (!statusAllows) {
    reason = chat.status;
  } else if (!policyAllows) {
    reason = chat.policy;
  } else if (!commandEnabled) {
    reason = "command_disabled";
  }

  return {
    chat,
    allowed,
    reason,
    commandEnabled
  };
}

export async function listTelegramUsers(input: PaginationInput = defaultPagination) {
  const db = getDatabase();
  const limit = input.limit ?? defaultPagination.limit;
  const offset = input.offset ?? defaultPagination.offset;

  const rows = await db
    .select()
    .from(telegramUsers)
    .orderBy(desc(telegramUsers.updatedAt))
    .limit(limit)
    .offset(offset);

  return rows.map(toIsoDate);
}

export async function countTelegramUsers() {
  const db = getDatabase();
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(telegramUsers);
  return row?.count ?? 0;
}

export async function ensureConversation(input: ConversationScopeInput) {
  const db = getDatabase();
  const [existing] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.scopeKey, input.scopeKey))
    .limit(1);

  if (existing) {
    if (
      existing.personaId !== input.personaId ||
      existing.personaVersion !== input.personaVersion ||
      existing.personaHash !== input.personaHash
    ) {
      const [updated] = await db
        .update(conversations)
        .set({
          personaId: input.personaId ?? null,
          personaVersion: input.personaVersion ?? null,
          personaHash: input.personaHash ?? null,
          updatedAt: new Date()
        })
        .where(eq(conversations.id, existing.id))
        .returning();
      return updated ?? existing;
    }
    return existing;
  }

  const [conversation] = await db
    .insert(conversations)
    .values({
      telegramUserId: input.telegramUserId,
      protocol: input.protocol,
      scopeKey: input.scopeKey,
      chatId: input.chatId ?? null,
      threadId: input.threadId ?? null,
      personaId: input.personaId ?? null,
      personaVersion: input.personaVersion ?? null,
      personaHash: input.personaHash ?? null
    })
    .onConflictDoNothing({ target: conversations.scopeKey })
    .returning();
  if (!conversation) {
    const [racedConversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.scopeKey, input.scopeKey))
      .limit(1);
    if (racedConversation) {
      return racedConversation;
    }
  }
  if (!conversation) {
    throw new Error("Failed to create conversation");
  }

  return conversation;
}

export async function saveMessage(
  input: Omit<NewMessage, "conversationId"> & {
    conversationId?: string | null;
    conversationScope?: ConversationScopeInput;
  }
) {
  const db = getDatabase();
  if (!input.conversationId && !input.conversationScope) {
    throw new Error("conversationId or conversationScope is required");
  }
  const conversationId = input.conversationId ?? (await ensureConversation(input.conversationScope as ConversationScopeInput)).id;
  const { conversationScope: _conversationScope, ...messageInput } = input;

  const [message] = await db
    .insert(messages)
    .values({
      ...messageInput,
      conversationId
    })
    .returning();

  await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));

  if (!message) {
    throw new Error("Failed to save message");
  }

  return message;
}

export async function saveConversationTurn(input: {
  scope: ConversationScopeInput;
  telegramUserId: string;
  telegramChatId?: string | null;
  telegramThreadId?: string | null;
  telegramMessageId?: number | null;
  userContent: string;
  assistantContent: string;
}) {
  const db = getDatabase();
  const userMessageCreatedAt = new Date();
  const assistantMessageCreatedAt = new Date(userMessageCreatedAt.getTime() + 1);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.scopeKey, input.scope.scopeKey))
      .limit(1);

    let conversation = existing;
    if (!conversation) {
      [conversation] = await tx
        .insert(conversations)
        .values({
          telegramUserId: input.scope.telegramUserId,
          protocol: input.scope.protocol,
          scopeKey: input.scope.scopeKey,
          chatId: input.scope.chatId ?? null,
          threadId: input.scope.threadId ?? null,
          personaId: input.scope.personaId ?? null,
          personaVersion: input.scope.personaVersion ?? null,
          personaHash: input.scope.personaHash ?? null
        })
        .onConflictDoNothing({ target: conversations.scopeKey })
        .returning();
      if (!conversation) {
        [conversation] = await tx
          .select()
          .from(conversations)
          .where(eq(conversations.scopeKey, input.scope.scopeKey))
          .limit(1);
      }
    }

    if (!conversation) {
      throw new Error("Failed to create conversation");
    }

    if (
      conversation.personaId !== input.scope.personaId ||
      conversation.personaVersion !== input.scope.personaVersion ||
      conversation.personaHash !== input.scope.personaHash
    ) {
      const [updatedConversation] = await tx
        .update(conversations)
        .set({
          personaId: input.scope.personaId ?? null,
          personaVersion: input.scope.personaVersion ?? null,
          personaHash: input.scope.personaHash ?? null,
          updatedAt: new Date()
        })
        .where(eq(conversations.id, conversation.id))
        .returning();
      conversation = updatedConversation ?? conversation;
    }

    if (input.telegramMessageId !== null && input.telegramMessageId !== undefined) {
      const [existingUserMessage] = await tx
        .select()
        .from(messages)
        .where(
          and(
            input.telegramChatId
              ? eq(messages.telegramChatId, input.telegramChatId)
              : and(eq(messages.telegramUserId, input.telegramUserId), isNull(messages.telegramChatId)),
            eq(messages.telegramMessageId, input.telegramMessageId),
            eq(messages.role, "user")
          )
        )
        .orderBy(desc(messages.createdAt))
        .limit(1);
      if (existingUserMessage?.conversationId) {
        const [existingAssistantMessage] = await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.telegramUserId, input.telegramUserId),
              eq(messages.conversationId, existingUserMessage.conversationId),
              eq(messages.role, "assistant"),
              gt(messages.createdAt, existingUserMessage.createdAt)
            )
          )
          .orderBy(asc(messages.createdAt))
          .limit(1);

        if (existingAssistantMessage) {
          return {
            conversation,
            userMessage: existingUserMessage,
            assistantMessage: existingAssistantMessage
          };
        }
      }
    }

    const [userMessage] = await tx
      .insert(messages)
      .values({
        conversationId: conversation.id,
        telegramUserId: input.telegramUserId,
        telegramChatId: input.telegramChatId ?? null,
        telegramThreadId: input.telegramThreadId ?? null,
        telegramMessageId: input.telegramMessageId ?? null,
        role: "user",
        content: input.userContent,
        createdAt: userMessageCreatedAt
      })
      .returning();
    const [assistantMessage] = await tx
      .insert(messages)
      .values({
        conversationId: conversation.id,
        telegramUserId: input.telegramUserId,
        telegramChatId: input.telegramChatId ?? null,
        telegramThreadId: input.telegramThreadId ?? null,
        role: "assistant",
        content: input.assistantContent,
        createdAt: assistantMessageCreatedAt
      })
      .returning();

    if (!userMessage || !assistantMessage) {
      throw new Error("Failed to save conversation turn");
    }

    await tx.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversation.id));

    return {
      conversation,
      userMessage,
      assistantMessage
    };
  });
}

export async function findConversationTurnByTelegramMessage(input: {
  telegramUserId: string;
  telegramChatId?: string | null;
  telegramMessageId: number;
}) {
  const db = getDatabase();
  const [userMessage] = await db
    .select()
    .from(messages)
    .where(
      and(
        input.telegramChatId
          ? eq(messages.telegramChatId, input.telegramChatId)
          : and(eq(messages.telegramUserId, input.telegramUserId), isNull(messages.telegramChatId)),
        eq(messages.telegramMessageId, input.telegramMessageId),
        eq(messages.role, "user")
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);

  if (!userMessage?.conversationId) {
    return null;
  }

  const [assistantMessage] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.telegramUserId, input.telegramUserId),
        eq(messages.conversationId, userMessage.conversationId),
        eq(messages.role, "assistant"),
        gt(messages.createdAt, userMessage.createdAt)
      )
    )
    .orderBy(asc(messages.createdAt))
    .limit(1);

  if (!assistantMessage) {
    return null;
  }

  return {
    userMessage,
    assistantMessage
  };
}

export async function listMessages(input: PaginationInput & { telegramUserId?: string | undefined } = defaultPagination) {
  const db = getDatabase();
  const limit = input.limit ?? defaultPagination.limit;
  const offset = input.offset ?? defaultPagination.offset;

  const rows = await db
    .select()
    .from(messages)
    .where(input.telegramUserId ? eq(messages.telegramUserId, input.telegramUserId) : undefined)
    .orderBy(desc(messages.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map(toIsoDate);
}

export async function countMessages(telegramUserId?: string) {
  const db = getDatabase();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(telegramUserId ? eq(messages.telegramUserId, telegramUserId) : undefined);

  return row?.count ?? 0;
}

export async function getRecentMessages(scopeKey: string, limit = 12) {
  const db = getDatabase();
  const rows = await db
    .select()
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(eq(conversations.scopeKey, scopeKey))
    .orderBy(
      desc(messages.createdAt),
      desc(sql<number>`case ${messages.role} when 'assistant' then 2 when 'system' then 1 else 0 end`)
    )
    .limit(limit);

  return rows.reverse().map((row) => row.messages);
}

export async function clearConversationMessages(scopeKey: string) {
  const db = getDatabase();
  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.scopeKey, scopeKey))
    .limit(1);
  if (!conversation) {
    return 0;
  }
  const deleted = await db.delete(messages).where(eq(messages.conversationId, conversation.id)).returning({ id: messages.id });
  return deleted.length;
}

export async function createMemory(input: {
  telegramUserId: string;
  summary: string;
  embedding: number[];
  embeddingModel: string;
  embeddingRevision?: string | null;
  importance?: number;
  scope?: "persona_global" | "chat_shared" | "user_private" | "user_in_chat";
  kind?: "fact" | "event" | "preference";
  sourceChatId?: string | null;
  sourceThreadId?: string | null;
  subjectUserId?: string | null;
  confidence?: number;
  supersedesId?: string | null;
  sourceMessageId?: string | null;
}) {
  if (input.embedding.length !== 512) {
    throw new Error(`Local memory embedding must contain 512 dimensions; received ${input.embedding.length}`);
  }
  const db = getDatabase();
  const [memory] = await db
    .insert(memories)
    .values({
      telegramUserId: input.telegramUserId,
      summary: input.summary,
      embeddingLocal: input.embedding,
      embeddingModel: input.embeddingModel,
      embeddingRevision: input.embeddingRevision ?? null,
      embeddingDimensions: input.embedding.length,
      embeddingNormalized: true,
      contentHash: createHash("sha256").update(input.summary).digest("hex"),
      embeddedAt: new Date(),
      embeddingStatus: "ready",
      importance: input.importance ?? 5,
      scope: input.scope ?? "user_private",
      kind: input.kind ?? "fact",
      sourceChatId: input.sourceChatId ?? null,
      sourceThreadId: input.sourceThreadId ?? null,
      subjectUserId: input.subjectUserId ?? input.telegramUserId,
      confidence: input.confidence ?? 70,
      supersedesId: input.supersedesId ?? null,
      sourceMessageId: input.sourceMessageId ?? null
    })
    .returning();

  if (!memory) {
    throw new Error("Failed to create memory");
  }

  return memory;
}

export async function listMemories(
  input: PaginationInput & {
    telegramUserId?: string | undefined;
    sourceChatId?: string | null | undefined;
    sourceThreadId?: string | null | undefined;
    includeDeleted?: boolean | undefined;
  } = defaultPagination
) {
  const db = getDatabase();
  const limit = input.limit ?? defaultPagination.limit;
  const offset = input.offset ?? defaultPagination.offset;

  const rows = await db
    .select({
      id: memories.id,
      telegramUserId: memories.telegramUserId,
      summary: memories.summary,
      importance: memories.importance,
      scope: memories.scope,
      kind: memories.kind,
      sourceChatId: memories.sourceChatId,
      sourceThreadId: memories.sourceThreadId,
      subjectUserId: memories.subjectUserId,
      confidence: memories.confidence,
      embeddingModel: memories.embeddingModel,
      embeddingRevision: memories.embeddingRevision,
      embeddingDimensions: memories.embeddingDimensions,
      embeddingNormalized: memories.embeddingNormalized,
      embeddingStatus: memories.embeddingStatus,
      contentHash: memories.contentHash,
      embeddedAt: memories.embeddedAt,
      sourceMessageId: memories.sourceMessageId,
      createdAt: memories.createdAt,
      lastAccessedAt: memories.lastAccessedAt,
      deletedAt: memories.deletedAt
    })
    .from(memories)
    .where(
      and(
        input.telegramUserId ? eq(memories.telegramUserId, input.telegramUserId) : undefined,
        input.sourceChatId === undefined
          ? undefined
          : input.sourceChatId === null
            ? isNull(memories.sourceChatId)
            : eq(memories.sourceChatId, input.sourceChatId),
        input.sourceThreadId === undefined
          ? undefined
          : input.sourceThreadId === null
            ? isNull(memories.sourceThreadId)
            : eq(memories.sourceThreadId, input.sourceThreadId),
        input.includeDeleted ? undefined : isNull(memories.deletedAt)
      )
    )
    .orderBy(desc(memories.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map(toIsoDate);
}

export async function countMemories(telegramUserId?: string) {
  const db = getDatabase();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memories)
    .where(and(telegramUserId ? eq(memories.telegramUserId, telegramUserId) : undefined, isNull(memories.deletedAt)));

  return row?.count ?? 0;
}

export async function searchMemories(input: {
  telegramUserId: string;
  embedding: number[];
  sourceChatId?: string | null;
  sourceThreadId?: string | null;
  includePrivate?: boolean;
  privateSourceChatId?: string | null;
  privateSourceThreadId?: string | null;
  limit?: number;
  maxDistance?: number;
  touchLastAccessed?: boolean;
}) {
  if (input.embedding.length !== 512) {
    throw new Error(`Local query embedding must contain 512 dimensions; received ${input.embedding.length}`);
  }
  const db = getDatabase();
  const limit = input.limit ?? 5;
  const literal = vectorLiteral(input.embedding);
  const distance = sql<number>`${memories.embeddingLocal} <=> ${literal}::halfvec`;
  const visibility = [eq(memories.scope, "persona_global")];
  if (input.includePrivate !== false) {
    visibility.push(
      and(
        eq(memories.scope, "user_private"),
        eq(memories.telegramUserId, input.telegramUserId),
        input.privateSourceChatId === undefined
          ? undefined
          : input.privateSourceChatId === null
            ? isNull(memories.sourceChatId)
            : eq(memories.sourceChatId, input.privateSourceChatId),
        input.privateSourceThreadId === undefined
          ? undefined
          : input.privateSourceThreadId === null
            ? isNull(memories.sourceThreadId)
            : eq(memories.sourceThreadId, input.privateSourceThreadId)
      )!
    );
  }
  if (input.sourceChatId) {
    const threadCondition =
      input.sourceThreadId === undefined
        ? undefined
        : input.sourceThreadId === null
          ? isNull(memories.sourceThreadId)
          : eq(memories.sourceThreadId, input.sourceThreadId);
    visibility.push(
      and(
        eq(memories.scope, "user_in_chat"),
        eq(memories.telegramUserId, input.telegramUserId),
        eq(memories.sourceChatId, input.sourceChatId),
        threadCondition
      )!,
      and(eq(memories.scope, "chat_shared"), eq(memories.sourceChatId, input.sourceChatId), threadCondition)!
    );
  }

  const rows = await db
    .select({
      id: memories.id,
      telegramUserId: memories.telegramUserId,
      summary: memories.summary,
      importance: memories.importance,
      scope: memories.scope,
      kind: memories.kind,
      sourceChatId: memories.sourceChatId,
      sourceThreadId: memories.sourceThreadId,
      subjectUserId: memories.subjectUserId,
      confidence: memories.confidence,
      embeddingModel: memories.embeddingModel,
      embeddingDimensions: memories.embeddingDimensions,
      sourceMessageId: memories.sourceMessageId,
      createdAt: memories.createdAt,
      lastAccessedAt: memories.lastAccessedAt,
      distance
    })
    .from(memories)
    .where(
      and(
        isNull(memories.deletedAt),
        sql`${memories.embeddingLocal} is not null`,
        or(...visibility),
        input.maxDistance === undefined ? undefined : sql`${distance} <= ${input.maxDistance}`
      )
    )
    .orderBy(distance)
    .limit(limit);

  if (rows.length > 0 && input.touchLastAccessed !== false) {
    await db
      .update(memories)
      .set({ lastAccessedAt: new Date() })
      .where(
        sql`${memories.id} in (${sql.join(
          rows.map((row) => sql`${row.id}`),
          sql`, `
        )})`
      );
  }

  return rows.map((row) => ({
    ...row,
    score: 1 - row.distance
  })) satisfies MemorySearchHit[];
}

export async function softDeleteMemories(input: { telegramUserId: string; sourceChatId?: string | null }) {
  const db = getDatabase();
  const deleted = await db
    .update(memories)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(memories.telegramUserId, input.telegramUserId),
        input.sourceChatId === undefined
          ? undefined
          : input.sourceChatId === null
            ? isNull(memories.sourceChatId)
            : eq(memories.sourceChatId, input.sourceChatId),
        isNull(memories.deletedAt)
      )
    )
    .returning({ id: memories.id });
  return deleted.length;
}

export async function listMemoriesPendingLocalEmbedding(limit = 100) {
  const db = getDatabase();
  return db
    .select({ id: memories.id, summary: memories.summary })
    .from(memories)
    .where(and(isNull(memories.deletedAt), isNull(memories.embeddingLocal)))
    .orderBy(asc(memories.createdAt))
    .limit(limit);
}

export async function updateMemoryLocalEmbedding(input: {
  id: string;
  embedding: number[];
  embeddingModel: string;
  embeddingRevision?: string | null;
}) {
  if (input.embedding.length !== 512) {
    throw new Error(`Local memory embedding must contain 512 dimensions; received ${input.embedding.length}`);
  }
  const db = getDatabase();
  const [memory] = await db
    .update(memories)
    .set({
      embeddingLocal: input.embedding,
      embeddingModel: input.embeddingModel,
      embeddingRevision: input.embeddingRevision ?? null,
      embeddingDimensions: 512,
      embeddingNormalized: true,
      embeddedAt: new Date(),
      embeddingStatus: "ready"
    })
    .where(eq(memories.id, input.id))
    .returning({ id: memories.id });
  return memory ?? null;
}
