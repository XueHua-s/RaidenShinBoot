import { useList } from "@refinedev/core";
import {
  Activity,
  AlertCircle,
  Brain,
  Database,
  MessageSquareText,
  RefreshCw,
  Server,
  Sparkles,
  Users,
  WifiOff,
  Zap
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MemoryDto, MessageDto, TelegramUserDto } from "@raiden/shared";
import { ChatTester } from "./components/ChatTester.js";
import { EmptyState } from "./components/EmptyState.js";
import { Metric } from "./components/Metric.js";
import { StatusPill } from "./components/StatusPill.js";
import { apiClient, readJson } from "./lib/apiClient.js";

type HealthPayload = {
  ok: boolean;
  service: string;
  databaseConfigured: boolean;
  bootBaseUrl: string;
};

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function relayHost(value: string | undefined) {
  if (!value) {
    return "unset";
  }

  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function errorText(error: unknown) {
  if (!error) {
    return null;
  }

  return error instanceof Error ? error.message : String(error);
}

function roleClassName(role: MessageDto["role"]) {
  if (role === "assistant") {
    return "bg-violet-50 text-violet-700";
  }

  if (role === "system") {
    return "bg-amber-50 text-amber-700";
  }

  return "bg-sky-50 text-sky-700";
}

export function App() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const databaseEnabled = Boolean(health?.databaseConfigured);

  const users = useList<TelegramUserDto>({
    resource: "users",
    pagination: { current: 1, pageSize: 8 },
    queryOptions: {
      enabled: databaseEnabled,
      retry: false
    }
  });
  const messages = useList<MessageDto>({
    resource: "messages",
    pagination: { current: 1, pageSize: 8 },
    queryOptions: {
      enabled: databaseEnabled,
      retry: false
    }
  });
  const memories = useList<MemoryDto>({
    resource: "memories",
    pagination: { current: 1, pageSize: 8 },
    queryOptions: {
      enabled: databaseEnabled,
      retry: false
    }
  });

  const loadHealth = useCallback(async () => {
    try {
      const response = await apiClient.api.health.$get();
      const payload = await readJson<HealthPayload>(response);
      setHealth(payload);
      setHealthError(null);
    } catch (requestError) {
      setHealth(null);
      setHealthError(errorText(requestError));
    }
  }, []);

  useEffect(() => {
    loadHealth();
  }, [loadHealth]);

  const userRows = users.data?.data ?? [];
  const messageRows = messages.data?.data ?? [];
  const memoryRows = memories.data?.data ?? [];
  const isLoading = users.isLoading || messages.isLoading || memories.isLoading;
  const dataError = useMemo(
    () => errorText(users.error) ?? errorText(messages.error) ?? errorText(memories.error),
    [users.error, messages.error, memories.error]
  );

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto grid max-w-7xl gap-4 px-4 py-5 sm:px-6 lg:grid-cols-[1fr_auto] lg:items-center lg:px-8">
          <div>
            <p className="text-sm font-medium text-violet-700">RaidenShinBoot</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal text-zinc-950">雷电真 Telegram Boot 工作台</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <StatusPill
              icon={health?.ok ? Activity : WifiOff}
              label="API"
              value={health?.ok ? "online" : healthError ? "offline" : "checking"}
              tone={health?.ok ? "success" : healthError ? "danger" : "neutral"}
            />
            <StatusPill
              icon={Database}
              label="DB"
              value={health?.databaseConfigured ? "configured" : "missing"}
              tone={health?.databaseConfigured ? "success" : "warning"}
            />
            <StatusPill icon={Zap} label="Boot" value={relayHost(health?.bootBaseUrl)} tone="neutral" />
            <button
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold text-zinc-800 transition hover:border-violet-400 hover:text-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-100"
              onClick={() => {
                loadHealth();
                if (databaseEnabled) {
                  users.refetch();
                  messages.refetch();
                  memories.refetch();
                }
              }}
              title="刷新数据"
            >
              <RefreshCw aria-hidden className="size-4" />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[1fr_390px] lg:px-8">
        <section className="grid gap-5">
          {(dataError || healthError) && (
            <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-800">
              <AlertCircle aria-hidden className="mt-0.5 size-5 shrink-0" />
              <p>{dataError ?? healthError}</p>
            </div>
          )}
          {health && !health.databaseConfigured && (
            <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-800">
              <AlertCircle aria-hidden className="mt-0.5 size-5 shrink-0" />
              <p>DATABASE_URL 未配置，数据表已暂停请求。</p>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-3">
            <Metric icon={Users} label="Users" value={users.data?.total ?? 0} detail="Telegram 用户档案" tone="sky" />
            <Metric
              icon={MessageSquareText}
              label="Messages"
              value={messages.data?.total ?? 0}
              detail="用户与真之间的对话"
              tone="violet"
            />
            <Metric icon={Brain} label="Memories" value={memories.data?.total ?? 0} detail="halfvec 长期记忆" tone="emerald" />
          </div>

          <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3">
              <div>
                <h2 className="text-base font-semibold text-zinc-950">Recent Users</h2>
                <p className="mt-1 text-sm text-zinc-500">{users.data?.total ?? 0} profiles indexed</p>
              </div>
              {isLoading && <Server aria-hidden className="size-4 animate-pulse text-emerald-600" />}
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-zinc-100 text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Telegram ID</th>
                    <th className="px-4 py-3 font-semibold">Name</th>
                    <th className="px-4 py-3 font-semibold">Username</th>
                    <th className="px-4 py-3 font-semibold">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {userRows.map((user) => (
                    <tr className="hover:bg-zinc-50" key={user.telegramId}>
                      <td className="px-4 py-3 font-mono text-xs text-zinc-700">{user.telegramId}</td>
                      <td className="px-4 py-3">{[user.firstName, user.lastName].filter(Boolean).join(" ") || "-"}</td>
                      <td className="px-4 py-3 text-zinc-600">{user.username ? `@${user.username}` : "-"}</td>
                      <td className="px-4 py-3 text-zinc-500">{formatDate(user.updatedAt)}</td>
                    </tr>
                  ))}
                  {userRows.length === 0 && (
                    <tr>
                      <td colSpan={4}>
                        <EmptyState icon={Users} title="No users yet" detail="Telegram 对话开始后会出现在这里。" />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
            <div className="border-b border-zinc-200 px-4 py-3">
              <h2 className="text-base font-semibold text-zinc-950">Recent Messages</h2>
              <p className="mt-1 text-sm text-zinc-500">{messages.data?.total ?? 0} records captured</p>
            </div>
            <div className="divide-y divide-zinc-100">
              {messageRows.map((message) => (
                <article className="px-4 py-3 transition hover:bg-zinc-50" key={message.id}>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    <span className={`rounded px-2 py-1 font-medium ${roleClassName(message.role)}`}>{message.role}</span>
                    <span className="font-mono">{message.telegramUserId}</span>
                    <span>{formatDate(message.createdAt)}</span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-800">{message.content}</p>
                </article>
              ))}
              {messageRows.length === 0 && (
                <EmptyState icon={MessageSquareText} title="No messages yet" detail="消息记录会按时间倒序进入这个列表。" />
              )}
            </div>
          </section>
        </section>

        <aside className="grid content-start gap-5">
          <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-zinc-950">Runtime</h2>
                <p className="mt-1 text-sm text-zinc-500">{health?.service ?? "raiden-shin-server"}</p>
              </div>
              <Sparkles aria-hidden className="size-5 text-amber-500" />
            </div>
            <dl className="mt-4 grid gap-3 text-sm">
              <div className="flex items-center justify-between gap-3 rounded-md bg-zinc-50 px-3 py-2">
                <dt className="font-medium text-zinc-600">API</dt>
                <dd className={health?.ok ? "font-semibold text-emerald-700" : "font-semibold text-zinc-500"}>
                  {health?.ok ? "online" : "pending"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md bg-zinc-50 px-3 py-2">
                <dt className="font-medium text-zinc-600">PostgreSQL</dt>
                <dd className={health?.databaseConfigured ? "font-semibold text-emerald-700" : "font-semibold text-amber-700"}>
                  {health?.databaseConfigured ? "configured" : "missing env"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md bg-zinc-50 px-3 py-2">
                <dt className="font-medium text-zinc-600">Relay</dt>
                <dd className="max-w-48 truncate font-semibold text-zinc-700">{relayHost(health?.bootBaseUrl)}</dd>
              </div>
            </dl>
          </section>

          <ChatTester />

          <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
            <div className="border-b border-zinc-200 px-4 py-3">
              <h2 className="text-base font-semibold text-zinc-950">Long-Term Memories</h2>
              <p className="mt-1 text-sm text-zinc-500">{memories.data?.total ?? 0} semantic notes</p>
            </div>
            <div className="divide-y divide-zinc-100">
              {memoryRows.map((memory) => (
                <article className="px-4 py-3 transition hover:bg-zinc-50" key={memory.id}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
                      importance {memory.importance}
                    </span>
                    <span className="text-xs text-zinc-500">{formatDate(memory.createdAt)}</span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-zinc-800">{memory.summary}</p>
                </article>
              ))}
              {memoryRows.length === 0 && <EmptyState icon={Brain} title="No memories yet" detail="稳定偏好和长期目标会沉淀在这里。" />}
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
