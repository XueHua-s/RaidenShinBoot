import { runBootConversation } from "@raiden/boot";

export type ConversationInput = {
  telegramUserId: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
  content: string;
  telegramMessageId?: number | null;
};

export async function handleConversation(input: ConversationInput) {
  return runBootConversation({
    protocol: "telegram",
    userId: input.telegramUserId,
    username: input.username ?? null,
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    languageCode: input.languageCode ?? null,
    sourceMessageId: input.telegramMessageId ?? null,
    content: input.content
  });
}
