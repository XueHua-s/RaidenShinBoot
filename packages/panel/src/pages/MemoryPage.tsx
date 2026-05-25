import { FormEvent, useState } from "react";
import { Search } from "lucide-react";
import type { MemoryDto, MemorySearchHitDto, MemorySearchResponse } from "@raiden/shared";
import { ErrorBanner, ResourcePage } from "../components/page.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input, Label, Textarea } from "../components/ui/input.js";
import { useResourceList } from "../hooks/useResourceList.js";
import { apiClient, readJson } from "../lib/apiClient.js";
import { useI18n } from "../lib/i18n.js";
import { errorMessage } from "../lib/utils.js";

function MemoryRecallPanel() {
  const { t, formatDate } = useI18n();
  const [telegramUserId, setTelegramUserId] = useState("local-traveler");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(6);
  const [results, setResults] = useState<MemorySearchHitDto[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!telegramUserId.trim() || !query.trim()) {
      return;
    }

    setPending(true);
    setError(null);
    setResults([]);
    setHasSearched(true);
    try {
      const response = await apiClient.api.memories.search.$post({
        json: {
          telegramUserId: telegramUserId.trim(),
          query: query.trim(),
          limit
        }
      });
      const payload = await readJson<MemorySearchResponse>(response);
      setResults(payload.data);
    } catch (requestError) {
      setResults([]);
      setError(errorMessage(requestError));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("memory.recallTitle")}</CardTitle>
        <CardDescription>{t("memory.recallDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={submit}>
          <div className="grid gap-3 md:grid-cols-[1fr_120px]">
            <Label>
              {t("chatConsole.telegramId")}
              <Input value={telegramUserId} onChange={(event) => setTelegramUserId(event.target.value)} />
            </Label>
            <Label>
              {t("memory.limit")}
              <Input max={20} min={1} type="number" value={limit} onChange={(event) => setLimit(Number(event.target.value))} />
            </Label>
          </div>
          <Label>
            {t("memory.query")}
            <Textarea value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("memory.queryPlaceholder")} />
          </Label>
          <ErrorBanner message={error} />
          <Button disabled={pending || !telegramUserId.trim() || !query.trim()} type="submit">
            <Search className="size-4" />
            {pending ? t("common.checking") : t("memory.recall")}
          </Button>
        </form>
        <div className="mt-4 grid gap-3">
          {results.map((memory) => (
            <article className="rounded-lg border border-zinc-200 bg-white p-3" key={memory.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="info">{t("memory.score", { value: memory.score.toFixed(2) })}</Badge>
                  <Badge>{t("memory.importance", { value: memory.importance })}</Badge>
                </div>
                <span className="text-xs text-zinc-500">{formatDate(memory.createdAt)}</span>
              </div>
              <p className="mt-2 text-sm leading-6 text-zinc-800">{memory.summary}</p>
            </article>
          ))}
          {hasSearched && results.length === 0 && <p className="py-4 text-center text-sm text-zinc-500">{t("memory.recallEmpty")}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

export function MemoryPage() {
  const { t, formatDate } = useI18n();
  const { data, total, loading, error, reload } = useResourceList<MemoryDto>("memories", 30);

  return (
    <ResourcePage
      title={t("memory.title")}
      description={t("memory.description")}
      error={error}
      loading={loading}
      onRefresh={reload}
    >
      <MemoryRecallPanel />
      <Card>
        <CardHeader>
          <CardTitle>{t("memory.longTerm")}</CardTitle>
          <CardDescription>{t("memory.count", { count: total })}</CardDescription>
        </CardHeader>
        <div className="grid gap-3 p-4">
          {data.map((memory) => (
            <article className="rounded-lg border border-zinc-200 bg-white p-3" key={memory.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge tone="success">{t("memory.importance", { value: memory.importance })}</Badge>
                <span className="text-xs text-zinc-500">{formatDate(memory.createdAt)}</span>
              </div>
              <p className="mt-2 text-sm leading-6 text-zinc-800">{memory.summary}</p>
              <p className="mt-2 font-mono text-xs text-zinc-400">{memory.telegramUserId}</p>
            </article>
          ))}
          {data.length === 0 && <p className="py-8 text-center text-sm text-zinc-500">{t("memory.empty")}</p>}
        </div>
      </Card>
    </ResourcePage>
  );
}
