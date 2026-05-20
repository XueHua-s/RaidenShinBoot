import { createHash } from "node:crypto";
import { isMemoryRecallRequest } from "@raiden/shared";
import { shouldUseBootSearchForMessage } from "@raiden/shared/tools";

export const conversationCachePolicyVersion = "conversation-cache-v2";

export type ConversationCacheFingerprintInput = {
  protocol: string;
  userId: string;
  chatModel: string;
  embeddingModel: string;
  searchProvider: string;
  history: Array<{
    id?: string | undefined;
    role: string;
    content: string;
    createdAt?: Date | string | undefined;
  }>;
  memories: Array<{
    id: string;
    summary: string;
    importance: number;
    sourceMessageId: string | null;
    createdAt?: Date | string | undefined;
  }>;
};

const contextualCjkQueryPattern =
  /(继续|接着|刚才|上面|前面|上一条|前一条|之前|这个|这件|这些|那个|那件|那些|它|他们|她们|他说|她说|你说|再来|展开一下|总结一下)/i;
const contextualEnglishQueryPattern = /\b(continue|previous|above|earlier|that|this|it|they|more)\b/i;

export function conversationCacheScope(input: { protocol: string; userId: string }) {
  return `${input.protocol}:${input.userId}`;
}

export function normalizeCacheQuery(content: string) {
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

export function isStandaloneCacheCandidate(content: string) {
  const normalized = normalizeCacheQuery(content);
  if (!normalized || normalized.startsWith("/") || isMemoryRecallRequest(normalized) || shouldUseBootSearchForMessage(normalized)) {
    return false;
  }
  if (contextualCjkQueryPattern.test(normalized) || contextualEnglishQueryPattern.test(normalized)) {
    return false;
  }

  const compactLength = normalized.replace(/\s+/g, "").length;
  const hasCjk = /[\u3400-\u9fff]/.test(normalized);
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  return hasCjk ? compactLength >= 6 : compactLength >= 12 || wordCount >= 4;
}

export function buildConversationCacheContextFingerprint(input: ConversationCacheFingerprintInput) {
  return stableHash([
    conversationCachePolicyVersion,
    input.protocol,
    input.userId,
    input.chatModel,
    input.embeddingModel,
    input.searchProvider,
    JSON.stringify(
      input.history.map((message) => ({
        id: message.id ?? null,
        role: message.role,
        content: message.content,
        createdAt: isoTimestamp(message.createdAt)
      }))
    ),
    JSON.stringify(
      input.memories.map((memory) => ({
        id: memory.id,
        summary: memory.summary,
        importance: memory.importance,
        sourceMessageId: memory.sourceMessageId,
        createdAt: isoTimestamp(memory.createdAt)
      }))
    )
  ]);
}

function isoTimestamp(value: Date | string | undefined) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

export function stableHash(parts: string[]) {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
