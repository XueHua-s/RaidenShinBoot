import { AlertCircle, LoaderCircle, Send, Sparkles } from "lucide-react";
import { FormEvent, useState } from "react";
import type { ChatResponse } from "@raiden/shared";
import { apiClient, readJson } from "../lib/apiClient.js";

export function ChatTester() {
  const [telegramUserId, setTelegramUserId] = useState("local-traveler");
  const [content, setContent] = useState("");
  const [reply, setReply] = useState("");
  const [memoryCount, setMemoryCount] = useState<number | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!content.trim()) {
      return;
    }

    setIsPending(true);
    setError(null);

    try {
      const response = await apiClient.api.chat.$post({
        json: {
          telegramUserId,
          username: "panel",
          content
        }
      });
      const payload = await readJson<ChatResponse>(response);
      setReply(payload.reply);
      setMemoryCount(payload.memoryCount);
      setContent("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "请求失败");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-zinc-950">Makoto Console</h2>
          <p className="mt-1 text-sm text-zinc-500">Local traveler session</p>
        </div>
        <Sparkles aria-hidden className="size-5 text-amber-500" />
      </div>

      <form className="mt-4 grid gap-3" onSubmit={handleSubmit}>
        <label className="grid gap-1 text-sm font-medium text-zinc-700">
          Telegram ID
          <input
            className="h-10 rounded-md border border-zinc-300 px-3 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100"
            value={telegramUserId}
            onChange={(event) => setTelegramUserId(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-zinc-700">
          Message
          <textarea
            className="min-h-28 resize-y rounded-md border border-zinc-300 p-3 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="对真说些什么..."
          />
        </label>
        <button
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-violet-700 px-4 text-sm font-semibold text-white transition hover:bg-violet-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
          type="submit"
          disabled={isPending || !content.trim() || !telegramUserId.trim()}
          title="发送消息"
        >
          {isPending ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <Send aria-hidden className="size-4" />}
          {isPending ? "Thinking" : "Send"}
        </button>
      </form>

      {error && (
        <div className="mt-3 flex gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-700">
          <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>{error}</p>
        </div>
      )}
      {reply && (
        <div className="mt-4 rounded-md border border-violet-100 bg-violet-50 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-violet-700">
            <span className="rounded bg-white px-2 py-1 font-semibold">Raiden Makoto</span>
            {memoryCount !== null && <span>{memoryCount} memories recalled</span>}
          </div>
          <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-800">{reply}</p>
        </div>
      )}
    </section>
  );
}
