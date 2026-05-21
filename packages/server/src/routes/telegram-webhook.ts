import { BootQueueUnavailableError, enqueueTelegramUpdate } from "@raiden/boot";
import { Hono } from "hono";

function webhookSecret() {
  const value = process.env.BOOT_TELEGRAM_WEBHOOK_SECRET?.trim();
  return value ? value : null;
}

export const telegramWebhookRoute = new Hono().post("/", async (c) => {
  const expectedSecret = webhookSecret();
  if (!expectedSecret) {
    return c.json({ error: "BOOT_TELEGRAM_WEBHOOK_SECRET is required before enabling Telegram webhooks" }, 503);
  }

  const actualSecret = c.req.header("x-telegram-bot-api-secret-token");
  if (actualSecret !== expectedSecret) {
    return c.json({ error: "Unauthorized Telegram webhook" }, 401);
  }

  let update: unknown;
  try {
    update = await c.req.json();
  } catch {
    return c.json({ error: "Invalid Telegram update JSON" }, 400);
  }

  try {
    const job = await enqueueTelegramUpdate(update);
    return c.json({ ok: true, jobId: job.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof BootQueueUnavailableError ? 503 : 400;
    console.warn("Telegram webhook enqueue failed.", message);
    return c.json(
      {
        error: status === 503 ? "Telegram webhook queue unavailable" : "Invalid Telegram update payload"
      },
      status
    );
  }
});
