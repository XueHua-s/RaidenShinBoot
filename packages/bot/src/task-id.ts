import { createHash } from "node:crypto";

export type TelegramTaskKind = "image" | "reminder";

/**
 * Telegram can redeliver an update and BullMQ can retry it. Deriving the UUID
 * from the immutable message identity keeps those retries on the same task.
 */
export function telegramTaskId(input: {
  kind: TelegramTaskKind;
  chatId: string;
  messageId: number;
  userId: string;
}) {
  const bytes = createHash("sha256")
    .update([input.kind, input.chatId, String(input.messageId), input.userId].join("\0"))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
