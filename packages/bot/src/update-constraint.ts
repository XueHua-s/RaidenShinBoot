import type { Context } from "grammy";

export function telegramRequestScope(ctx: Context) {
  const threadId = ctx.msg?.message_thread_id ?? "main";
  if (ctx.chat?.id !== undefined) {
    return `chat:${ctx.chat.id}:thread:${threadId}`;
  }
  return ctx.from?.id === undefined ? "unknown" : `user:${ctx.from.id}`;
}

export function telegramUpdateConstraint(ctx: Context) {
  const text = ctx.message && "text" in ctx.message ? ctx.message.text.trim() : "";
  if (/^\/(?:stop|pause|resume|cancel)(?:@\S+)?(?:\s|$)/i.test(text)) {
    return `control:${telegramRequestScope(ctx)}`;
  }
  return telegramRequestScope(ctx);
}
