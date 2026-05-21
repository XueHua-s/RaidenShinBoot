import { FormEvent, useState } from "react";
import { Send } from "lucide-react";
import type { ChatResponse, MessageDto } from "@raiden/shared";
import { ErrorBanner, ResourcePage } from "../components/page.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input, Label, Textarea } from "../components/ui/input.js";
import { useResourceList } from "../hooks/useResourceList.js";
import { apiClient, readJson } from "../lib/apiClient.js";
import { useI18n } from "../lib/i18n.js";
import { errorMessage } from "../lib/utils.js";

function ChatConsole() {
  const { t } = useI18n();
  const [telegramUserId, setTelegramUserId] = useState("local-traveler");
  const [content, setContent] = useState("");
  const [reply, setReply] = useState("");
  const [memoryCount, setMemoryCount] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!content.trim()) {
      return;
    }

    setPending(true);
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
      setError(errorMessage(requestError));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("chatConsole.title")}</CardTitle>
        <CardDescription>{t("chatConsole.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={submit}>
          <Label>
            {t("chatConsole.telegramId")}
            <Input value={telegramUserId} onChange={(event) => setTelegramUserId(event.target.value)} />
          </Label>
          <Label>
            {t("chatConsole.message")}
            <Textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder={t("chatConsole.placeholder")} />
          </Label>
          <ErrorBanner message={error} />
          <Button disabled={pending || !telegramUserId.trim() || !content.trim()} type="submit">
            <Send className="size-4" />
            {pending ? t("chatConsole.thinking") : t("chatConsole.send")}
          </Button>
        </form>
        {reply && (
          <div className="mt-4 rounded-lg border border-cyan-200 bg-cyan-50 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge tone="info">Raiden Makoto</Badge>
              {memoryCount !== null && <Badge>{t("chatConsole.memoryRecalled", { count: memoryCount })}</Badge>}
            </div>
            <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-800">{reply}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ConversationsPage() {
  const { t, formatMessageRole, formatDate } = useI18n();
  const { data, total, loading, error, reload } = useResourceList<MessageDto>("messages", 20);

  return (
    <ResourcePage
      title={t("conversations.title")}
      description={t("conversations.description")}
      error={error}
      loading={loading}
      onRefresh={reload}
    >
      <div className="grid gap-5 xl:grid-cols-[1fr_390px]">
        <Card>
          <CardHeader>
            <CardTitle>{t("conversations.messages")}</CardTitle>
            <CardDescription>{t("conversations.recordCount", { count: total })}</CardDescription>
          </CardHeader>
          <div className="divide-y divide-zinc-100">
            {data.map((message) => (
              <article className="px-4 py-3 hover:bg-zinc-50" key={message.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={message.role === "assistant" ? "info" : message.role === "system" ? "warning" : "neutral"}>
                    {formatMessageRole(message.role)}
                  </Badge>
                  <span className="font-mono text-xs text-zinc-500">{message.telegramUserId}</span>
                  <span className="text-xs text-zinc-500">{formatDate(message.createdAt)}</span>
                </div>
                <p className="mt-2 line-clamp-3 text-sm leading-6 text-zinc-800">{message.content}</p>
              </article>
            ))}
            {data.length === 0 && <p className="px-4 py-10 text-center text-sm text-zinc-500">{t("conversations.empty")}</p>}
          </div>
        </Card>
        <ChatConsole />
      </div>
    </ResourcePage>
  );
}
