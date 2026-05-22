import { FormEvent, useEffect, useState } from "react";
import { Search, Send } from "lucide-react";
import type { AdminUserDto, BootToolDescriptor, ChatResponse, MessageDto, WebSearchResponse } from "@raiden/shared";
import { ErrorBanner, ResourcePage } from "../components/page.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input, Label, Textarea } from "../components/ui/input.js";
import { useResourceList } from "../hooks/useResourceList.js";
import { apiClient, readJson } from "../lib/apiClient.js";
import { useI18n } from "../lib/i18n.js";
import { errorMessage } from "../lib/utils.js";

function canWriteConversations(user: AdminUserDto) {
  return user.role === "super_admin" || user.role === "operator";
}

function ChatConsole({ canWrite }: { canWrite: boolean }) {
  const { t, formatStatus } = useI18n();
  const [telegramUserId, setTelegramUserId] = useState("local-traveler");
  const [content, setContent] = useState("");
  const [result, setResult] = useState<ChatResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite) {
      return;
    }
    if (!content.trim()) {
      return;
    }

    setPending(true);
    setError(null);
    setResult(null);
    try {
      const response = await apiClient.api.chat.$post({
        json: {
          telegramUserId,
          username: "panel",
          content
        }
      });
      const payload = await readJson<ChatResponse>(response);
      setResult(payload);
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
          {!canWrite && <Badge tone="warning">{t("common.readOnly")}</Badge>}
          <Button disabled={!canWrite || pending || !telegramUserId.trim() || !content.trim()} type="submit">
            <Send className="size-4" />
            {pending ? t("chatConsole.thinking") : t("chatConsole.send")}
          </Button>
        </form>
        {result && (
          <div className="mt-4 rounded-lg border border-cyan-200 bg-cyan-50 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge tone="info">Raiden Makoto</Badge>
              <Badge>{t("chatConsole.memoryRecalled", { count: result.memoryCount })}</Badge>
              <Badge tone={result.toolStatus.status === "failed" ? "danger" : result.toolStatus.status === "completed" ? "success" : "warning"}>
                {result.toolDecision.action} / {formatStatus(result.toolStatus.status)}
              </Badge>
              <Badge tone={result.webSearchStatus === "completed" ? "success" : result.webSearchStatus === "failed" ? "danger" : "warning"}>
                {t("chatConsole.searchUsed", { count: result.webSearchResultCount })}
              </Badge>
              <Badge>{result.cacheStatus}</Badge>
            </div>
            {result.toolStatus.message && <p className="mb-2 text-xs leading-5 text-zinc-600">{result.toolStatus.message}</p>}
            <dl className="mb-3 grid gap-2 rounded-md border border-cyan-100 bg-white/70 p-2 text-xs text-zinc-600 sm:grid-cols-2">
              <div>
                <dt className="font-semibold text-zinc-800">{t("chatConsole.toolName")}</dt>
                <dd className="mt-1 min-w-0 truncate">{result.toolStatus.name ?? "-"}</dd>
              </div>
              <div>
                <dt className="font-semibold text-zinc-800">{t("chatConsole.reason")}</dt>
                <dd className="mt-1 min-w-0 truncate">{result.toolDecision.reason || "-"}</dd>
              </div>
              <div>
                <dt className="font-semibold text-zinc-800">{t("chatConsole.query")}</dt>
                <dd className="mt-1 min-w-0 truncate">{result.toolDecision.query ?? "-"}</dd>
              </div>
              <div>
                <dt className="font-semibold text-zinc-800">{t("chatConsole.cacheSimilarity")}</dt>
                <dd className="mt-1">{result.cacheSimilarity === null ? "-" : result.cacheSimilarity.toFixed(3)}</dd>
              </div>
              {result.toolDecision.prompt && (
                <div className="sm:col-span-2">
                  <dt className="font-semibold text-zinc-800">{t("chatConsole.prompt")}</dt>
                  <dd className="mt-1 line-clamp-3">{result.toolDecision.prompt}</dd>
                </div>
              )}
            </dl>
            <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-800">{result.reply}</p>
            {result.images.length > 0 && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {result.images.map((image, index) => (
                  <img
                    alt={t("chatConsole.generatedImage", { index: index + 1 })}
                    className="aspect-square w-full rounded-lg border border-cyan-200 object-cover"
                    key={`${image.mediaType}-${index}`}
                    src={`data:${image.mediaType};base64,${image.base64}`}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SearchDiagnosticsPanel({ canWrite }: { canWrite: boolean }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("雷电真 原神 设定");
  const [maxResults, setMaxResults] = useState(4);
  const [tools, setTools] = useState<BootToolDescriptor[]>([]);
  const [result, setResult] = useState<WebSearchResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadTools() {
      try {
        const response = await apiClient.api.search.tools.$get();
        const payload = await readJson<{ tools: BootToolDescriptor[] }>(response);
        if (!cancelled) {
          setTools(payload.tools);
        }
      } catch (requestError) {
        if (!cancelled) {
          setToolsError(errorMessage(requestError));
        }
      }
    }
    loadTools();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite) {
      return;
    }
    if (!query.trim()) {
      return;
    }

    setPending(true);
    setError(null);
    setResult(null);
    try {
      const response = await apiClient.api.search.$post({
        json: {
          query: query.trim(),
          maxResults
        }
      });
      setResult(await readJson<WebSearchResponse>(response));
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("searchDiagnostics.title")}</CardTitle>
        <CardDescription>{t("searchDiagnostics.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={submit}>
          <Label>
            {t("searchDiagnostics.query")}
            <Input value={query} onChange={(event) => setQuery(event.target.value)} />
          </Label>
          <Label>
            {t("system.maxResults")}
            <Input max={10} min={1} type="number" value={maxResults} onChange={(event) => setMaxResults(Number(event.target.value))} />
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={toolsError ? "warning" : "info"}>{t("searchDiagnostics.tools", { count: tools.length })}</Badge>
            {toolsError && <span className="min-w-0 truncate text-xs text-zinc-500">{toolsError}</span>}
          </div>
          <ErrorBanner message={error} />
          {!canWrite && <Badge tone="warning">{t("common.readOnly")}</Badge>}
          <Button disabled={!canWrite || pending || !query.trim()} type="submit">
            <Search className="size-4" />
            {pending ? t("common.checking") : t("searchDiagnostics.run")}
          </Button>
        </form>
        {result && (
          <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={result.status === "completed" ? "success" : result.status === "partial" ? "warning" : "danger"}>
                {result.status}
              </Badge>
              <Badge>{result.provider}</Badge>
              <Badge>{result.channels.join(", ") || "-"}</Badge>
            </div>
            {result.failures.length > 0 && <p className="mt-2 text-xs leading-5 text-amber-700">{result.failures.join("；")}</p>}
            <div className="mt-3 grid gap-2">
              {result.results.map((item) => (
                <article className="rounded-md border border-zinc-200 bg-white p-2" key={item.url}>
                  <a className="text-sm font-semibold text-cyan-800 hover:underline" href={item.url} rel="noreferrer" target="_blank">
                    {item.title}
                  </a>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-600">{item.snippet ?? item.source ?? item.url}</p>
                </article>
              ))}
              {result.results.length === 0 && <p className="py-3 text-center text-sm text-zinc-500">{t("searchDiagnostics.empty")}</p>}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ConversationsPage({ user }: { user: AdminUserDto }) {
  const { t, formatMessageRole, formatDate } = useI18n();
  const { data, total, loading, error, reload } = useResourceList<MessageDto>("messages", 20);
  const canWrite = canWriteConversations(user);

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
        <div className="grid content-start gap-5">
          <ChatConsole canWrite={canWrite} />
          <SearchDiagnosticsPanel canWrite={canWrite} />
        </div>
      </div>
    </ResourcePage>
  );
}
