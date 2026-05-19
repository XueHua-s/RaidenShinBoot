import { and, desc, eq, sql } from "drizzle-orm";
import { getDatabase } from "./client.js";
import { conversations, memories, messages, telegramUsers } from "./schema.js";
import type { NewMessage, NewTelegramUser } from "./schema.js";

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

const defaultPagination = {
  limit: 20,
  offset: 0
};

function toIsoDate<T extends { createdAt?: Date; updatedAt?: Date; firstSeenAt?: Date; lastAccessedAt?: Date | null }>(
  row: T
) {
  return {
    ...row,
    createdAt: row.createdAt?.toISOString(),
    updatedAt: row.updatedAt?.toISOString(),
    firstSeenAt: row.firstSeenAt?.toISOString(),
    lastAccessedAt: row.lastAccessedAt?.toISOString() ?? null
  };
}

export function vectorLiteral(values: number[]) {
  return `[${values.map((value) => Number(value).toFixed(8)).join(",")}]`;
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
    .orderBy(desc(messages.createdAt))
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
