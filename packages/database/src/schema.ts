import { relations, sql } from "drizzle-orm";
import {
  bigint,
  halfvec,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid
} from "drizzle-orm/pg-core";

export const telegramUsers = pgTable("telegram_users", {
  telegramId: text("telegram_id").primaryKey(),
  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  languageCode: text("language_code"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

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
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("messages_user_created_idx").on(table.telegramUserId, table.createdAt),
    index("messages_conversation_idx").on(table.conversationId)
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

export const telegramUsersRelations = relations(telegramUsers, ({ many }) => ({
  conversations: many(conversations),
  messages: many(messages),
  memories: many(memories)
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

export type TelegramUser = typeof telegramUsers.$inferSelect;
export type NewTelegramUser = typeof telegramUsers.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;

