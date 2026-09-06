import { getBootQueueConfig } from "@raiden/boot";
import { decodeTelegramPhoto } from "../packages/bot/src/image-output.js";
import { telegramTaskId } from "../packages/bot/src/task-id.js";
import { telegramUpdateConstraint } from "../packages/bot/src/update-constraint.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function context(updateId: number, text: string) {
  return {
    update: { update_id: updateId },
    chat: { id: -1001234567890 },
    from: { id: 123456789 },
    msg: { message_thread_id: 42 },
    message: { text }
  } as never;
}

const chatConstraint = telegramUpdateConstraint(context(1, "雷电真，在吗？"));
const pauseConstraint = telegramUpdateConstraint(context(2, "/pause"));
const addressedPauseConstraint = telegramUpdateConstraint(context(3, "/pause@raiden_bot now"));
const resumeConstraint = telegramUpdateConstraint(context(4, "/resume"));
const similarCommandConstraint = telegramUpdateConstraint(context(5, "/paused"));

assert(pauseConstraint !== chatConstraint, "/pause must bypass the active chat's sequential lock");
assert(addressedPauseConstraint === pauseConstraint, "Addressed /pause must use the control lock");
assert(resumeConstraint === pauseConstraint, "Control commands in one scope must preserve update order");
assert(similarCommandConstraint === chatConstraint, "Commands that only share a prefix must keep the chat lock");

assert(
  getBootQueueConfig({ REDIS_URL: "redis://127.0.0.1:6379" }).telegramConcurrency === 8,
  "Webhook workers need concurrent update admission so control commands can bypass a long chat"
);

const firstTaskId = telegramTaskId({ kind: "image", chatId: "-1001", messageId: 42, userId: "7" });
const replayedTaskId = telegramTaskId({ kind: "image", chatId: "-1001", messageId: 42, userId: "7" });
const distinctTaskId = telegramTaskId({ kind: "reminder", chatId: "-1001", messageId: 42, userId: "7" });
assert(firstTaskId === replayedTaskId, "A redelivered Telegram message must reuse its task id");
assert(firstTaskId !== distinctTaskId, "Different task kinds must not share an id");
assert(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(firstTaskId), "Task ids must remain UUID-shaped");

const png = decodeTelegramPhoto({
  base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  mediaType: "image/png"
});
assert(png.bytes.length > 0 && png.extension === "png", "A valid PNG should pass Telegram photo validation");
let mismatchedImageRejected = false;
try {
  decodeTelegramPhoto({ base64: png.bytes.toString("base64"), mediaType: "image/jpeg" });
} catch {
  mismatchedImageRejected = true;
}
assert(mismatchedImageRejected, "A generated image MIME/signature mismatch must be rejected");
let malformedPaddingRejected = false;
try {
  decodeTelegramPhoto({ base64: `${png.bytes.toString("base64")}=`, mediaType: "image/png" });
} catch {
  malformedPaddingRejected = true;
}
assert(malformedPaddingRejected, "Malformed base64 padding must be rejected before upload");

console.log("Bot runtime smoke passed.");
