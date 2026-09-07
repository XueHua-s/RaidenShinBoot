import type { TelegramReplyMode } from "@raiden/shared";

export type GroupInteractionDecision = "ignore" | "react" | "reply";

const defaultTelegramReplyKeywords = ["雷电真", "真姐姐", "真大人", "阿真"] as const;

export function parseTelegramReplyKeywords(value: string | undefined) {
  const configured = value
    ?.split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  return configured?.length ? Array.from(new Set(configured)) : [...defaultTelegramReplyKeywords];
}

export function containsTelegramReplyKeyword(text: string, keywords: readonly string[]) {
  const normalizedText = text.toLocaleLowerCase("zh-CN");
  return keywords.some((keyword) => normalizedText.includes(keyword.toLocaleLowerCase("zh-CN")));
}

type GroupInteractionInput = {
  chatId: string;
  userId: string;
  messageId: number;
  text: string;
  replyMode: TelegramReplyMode;
  directlyMentioned: boolean;
  replyingToBot: boolean;
  wakeWord: boolean;
  now?: number;
};

export class TelegramInteractionPolicy {
  private readonly lastReplyAt = new Map<string, number>();
  private readonly lastReactionAt = new Map<string, number>();

  decide(input: GroupInteractionInput): GroupInteractionDecision {
    const now = input.now ?? Date.now();
    if (input.directlyMentioned || input.replyingToBot) {
      recordActivity(this.lastReplyAt, input.chatId, now);
      return "reply";
    }

    if (input.wakeWord && input.replyMode !== "quiet") {
      recordActivity(this.lastReplyAt, input.chatId, now);
      return "reply";
    }

    if (input.replyMode !== "social" || input.text.length < 2) {
      return "ignore";
    }

    const bucket = stableBucket(`${input.chatId}:${input.messageId}:${input.text}`);
    const looksLikeOpenQuestion = /(?:谁知道|有人知道|怎么办|为什么|怎么会|你们觉得|吗[？?]?|[？?])\s*$/u.test(input.text);
    if (looksLikeOpenQuestion && bucket < 3 && now - (this.lastReplyAt.get(input.chatId) ?? 0) >= 120_000) {
      recordActivity(this.lastReplyAt, input.chatId, now);
      return "reply";
    }

    if (bucket < 10 && now - (this.lastReactionAt.get(input.chatId) ?? 0) >= 45_000) {
      recordActivity(this.lastReactionAt, input.chatId, now);
      return "react";
    }

    return "ignore";
  }
}

function recordActivity(map: Map<string, number>, key: string, value: number) {
  map.delete(key);
  map.set(key, value);
  if (map.size <= 10_000) {
    return;
  }
  const oldestKey = map.keys().next().value;
  if (oldestKey !== undefined) {
    map.delete(oldestKey);
  }
}

function stableBucket(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 100;
}
