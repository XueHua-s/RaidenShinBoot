import { useCallback, useEffect, useState } from "react";
import { Bot, Brain, FileClock, MessageSquareText, RefreshCw, Server, Users } from "lucide-react";
import type { AuditLogDto, MemoryDto, MessageDto, SystemStatus, TelegramChatDto, TelegramUserDto } from "@raiden/shared";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { ErrorBanner, MetricCard, statusTone } from "../components/page.js";
import { useResourceList } from "../hooks/useResourceList.js";
import { apiClient, readJson } from "../lib/apiClient.js";
import { errorMessage } from "../lib/utils.js";
import { useI18n } from "../lib/i18n.js";

export function DashboardPage() {
  const { t, formatStatus, formatDate } = useI18n();
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [systemError, setSystemError] = useState<string | null>(null);
  const users = useResourceList<TelegramUserDto>("users", 5);
  const messages = useResourceList<MessageDto>("messages", 5);
  const memories = useResourceList<MemoryDto>("memories", 5);
  const chats = useResourceList<TelegramChatDto>("telegram-chats", 5);
  const audit = useResourceList<AuditLogDto>("audit-logs", 5);

  const load = useCallback(async () => {
    setSystemError(null);
    try {
      const systemResponse = await apiClient.api.system.status.$get();
      setSystem(await readJson<SystemStatus>(systemResponse));
    } catch (requestError) {
      setSystemError(errorMessage(requestError));
    }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([load(), users.reload(), messages.reload(), memories.reload(), chats.reload(), audit.reload()]);
  }, [audit.reload, chats.reload, load, memories.reload, messages.reload, users.reload]);

  useEffect(() => {
    load();
  }, [load]);

  const error = systemError ?? users.error ?? messages.error ?? memories.error ?? chats.error ?? audit.error;

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-zinc-950">{t("dashboard.title")}</h2>
          <p className="mt-1 text-sm text-zinc-500">{t("dashboard.description")}</p>
        </div>
        <Button onClick={refresh} variant="outline">
          <RefreshCw className="size-4" />
          {t("common.refresh")}
        </Button>
      </div>
      <ErrorBanner message={error} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Users} label={t("dashboard.users")} value={users.total} detail={t("dashboard.usersDetail")} tone="info" />
        <MetricCard icon={MessageSquareText} label={t("dashboard.messages")} value={messages.total} detail={t("dashboard.messagesDetail")} />
        <MetricCard icon={Brain} label={t("dashboard.memories")} value={memories.total} detail={t("dashboard.memoriesDetail")} tone="success" />
        <MetricCard icon={Bot} label={t("dashboard.chats")} value={chats.total} detail={t("dashboard.chatsDetail")} />
      </div>
      <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <div>
              <CardTitle>{t("dashboard.runtime")}</CardTitle>
              <CardDescription>{t("dashboard.runtimeDescription")}</CardDescription>
            </div>
            <Badge tone={system?.ok ? "success" : "warning"}>{formatStatus(system?.ok ? "online" : "checking")}</Badge>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {[
              [t("runtime.api"), system?.ok ? "online" : "pending"],
              [t("runtime.postgresql"), system?.databaseConfigured ? "configured" : "missing"],
              [t("runtime.botToken"), system?.botTokenConfigured ? "configured" : "missing"],
              [t("runtime.search"), system?.bootSearchProvider ?? "disabled"]
            ].map(([label, value]) => (
              <div className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2" key={label}>
                <span className="text-sm font-medium text-zinc-600">{label}</span>
                <Badge tone={statusTone(value ?? "pending")}>{formatStatus(value)}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("dashboard.recentAudit")}</CardTitle>
            <CardDescription>{t("dashboard.recentAuditDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {audit.data.map((item) => (
              <div className="rounded-md border border-zinc-200 px-3 py-2" key={item.id}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-zinc-900">{item.action}</span>
                  <span className="text-xs text-zinc-500">{formatDate(item.createdAt)}</span>
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  {item.actorUsername ?? t("common.system")} {"->"} {item.targetType}
                  {item.targetId ? `:${item.targetId}` : ""}
                </p>
              </div>
            ))}
            {audit.data.length === 0 && <p className="py-6 text-center text-sm text-zinc-500">{t("dashboard.noAudit")}</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
