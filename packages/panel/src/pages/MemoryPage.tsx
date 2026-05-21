import type { MemoryDto } from "@raiden/shared";
import { ResourcePage } from "../components/page.js";
import { Badge } from "../components/ui/badge.js";
import { Card, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { useResourceList } from "../hooks/useResourceList.js";
import { useI18n } from "../lib/i18n.js";

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
