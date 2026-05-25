import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  halfvec,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const adminUsers = pgTable(
  "admin_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    username: text("username").notNull(),
    displayName: text("display_name"),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["super_admin", "operator", "auditor"] }).notNull(),
    status: text("status", { enum: ["active", "disabled"] }).default("active").notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("admin_users_username_idx").on(table.username),
    index("admin_users_role_idx").on(table.role),
    index("admin_users_status_idx").on(table.status)
  ]
);

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    adminUserId: uuid("admin_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("admin_sessions_token_hash_idx").on(table.tokenHash),
    index("admin_sessions_admin_user_idx").on(table.adminUserId),
    index("admin_sessions_expires_idx").on(table.expiresAt)
  ]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorAdminId: uuid("actor_admin_id").references(() => adminUsers.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("audit_logs_actor_idx").on(table.actorAdminId),
    index("audit_logs_action_idx").on(table.action),
    index("audit_logs_target_idx").on(table.targetType, table.targetId),
    index("audit_logs_created_idx").on(table.createdAt)
  ]
);

export const runtimeSettings = pgTable(
  "runtime_settings",
  {
    key: text("key").primaryKey(),
    value: text("value"),
    encrypted: boolean("encrypted").default(false).notNull(),
    updatedByAdminId: uuid("updated_by_admin_id").references(() => adminUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("runtime_settings_updated_by_idx").on(table.updatedByAdminId),
    index("runtime_settings_updated_idx").on(table.updatedAt)
  ]
);

export const telegramUsers = pgTable("telegram_users", {
  telegramId: text("telegram_id").primaryKey(),
  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  languageCode: text("language_code"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const telegramChats = pgTable(
  "telegram_chats",
  {
    chatId: text("chat_id").primaryKey(),
    type: text("type", { enum: ["private", "group", "supergroup", "channel"] }).notNull(),
    title: text("title"),
    username: text("username"),
    status: text("status", { enum: ["pending", "approved", "blocked", "muted"] }).notNull(),
    policy: text("policy", { enum: ["allow_all_commands", "commands_only", "read_only", "disabled"] })
      .default("allow_all_commands")
      .notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("telegram_chats_status_idx").on(table.status),
    index("telegram_chats_type_idx").on(table.type),
    index("telegram_chats_updated_idx").on(table.updatedAt)
  ]
);

export const telegramChatMembers = pgTable(
  "telegram_chat_members",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => telegramChats.chatId, { onDelete: "cascade" }),
    telegramUserId: text("telegram_user_id")
      .notNull()
      .references(() => telegramUsers.telegramId, { onDelete: "cascade" }),
    role: text("role"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.telegramUserId] }),
    index("telegram_chat_members_user_idx").on(table.telegramUserId)
  ]
);

export const telegramCommandPermissions = pgTable(
  "telegram_command_permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chatId: text("chat_id").references(() => telegramChats.chatId, { onDelete: "cascade" }),
    command: text("command").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("telegram_command_permissions_chat_command_idx")
      .on(table.chatId, table.command)
      .where(sql`${table.chatId} is not null`),
    uniqueIndex("telegram_command_permissions_global_command_idx")
      .on(table.command)
      .where(sql`${table.chatId} is null`),
    index("telegram_command_permissions_chat_idx").on(table.chatId)
  ]
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    telegramUserId: text("telegram_user_id")
      .notNull()
      .references(() => telegramUsers.telegramId, { onDelete: "cascade" }),
    title: text("title").default("Telegram chat").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [index("conversations_user_idx").on(table.telegramUserId)]
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    telegramUserId: text("telegram_user_id")
      .notNull()
      .references(() => telegramUsers.telegramId, { onDelete: "cascade" }),
    telegramChatId: text("telegram_chat_id"),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("messages_user_created_idx").on(table.telegramUserId, table.createdAt),
    index("messages_conversation_idx").on(table.conversationId),
    uniqueIndex("messages_chat_telegram_message_idx")
      .on(table.telegramChatId, table.telegramMessageId)
      .where(sql`${table.telegramChatId} is not null and ${table.telegramMessageId} is not null and ${table.role} = 'user'`)
  ]
);

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    telegramUserId: text("telegram_user_id")
      .notNull()
      .references(() => telegramUsers.telegramId, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    importance: integer("importance").default(5).notNull(),
    embedding: halfvec("embedding", { dimensions: 3072 }).notNull(),
    sourceMessageId: uuid("source_message_id").references(() => messages.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true })
  },
  (table) => [
    index("memories_user_idx").on(table.telegramUserId),
    index("memories_embedding_hnsw_idx").using("hnsw", table.embedding.op("halfvec_cosine_ops"))
  ]
);

export const adminUsersRelations = relations(adminUsers, ({ many }) => ({
  sessions: many(adminSessions),
  auditLogs: many(auditLogs)
}));

export const adminSessionsRelations = relations(adminSessions, ({ one }) => ({
  adminUser: one(adminUsers, {
    fields: [adminSessions.adminUserId],
    references: [adminUsers.id]
  })
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  actor: one(adminUsers, {
    fields: [auditLogs.actorAdminId],
    references: [adminUsers.id]
  })
}));

export const runtimeSettingsRelations = relations(runtimeSettings, ({ one }) => ({
  updatedByAdmin: one(adminUsers, {
    fields: [runtimeSettings.updatedByAdminId],
    references: [adminUsers.id]
  })
}));

export const telegramUsersRelations = relations(telegramUsers, ({ many }) => ({
  conversations: many(conversations),
  messages: many(messages),
  memories: many(memories),
  chatMembers: many(telegramChatMembers)
}));

export const telegramChatsRelations = relations(telegramChats, ({ many }) => ({
  members: many(telegramChatMembers),
  commandPermissions: many(telegramCommandPermissions)
}));

export const telegramChatMembersRelations = relations(telegramChatMembers, ({ one }) => ({
  chat: one(telegramChats, {
    fields: [telegramChatMembers.chatId],
    references: [telegramChats.chatId]
  }),
  user: one(telegramUsers, {
    fields: [telegramChatMembers.telegramUserId],
    references: [telegramUsers.telegramId]
  })
}));

export const telegramCommandPermissionsRelations = relations(telegramCommandPermissions, ({ one }) => ({
  chat: one(telegramChats, {
    fields: [telegramCommandPermissions.chatId],
    references: [telegramChats.chatId]
  })
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(telegramUsers, {
    fields: [conversations.telegramUserId],
    references: [telegramUsers.telegramId]
  }),
  messages: many(messages)
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  user: one(telegramUsers, {
    fields: [messages.telegramUserId],
    references: [telegramUsers.telegramId]
  }),
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id]
  })
}));

export const memoriesRelations = relations(memories, ({ one }) => ({
  user: one(telegramUsers, {
    fields: [memories.telegramUserId],
    references: [telegramUsers.telegramId]
  }),
  sourceMessage: one(messages, {
    fields: [memories.sourceMessageId],
    references: [messages.id]
  })
}));

export const createVectorExtension = sql`CREATE EXTENSION IF NOT EXISTS vector`;

export type AdminUser = typeof adminUsers.$inferSelect;
export type NewAdminUser = typeof adminUsers.$inferInsert;
export type AdminSession = typeof adminSessions.$inferSelect;
export type NewAdminSession = typeof adminSessions.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
export type RuntimeSetting = typeof runtimeSettings.$inferSelect;
export type NewRuntimeSetting = typeof runtimeSettings.$inferInsert;
export type TelegramUser = typeof telegramUsers.$inferSelect;
export type NewTelegramUser = typeof telegramUsers.$inferInsert;
export type TelegramChat = typeof telegramChats.$inferSelect;
export type NewTelegramChat = typeof telegramChats.$inferInsert;
export type TelegramChatMember = typeof telegramChatMembers.$inferSelect;
export type NewTelegramChatMember = typeof telegramChatMembers.$inferInsert;
export type TelegramCommandPermission = typeof telegramCommandPermissions.$inferSelect;
export type NewTelegramCommandPermission = typeof telegramCommandPermissions.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
