import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
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

export type MemorySearchHit = {
  id: string;
  telegramUserId: string;
  summary: string;
  importance: number;
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
    revokedAt: row.revokedAt?.toISOString() ?? null
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
  input: Partial<Pick<NewTelegramChat, "status" | "policy" | "title" | "username">>
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
    .where(input.chatId ? eq(telegramCommandPermissions.chatId, input.chatId) : undefined)
    .orderBy(desc(telegramCommandPermissions.updatedAt))
    .limit(limit)
    .offset(offset);

  return rows.map(toIsoDate);
}

export async function upsertTelegramCommandPermission(input: NewTelegramCommandPermission) {
  const db = getDatabase();
  const rowUpdate = {
    enabled: input.enabled,
    updatedAt: new Date()
  };
  const isGlobalRule = input.chatId === null || input.chatId === undefined;
  const [row] = isGlobalRule
    ? await db
        .insert(telegramCommandPermissions)
        .values(input)
        .onConflictDoUpdate({
          target: telegramCommandPermissions.command,
          targetWhere: sql`${telegramCommandPermissions.chatId} is null`,
          set: rowUpdate
        })
        .returning()
    : await db
        .insert(telegramCommandPermissions)
        .values(input)
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
  const permissions = input.command
    ? await db
        .select()
        .from(telegramCommandPermissions)
        .where(
          and(
            eq(telegramCommandPermissions.command, input.command),
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

export async function ensureConversation(telegramUserId: string) {
  const db = getDatabase();
  const [existing] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.telegramUserId, telegramUserId))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);

  if (existing) {
    return existing;
  }

  const [conversation] = await db.insert(conversations).values({ telegramUserId }).returning();
  if (!conversation) {
    throw new Error("Failed to create conversation");
  }

  return conversation;
}

export async function saveMessage(input: Omit<NewMessage, "conversationId"> & { conversationId?: string | null }) {
  const db = getDatabase();
  const conversationId = input.conversationId ?? (await ensureConversation(input.telegramUserId)).id;

  const [message] = await db
    .insert(messages)
    .values({
      ...input,
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
  telegramUserId: string;
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
      .where(eq(conversations.telegramUserId, input.telegramUserId))
      .orderBy(desc(conversations.updatedAt))
      .limit(1);

    const conversation =
      existing ??
      (
        await tx
          .insert(conversations)
          .values({ telegramUserId: input.telegramUserId })
          .returning()
      )[0];

    if (!conversation) {
      throw new Error("Failed to create conversation");
    }

    const [userMessage] = await tx
      .insert(messages)
      .values({
        conversationId: conversation.id,
        telegramUserId: input.telegramUserId,
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

export async function getRecentMessages(telegramUserId: string, limit = 12) {
  const db = getDatabase();
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.telegramUserId, telegramUserId))
    .orderBy(
      desc(messages.createdAt),
      desc(sql<number>`case ${messages.role} when 'assistant' then 2 when 'system' then 1 else 0 end`)
    )
    .limit(limit);

  return rows.reverse();
}

export async function createMemory(input: {
  telegramUserId: string;
  summary: string;
  embedding: number[];
  importance?: number;
  sourceMessageId?: string | null;
}) {
  const db = getDatabase();
  const [memory] = await db
    .insert(memories)
    .values({
      telegramUserId: input.telegramUserId,
      summary: input.summary,
      embedding: input.embedding,
      importance: input.importance ?? 5,
      sourceMessageId: input.sourceMessageId ?? null
    })
    .returning();

  if (!memory) {
    throw new Error("Failed to create memory");
  }

  return memory;
}

export async function listMemories(input: PaginationInput & { telegramUserId?: string | undefined } = defaultPagination) {
  const db = getDatabase();
  const limit = input.limit ?? defaultPagination.limit;
  const offset = input.offset ?? defaultPagination.offset;

  const rows = await db
    .select({
      id: memories.id,
      telegramUserId: memories.telegramUserId,
      summary: memories.summary,
      importance: memories.importance,
      sourceMessageId: memories.sourceMessageId,
      createdAt: memories.createdAt,
      lastAccessedAt: memories.lastAccessedAt
    })
    .from(memories)
    .where(input.telegramUserId ? eq(memories.telegramUserId, input.telegramUserId) : undefined)
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
    .where(telegramUserId ? eq(memories.telegramUserId, telegramUserId) : undefined);

  return row?.count ?? 0;
}

export async function searchMemories(input: {
  telegramUserId: string;
  embedding: number[];
  limit?: number;
  maxDistance?: number;
}) {
  const db = getDatabase();
  const limit = input.limit ?? 5;
  const literal = vectorLiteral(input.embedding);
  const distance = sql<number>`${memories.embedding} <=> ${literal}::halfvec`;

  const rows = await db
    .select({
      id: memories.id,
      telegramUserId: memories.telegramUserId,
      summary: memories.summary,
      importance: memories.importance,
      sourceMessageId: memories.sourceMessageId,
      createdAt: memories.createdAt,
      lastAccessedAt: memories.lastAccessedAt,
      distance
    })
    .from(memories)
    .where(
      and(
        eq(memories.telegramUserId, input.telegramUserId),
        input.maxDistance === undefined ? undefined : sql`${distance} <= ${input.maxDistance}`
      )
    )
    .orderBy(distance)
    .limit(limit);

  if (rows.length > 0) {
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
