import {
  Activity,
  Bot,
  Brain,
  FileClock,
  KeyRound,
  Languages,
  LogOut,
  MessageSquareText,
  RefreshCw,
  Save,
  Search,
  Send,
  Server,
  Settings2,
  Shield,
  ShieldAlert,
  Users,
  Zap
} from "lucide-react";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, NavLink, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import type {
  AdminSessionDto,
  AdminUserDto,
  AuditLogDto,
  ChatResponse,
  MemoryDto,
  MessageDto,
  RuntimeSettings,
  SystemStatus,
  TelegramChatDto,
  TelegramCommandPermissionDto,
  TelegramUserDto
} from "@raiden/shared";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";
import { Input, Label, Textarea } from "./components/ui/input.js";
import { Table, Td, Th } from "./components/ui/table.js";
import { apiClient, readJson, setCsrfToken } from "./lib/apiClient.js";
import { I18nProvider, useI18n, type TranslationKey } from "./lib/i18n.js";
import { cn, errorMessage, formatDate } from "./lib/utils.js";

type ListPayload<T> = {
  data: T[];
  total: number;
};

type AuthState = {
  user: AdminUserDto | null;
  loading: boolean;
};

type AppShellProps = {
  user: AdminUserDto;
  onLogout: () => Promise<void>;
};

const navItems = [
  { to: "/", labelKey: "nav.dashboard", icon: Activity, permission: "all" },
  { to: "/telegram", labelKey: "nav.telegram", icon: Bot, permission: "all" },
  { to: "/conversations", labelKey: "nav.conversations", icon: MessageSquareText, permission: "all" },
  { to: "/memory", labelKey: "nav.memory", icon: Brain, permission: "all" },
  { to: "/security", labelKey: "nav.security", icon: Shield, permission: "super_admin" },
  { to: "/audit", labelKey: "nav.audit", icon: FileClock, permission: "all" },
  { to: "/system", labelKey: "nav.system", icon: Server, permission: "all" }
] as const;

function canSee(item: (typeof navItems)[number], user: AdminUserDto) {
  return item.permission === "all" || user.role === "super_admin";
}

function statusTone(value: string) {
  if (["online", "configured", "approved", "active", "completed"].includes(value)) {
    return "success";
  }
  if (["pending", "missing", "muted", "skipped"].includes(value)) {
    return "warning";
  }
  if (["blocked", "disabled", "failed", "offline"].includes(value)) {
    return "danger";
  }
  return "neutral";
}

function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td className="px-4 py-10 text-center text-sm text-zinc-500" colSpan={colSpan}>
        {children}
      </td>
    </tr>
  );
}

function LoadingPanel() {
  const { t } = useI18n();

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--app-bg)] text-zinc-900">
      <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 shadow-sm">
        <RefreshCw className="size-4 animate-spin text-cyan-600" />
        <span className="text-sm font-semibold">{t("common.loadingSession")}</span>
      </div>
    </main>
  );
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }

  return (
    <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-800">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <p>{message}</p>
    </div>
  );
}

function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className="inline-flex h-9 items-center gap-1 rounded-md border border-zinc-300 bg-white p-1">
      <Languages className="ml-2 size-4 text-cyan-700" />
      {(["zh", "en"] as const).map((value) => (
        <button
          className={cn(
            "h-7 rounded px-2 text-xs font-semibold transition",
            locale === value ? "bg-zinc-950 text-white" : "text-zinc-600 hover:bg-zinc-100"
          )}
          key={value}
          type="button"
          onClick={() => setLocale(value)}
        >
          {t(value === "zh" ? "lang.zh" : "lang.en")}
        </button>
      ))}
    </div>
  );
}

function LoginPage({ onLogin }: { onLogin: (user: AdminUserDto, csrfToken: string) => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await apiClient.api.auth.login.$post({
        json: { username, password }
      });
      const payload = await readJson<{ user: AdminUserDto; csrfToken: string }>(response);
      onLogin(payload.user, payload.csrfToken);
      navigate("/", { replace: true });
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-screen bg-[var(--app-bg)] text-zinc-950 lg:grid-cols-[minmax(360px,0.9fr)_1.1fr]">
      <section className="flex min-h-screen items-center justify-center px-6 py-10">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-lg bg-zinc-950 text-cyan-300">
              <Shield className="size-5" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-700">RaidenShinBoot</p>
              <h1 className="text-2xl font-semibold tracking-normal text-zinc-950">{t("login.productName")}</h1>
            </div>
            <div className="ml-auto">
              <LanguageSwitcher />
            </div>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>{t("login.cardTitle")}</CardTitle>
              <CardDescription>{t("login.cardDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-4" onSubmit={submit}>
                <Label>
                  {t("login.username")}
                  <Input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
                </Label>
                <Label>
                  {t("login.password")}
                  <Input
                    autoComplete="current-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Label>
                <ErrorBanner message={error} />
                <Button disabled={pending || !username.trim() || password.length < 8} type="submit">
                  <KeyRound className="size-4" />
                  {pending ? t("login.pending") : t("login.submit")}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </section>
      <section className="hidden border-l border-zinc-200 bg-zinc-950 p-10 text-white lg:grid lg:content-between">
        <div className="max-w-xl">
          <Badge tone="info">{t("login.badge")}</Badge>
          <h2 className="mt-6 text-4xl font-semibold tracking-normal">{t("login.heroTitle")}</h2>
          <p className="mt-5 max-w-lg text-sm leading-7 text-zinc-300">{t("login.heroDescription")}</p>
        </div>
        <div className="grid grid-cols-3 gap-3 text-xs text-zinc-300">
          <div className="rounded-lg border border-white/10 bg-white/5 p-4">
            <Shield className="mb-3 size-4 text-cyan-300" />
            {t("login.featureRbac")}
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 p-4">
            <Bot className="mb-3 size-4 text-cyan-300" />
            {t("login.featureGroupPolicy")}
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 p-4">
            <FileClock className="mb-3 size-4 text-cyan-300" />
            {t("login.featureAudit")}
          </div>
        </div>
      </section>
    </main>
  );
}

function AppShell({ user, onLogout }: AppShellProps) {
  const { t, formatRole } = useI18n();
  const navigate = useNavigate();

  async function logout() {
    await onLogout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="min-h-screen bg-[var(--app-bg)] text-zinc-950">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-zinc-200 bg-white lg:block">
        <div className="flex h-16 items-center gap-3 border-b border-zinc-200 px-5">
          <div className="grid size-9 place-items-center rounded-md bg-zinc-950 text-cyan-300">
            <Zap className="size-4" />
          </div>
          <div>
            <p className="text-sm font-semibold text-zinc-950">RaidenShinBoot</p>
            <p className="text-xs text-zinc-500">{t("shell.platform")}</p>
          </div>
        </div>
        <nav className="grid gap-1 p-3">
          {navItems.filter((item) => canSee(item, user)).map((item) => (
            <NavLink
              className={({ isActive }) =>
                cn(
                  "flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition",
                  isActive ? "bg-zinc-950 text-white" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950"
                )
              }
              end={item.to === "/"}
              key={item.to}
              to={item.to}
            >
              <item.icon className="size-4" />
              {t(item.labelKey)}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white/90 backdrop-blur">
          <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-700">{t("shell.eyebrow")}</p>
              <h1 className="text-lg font-semibold text-zinc-950">{t("shell.title")}</h1>
            </div>
            <div className="flex items-center gap-2">
              <LanguageSwitcher />
              <Badge tone={user.status === "active" ? "success" : "danger"}>{formatRole(user.role)}</Badge>
              <span className="hidden text-sm font-medium text-zinc-700 sm:inline">{user.displayName ?? user.username}</span>
              <Button onClick={logout} size="sm" variant="outline">
                <LogOut className="size-4" />
                {t("common.logout")}
              </Button>
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-4 pb-3 lg:hidden">
            {navItems.filter((item) => canSee(item, user)).map((item) => (
              <NavLink
                className={({ isActive }) =>
                  cn(
                    "inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-md px-3 text-sm font-medium",
                    isActive ? "bg-zinc-950 text-white" : "bg-white text-zinc-600"
                  )
                }
                end={item.to === "/"}
                key={item.to}
                to={item.to}
              >
              <item.icon className="size-4" />
                {t(item.labelKey)}
              </NavLink>
            ))}
          </nav>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  tone = "neutral"
}: {
  icon: typeof Activity;
  label: string;
  value: number | string;
  detail: string;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-zinc-500">{label}</p>
          <p className="mt-1 text-3xl font-semibold tracking-normal text-zinc-950">{value}</p>
          <p className="mt-1 text-xs text-zinc-500">{detail}</p>
        </div>
        <div className="grid size-11 place-items-center rounded-lg border border-zinc-200 bg-zinc-50">
          <Icon className={cn("size-5", tone === "info" && "text-cyan-700", tone === "success" && "text-emerald-700")} />
        </div>
      </CardContent>
    </Card>
  );
}

function useListLoader<T>(loader: () => Promise<ListPayload<T>>, deps: unknown[] = []) {
  const [data, setData] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await loader();
      setData(payload.data);
      setTotal(payload.total);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, deps);

  useEffect(() => {
    load();
  }, [load]);

  return { data, total, loading, error, reload: load };
}

function DashboardPage() {
  const { t, formatStatus } = useI18n();
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [users, setUsers] = useState<ListPayload<TelegramUserDto>>({ data: [], total: 0 });
  const [messages, setMessages] = useState<ListPayload<MessageDto>>({ data: [], total: 0 });
  const [memories, setMemories] = useState<ListPayload<MemoryDto>>({ data: [], total: 0 });
  const [chats, setChats] = useState<ListPayload<TelegramChatDto>>({ data: [], total: 0 });
  const [audit, setAudit] = useState<ListPayload<AuditLogDto>>({ data: [], total: 0 });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [systemResponse, usersResponse, messagesResponse, memoriesResponse, chatsResponse, auditResponse] = await Promise.all([
        apiClient.api.system.status.$get(),
        apiClient.api.users.$get({ query: { limit: "5", offset: "0" } }),
        apiClient.api.messages.$get({ query: { limit: "5", offset: "0" } }),
        apiClient.api.memories.$get({ query: { limit: "5", offset: "0" } }),
        apiClient.api.telegram.chats.$get({ query: { limit: "5", offset: "0" } }),
        apiClient.api["audit-logs"].$get({ query: { limit: "5", offset: "0" } })
      ]);
      setSystem(await readJson<SystemStatus>(systemResponse));
      setUsers(await readJson<ListPayload<TelegramUserDto>>(usersResponse));
      setMessages(await readJson<ListPayload<MessageDto>>(messagesResponse));
      setMemories(await readJson<ListPayload<MemoryDto>>(memoriesResponse));
      setChats(await readJson<ListPayload<TelegramChatDto>>(chatsResponse));
      setAudit(await readJson<ListPayload<AuditLogDto>>(auditResponse));
    } catch (requestError) {
      setError(errorMessage(requestError));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-zinc-950">{t("dashboard.title")}</h2>
          <p className="mt-1 text-sm text-zinc-500">{t("dashboard.description")}</p>
        </div>
        <Button onClick={load} variant="outline">
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

function TelegramPage() {
  const { t, formatStatus, formatPolicy, formatChatType } = useI18n();
  const loader = useCallback(async () => {
    const response = await apiClient.api.telegram.chats.$get({ query: { limit: "50", offset: "0" } });
    return readJson<ListPayload<TelegramChatDto>>(response);
  }, []);
  const commandLoader = useCallback(async () => {
    const response = await apiClient.api.telegram["command-permissions"].$get({ query: { limit: "100", offset: "0" } });
    return readJson<ListPayload<TelegramCommandPermissionDto>>(response);
  }, []);
  const { data, total, loading, error, reload } = useListLoader(loader, [loader]);
  const commandPermissions = useListLoader(commandLoader, [commandLoader]);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [commandMutationError, setCommandMutationError] = useState<string | null>(null);
  const [commandChatId, setCommandChatId] = useState("");
  const [commandName, setCommandName] = useState("start");
  const [commandEnabled, setCommandEnabled] = useState(true);

  async function updateChat(chatId: string, patch: Partial<Pick<TelegramChatDto, "status" | "policy">>) {
    setMutationError(null);
    try {
      const response = await apiClient.api.telegram.chats[":chatId"].$patch({
        param: { chatId },
        json: patch
      });
      await readJson<{ data: TelegramChatDto }>(response);
      await reload();
    } catch (requestError) {
      setMutationError(errorMessage(requestError));
    }
  }

  async function saveCommandPermission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!commandName.trim()) {
      return;
    }

    setCommandMutationError(null);
    try {
      const response = await apiClient.api.telegram["command-permissions"].$put({
        json: {
          chatId: commandChatId || null,
          command: commandName.trim().replace(/^\//, "").toLowerCase(),
          enabled: commandEnabled
        }
      });
      await readJson<{ data: TelegramCommandPermissionDto }>(response);
      await commandPermissions.reload();
    } catch (requestError) {
      setCommandMutationError(errorMessage(requestError));
    }
  }

  return (
    <ResourcePage
      title={t("telegram.title")}
      description={t("telegram.description")}
      error={error ?? mutationError ?? commandPermissions.error ?? commandMutationError}
      loading={loading || commandPermissions.loading}
      onRefresh={async () => {
        await Promise.all([reload(), commandPermissions.reload()]);
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>{t("telegram.chats")}</CardTitle>
          <CardDescription>{t("telegram.chatCount", { count: total })}</CardDescription>
        </CardHeader>
        <div className="overflow-x-auto">
          <Table>
            <thead className="bg-zinc-50">
              <tr>
                <Th>{t("telegram.chat")}</Th>
                <Th>{t("telegram.type")}</Th>
                <Th>{t("common.status")}</Th>
                <Th>{t("telegram.policy")}</Th>
                <Th>{t("common.updated")}</Th>
                <Th className="text-right">{t("common.actions")}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {data.map((chat) => (
                <tr className="hover:bg-zinc-50" key={chat.chatId}>
                  <Td>
                    <div className="font-mono text-xs text-zinc-900">{chat.chatId}</div>
                    <div className="mt-1 text-xs text-zinc-500">{chat.title ?? chat.username ?? "-"}</div>
                  </Td>
                  <Td>{formatChatType(chat.type)}</Td>
                  <Td>
                    <Badge tone={statusTone(chat.status)}>{formatStatus(chat.status)}</Badge>
                  </Td>
                  <Td>
                    <select
                      className="h-8 rounded-md border border-zinc-300 bg-white px-2 text-xs font-semibold text-zinc-800 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                      value={chat.policy}
                      onChange={(event) =>
                        updateChat(chat.chatId, { policy: event.target.value as TelegramChatDto["policy"] })
                      }
                    >
                      <option value="allow_all_commands">{formatPolicy("allow_all_commands")}</option>
                      <option value="commands_only">{formatPolicy("commands_only")}</option>
                      <option value="read_only">{formatPolicy("read_only")}</option>
                      <option value="disabled">{formatPolicy("disabled")}</option>
                    </select>
                  </Td>
                  <Td>{formatDate(chat.updatedAt)}</Td>
                  <Td>
                    <div className="flex justify-end gap-2">
                      <Button onClick={() => updateChat(chat.chatId, { status: "approved" })} size="sm" variant="secondary">
                        {t("telegram.approve")}
                      </Button>
                      <Button onClick={() => updateChat(chat.chatId, { status: "muted" })} size="sm" variant="outline">
                        {t("telegram.mute")}
                      </Button>
                      <Button onClick={() => updateChat(chat.chatId, { status: "blocked" })} size="sm" variant="destructive">
                        {t("telegram.block")}
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
              {data.length === 0 && <EmptyRow colSpan={6}>{t("telegram.empty")}</EmptyRow>}
            </tbody>
          </Table>
        </div>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("telegram.commandPermissions")}</CardTitle>
          <CardDescription>{t("telegram.commandPermissionDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <form className="grid gap-3 xl:grid-cols-[1fr_180px_160px_auto]" onSubmit={saveCommandPermission}>
            <Label>
              {t("telegram.scope")}
              <select
                className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                value={commandChatId}
                onChange={(event) => setCommandChatId(event.target.value)}
              >
                <option value="">{t("telegram.globalScope")}</option>
                {data.map((chat) => (
                  <option key={chat.chatId} value={chat.chatId}>
                    {chat.title ?? chat.username ?? chat.chatId}
                  </option>
                ))}
              </select>
            </Label>
            <Label>
              {t("telegram.command")}
              <Input value={commandName} onChange={(event) => setCommandName(event.target.value)} placeholder="start" />
            </Label>
            <label className="grid gap-1.5 text-sm font-medium text-zinc-700">
              {t("telegram.permissionState")}
              <span className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold text-zinc-800">
                <input
                  checked={commandEnabled}
                  className="size-4 accent-cyan-600"
                  type="checkbox"
                  onChange={(event) => setCommandEnabled(event.target.checked)}
                />
                {commandEnabled ? t("telegram.allow") : t("telegram.deny")}
              </span>
            </label>
            <div className="flex items-end">
              <Button className="w-full" disabled={!commandName.trim()} type="submit">
                <Save className="size-4" />
                {t("telegram.saveRule")}
              </Button>
            </div>
          </form>
          <div className="overflow-x-auto">
            <Table>
              <thead className="bg-zinc-50">
                <tr>
                  <Th>{t("telegram.scope")}</Th>
                  <Th>{t("telegram.command")}</Th>
                  <Th>{t("telegram.permissionState")}</Th>
                  <Th>{t("common.updated")}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {commandPermissions.data.map((permission) => (
                  <tr className="hover:bg-zinc-50" key={permission.id}>
                    <Td>
                      {permission.chatId ? (
                        <span className="font-mono text-xs text-zinc-900">{permission.chatId}</span>
                      ) : (
                        t("telegram.globalScope")
                      )}
                    </Td>
                    <Td>
                      <span className="font-mono text-xs text-zinc-900">/{permission.command}</span>
                    </Td>
                    <Td>
                      <Badge tone={permission.enabled ? "success" : "danger"}>
                        {formatStatus(permission.enabled ? "enabled" : "disabled")}
                      </Badge>
                    </Td>
                    <Td>{formatDate(permission.updatedAt)}</Td>
                  </tr>
                ))}
                {commandPermissions.data.length === 0 && <EmptyRow colSpan={4}>{t("telegram.commandPermissionEmpty")}</EmptyRow>}
              </tbody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </ResourcePage>
  );
}

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

function ConversationsPage() {
  const { t, formatMessageRole } = useI18n();
  const messagesLoader = useCallback(async () => {
    const response = await apiClient.api.messages.$get({ query: { limit: "20", offset: "0" } });
    return readJson<ListPayload<MessageDto>>(response);
  }, []);
  const { data, total, loading, error, reload } = useListLoader(messagesLoader, [messagesLoader]);

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

function MemoryPage() {
  const { t } = useI18n();
  const loader = useCallback(async () => {
    const response = await apiClient.api.memories.$get({ query: { limit: "30", offset: "0" } });
    return readJson<ListPayload<MemoryDto>>(response);
  }, []);
  const { data, total, loading, error, reload } = useListLoader(loader, [loader]);

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

function SecurityPage({ user }: { user: AdminUserDto }) {
  const { t, formatRole, formatStatus } = useI18n();
  const adminsLoader = useCallback(async () => {
    const response = await apiClient.api["admin-users"].$get({ query: { limit: "50", offset: "0" } });
    return readJson<ListPayload<AdminUserDto>>(response);
  }, []);
  const sessionsLoader = useCallback(async () => {
    const response = await apiClient.api["admin-sessions"].$get({ query: { limit: "20", offset: "0" } });
    return readJson<ListPayload<AdminSessionDto>>(response);
  }, []);
  const admins = useListLoader(adminsLoader, [adminsLoader]);
  const sessions = useListLoader(sessionsLoader, [sessionsLoader]);
  const [form, setForm] = useState({ username: "", displayName: "", password: "", role: "operator" as AdminUserDto["role"] });
  const [mutationError, setMutationError] = useState<string | null>(null);

  if (user.role !== "super_admin") {
    return <Navigate to="/" replace />;
  }

  async function createAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMutationError(null);
    try {
      const response = await apiClient.api["admin-users"].$post({
        json: {
          username: form.username,
          displayName: form.displayName || undefined,
          password: form.password,
          role: form.role
        }
      });
      await readJson<{ data: AdminUserDto }>(response);
      setForm({ username: "", displayName: "", password: "", role: "operator" });
      await admins.reload();
    } catch (requestError) {
      setMutationError(errorMessage(requestError));
    }
  }

  async function setAdminStatus(id: string, status: AdminUserDto["status"]) {
    setMutationError(null);
    try {
      const response = await apiClient.api["admin-users"][":id"].$patch({
        param: { id },
        json: { status }
      });
      await readJson<{ data: AdminUserDto }>(response);
      await admins.reload();
    } catch (requestError) {
      setMutationError(errorMessage(requestError));
    }
  }

  return (
    <ResourcePage
      title={t("security.title")}
      description={t("security.description")}
      error={admins.error ?? sessions.error ?? mutationError}
      loading={admins.loading || sessions.loading}
      onRefresh={() => {
        admins.reload();
        sessions.reload();
      }}
    >
      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader>
            <CardTitle>{t("security.adminAccounts")}</CardTitle>
            <CardDescription>{t("security.accountCount", { count: admins.total })}</CardDescription>
          </CardHeader>
          <div className="overflow-x-auto">
            <Table>
              <thead className="bg-zinc-50">
                <tr>
                  <Th>{t("security.admin")}</Th>
                  <Th>{t("common.role")}</Th>
                  <Th>{t("common.status")}</Th>
                  <Th>{t("security.lastLogin")}</Th>
                  <Th className="text-right">{t("common.actions")}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {admins.data.map((admin) => (
                  <tr className="hover:bg-zinc-50" key={admin.id}>
                    <Td>
                      <div className="font-semibold text-zinc-950">{admin.displayName ?? admin.username}</div>
                      <div className="text-xs text-zinc-500">{admin.username}</div>
                    </Td>
                    <Td>
                      <Badge tone={admin.role === "super_admin" ? "ink" : "neutral"}>{formatRole(admin.role)}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={statusTone(admin.status)}>{formatStatus(admin.status)}</Badge>
                    </Td>
                    <Td>{formatDate(admin.lastLoginAt)}</Td>
                    <Td>
                      <div className="flex justify-end gap-2">
                        <Button
                          disabled={admin.id === user.id}
                          onClick={() => setAdminStatus(admin.id, admin.status === "active" ? "disabled" : "active")}
                          size="sm"
                          variant={admin.status === "active" ? "destructive" : "secondary"}
                        >
                          {admin.status === "active" ? t("security.disable") : t("security.enable")}
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("security.createAdmin")}</CardTitle>
            <CardDescription>{t("security.createDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-3" onSubmit={createAdmin}>
              <Label>
                {t("security.username")}
                <Input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
              </Label>
              <Label>
                {t("security.displayName")}
                <Input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
              </Label>
              <Label>
                {t("security.password")}
                <Input
                  type="password"
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                />
              </Label>
              <Label>
                {t("common.role")}
                <select
                  className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                  value={form.role}
                  onChange={(event) => setForm({ ...form, role: event.target.value as AdminUserDto["role"] })}
                >
                  <option value="operator">{formatRole("operator")}</option>
                  <option value="auditor">{formatRole("auditor")}</option>
                  <option value="super_admin">{formatRole("super_admin")}</option>
                </select>
              </Label>
              <Button disabled={!form.username.trim() || form.password.length < 12} type="submit">
                {t("common.create")}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("security.recentSessions")}</CardTitle>
          <CardDescription>{t("security.sessionCount", { count: sessions.total })}</CardDescription>
        </CardHeader>
        <div className="overflow-x-auto">
          <Table>
            <thead className="bg-zinc-50">
              <tr>
                <Th>{t("common.user")}</Th>
                <Th>{t("common.role")}</Th>
                <Th>{t("common.created")}</Th>
                <Th>{t("security.expires")}</Th>
                <Th>{t("common.status")}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {sessions.data.map((session) => (
                <tr key={session.id}>
                  <Td>{session.username}</Td>
                  <Td>{formatRole(session.role)}</Td>
                  <Td>{formatDate(session.createdAt)}</Td>
                  <Td>{formatDate(session.expiresAt)}</Td>
                  <Td>
                    <Badge tone={session.revokedAt ? "danger" : "success"}>{formatStatus(session.revokedAt ? "revoked" : "active")}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </Card>
    </ResourcePage>
  );
}

function AuditPage() {
  const { t } = useI18n();
  const loader = useCallback(async () => {
    const response = await apiClient.api["audit-logs"].$get({ query: { limit: "50", offset: "0" } });
    return readJson<ListPayload<AuditLogDto>>(response);
  }, []);
  const { data, total, loading, error, reload } = useListLoader(loader, [loader]);

  return (
    <ResourcePage title={t("audit.title")} description={t("audit.description")} error={error} loading={loading} onRefresh={reload}>
      <Card>
        <CardHeader>
          <CardTitle>{t("audit.log")}</CardTitle>
          <CardDescription>{t("audit.count", { count: total })}</CardDescription>
        </CardHeader>
        <div className="overflow-x-auto">
          <Table>
            <thead className="bg-zinc-50">
              <tr>
                <Th>{t("audit.action")}</Th>
                <Th>{t("audit.actor")}</Th>
                <Th>{t("audit.target")}</Th>
                <Th>{t("audit.ip")}</Th>
                <Th>{t("common.created")}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {data.map((item) => (
                <tr className="hover:bg-zinc-50" key={item.id}>
                  <Td>
                    <Badge tone="info">{item.action}</Badge>
                  </Td>
                  <Td>{item.actorUsername ?? t("common.system")}</Td>
                  <Td>
                    {item.targetType}
                    {item.targetId ? <span className="font-mono text-xs text-zinc-500">:{item.targetId}</span> : null}
                  </Td>
                  <Td>{item.ipAddress ?? "-"}</Td>
                  <Td>{formatDate(item.createdAt)}</Td>
                </tr>
              ))}
              {data.length === 0 && <EmptyRow colSpan={5}>{t("audit.empty")}</EmptyRow>}
            </tbody>
          </Table>
        </div>
      </Card>
    </ResourcePage>
  );
}

type RuntimeSettingsForm = Pick<
  RuntimeSettings,
  | "gatewayPreset"
  | "bootBaseUrl"
  | "bootChatBaseUrl"
  | "bootEmbeddingBaseUrl"
  | "bootImageBaseUrl"
  | "bootSearchBaseUrl"
  | "bootChatModel"
  | "bootEmbeddingModel"
  | "bootImageModel"
  | "bootSearchProvider"
  | "bootSearchMaxResults"
  | "bootSearchDepth"
>;

type RuntimeSecretKey = keyof RuntimeSettings["secrets"];

const runtimeSecretLabels: Array<[RuntimeSecretKey, TranslationKey]> = [
  ["bootApiKey", "system.defaultApiKey"],
  ["bootChatApiKey", "system.chatApiKey"],
  ["bootEmbeddingApiKey", "system.embeddingApiKey"],
  ["bootImageApiKey", "system.imageApiKey"],
  ["bootSearchApiKey", "system.searchApiKey"]
];

const emptyRuntimeSecrets = runtimeSecretLabels.reduce(
  (accumulator, [key]) => ({
    ...accumulator,
    [key]: ""
  }),
  {} as Record<RuntimeSecretKey, string>
);

const emptyRuntimeSecretClears = runtimeSecretLabels.reduce(
  (accumulator, [key]) => ({
    ...accumulator,
    [key]: false
  }),
  {} as Record<RuntimeSecretKey, boolean>
);

function settingsToForm(settings: RuntimeSettings): RuntimeSettingsForm {
  return {
    gatewayPreset: settings.gatewayPreset,
    bootBaseUrl: settings.bootBaseUrl,
    bootChatBaseUrl: settings.bootChatBaseUrl,
    bootEmbeddingBaseUrl: settings.bootEmbeddingBaseUrl,
    bootImageBaseUrl: settings.bootImageBaseUrl,
    bootSearchBaseUrl: settings.bootSearchBaseUrl,
    bootChatModel: settings.bootChatModel,
    bootEmbeddingModel: settings.bootEmbeddingModel,
    bootImageModel: settings.bootImageModel,
    bootSearchProvider: settings.bootSearchProvider,
    bootSearchMaxResults: settings.bootSearchMaxResults,
    bootSearchDepth: settings.bootSearchDepth
  };
}

function SystemPage() {
  const { t, formatStatus, formatSearchProvider, formatDepth } = useI18n();
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [form, setForm] = useState<RuntimeSettingsForm | null>(null);
  const [secretValues, setSecretValues] = useState<Record<RuntimeSecretKey, string>>(emptyRuntimeSecrets);
  const [secretClears, setSecretClears] = useState<Record<RuntimeSecretKey, boolean>>(emptyRuntimeSecretClears);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      const [statusResponse, settingsResponse] = await Promise.all([
        apiClient.api.system.status.$get(),
        apiClient.api.system.settings.$get()
      ]);
      const settingsPayload = await readJson<{ data: RuntimeSettings }>(settingsResponse);
      setSystem(await readJson<SystemStatus>(statusResponse));
      setSettings(settingsPayload.data);
      setForm(settingsToForm(settingsPayload.data));
      setSecretValues(emptyRuntimeSecrets);
      setSecretClears(emptyRuntimeSecretClears);
    } catch (requestError) {
      setError(errorMessage(requestError));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(
    () => [
      [t("runtime.api"), formatStatus(system?.ok ? "online" : "pending")],
      [t("runtime.database"), formatStatus(system?.databaseConfigured ? "configured" : "missing")],
      [t("runtime.auth"), formatStatus(system?.authEnabled ? "enabled" : "disabled")],
      [t("runtime.botToken"), formatStatus(system?.botTokenConfigured ? "configured" : "missing")],
      [t("runtime.runtimeDb"), formatStatus(system?.runtimeSettingsConfigured ? "configured" : "missing")],
      [t("runtime.secretStorage"), formatStatus(system?.runtimeSettingsSecretStorageReady ? "configured" : "missing")],
      [t("runtime.chatModel"), system?.bootChatModel ?? "-"],
      [t("runtime.embeddingModel"), system?.bootEmbeddingModel ?? "-"],
      [t("runtime.imageModel"), system?.bootImageModel ?? "-"],
      [t("runtime.searchProvider"), formatSearchProvider(system?.bootSearchProvider ?? "disabled")]
    ],
    [formatSearchProvider, formatStatus, system, t]
  );

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) {
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const secretPatch = runtimeSecretLabels.reduce<Record<string, string | null>>((accumulator, [key]) => {
        if (secretClears[key]) {
          accumulator[key] = null;
        } else if (secretValues[key].trim()) {
          accumulator[key] = secretValues[key].trim();
        }
        return accumulator;
      }, {});
      const response = await apiClient.api.system.settings.$patch({
        json: {
          ...form,
          bootChatBaseUrl: form.bootChatBaseUrl || null,
          bootEmbeddingBaseUrl: form.bootEmbeddingBaseUrl || null,
          bootImageBaseUrl: form.bootImageBaseUrl || null,
          bootSearchBaseUrl: form.bootSearchBaseUrl || null,
          ...secretPatch
        }
      });
      const payload = await readJson<{ data: RuntimeSettings }>(response);
      setSettings(payload.data);
      setForm(settingsToForm(payload.data));
      setSecretValues(emptyRuntimeSecrets);
      setSecretClears(emptyRuntimeSecretClears);
      await load();
      setNotice(t("system.settingsSaved"));
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ResourcePage title={t("system.title")} description={t("system.description")} error={error} loading={!system && !error} onRefresh={load}>
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          {notice}
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t("system.runtimeMatrix")}</CardTitle>
          <CardDescription>{system?.service ?? "raiden-shin-server"}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {rows.map(([label, value]) => (
            <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 px-3 py-2" key={label}>
              <span className="text-sm font-medium text-zinc-600">{label}</span>
              <span className="max-w-64 truncate text-sm font-semibold text-zinc-950">{value}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      {form && settings && (
        <Card>
          <CardHeader>
            <CardTitle>{t("system.gatewayTitle")}</CardTitle>
            <CardDescription>{t("system.gatewayDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-5" onSubmit={saveSettings}>
              <div className="grid gap-3 md:grid-cols-[240px_1fr]">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
                    <Settings2 className="size-4 text-cyan-700" />
                    {t("system.gatewayPreset")}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-zinc-500">{t("system.gatewayHelp")}</p>
                </div>
                <div className="grid grid-cols-2 gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-1">
                  {[
                    ["openai_compatible", t("gateway.openaiCompatible")],
                    ["new_api", t("gateway.newApi")]
                  ].map(([value, label]) => (
                    <button
                      className={cn(
                        "h-10 rounded-md text-sm font-semibold transition",
                        form.gatewayPreset === value ? "bg-zinc-950 text-white shadow-sm" : "text-zinc-600 hover:bg-white"
                      )}
                      key={value}
                      type="button"
                      onClick={() => setForm({ ...form, gatewayPreset: value as RuntimeSettings["gatewayPreset"] })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-2">
                <div className="grid gap-3 rounded-lg border border-zinc-200 p-4">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-950">{t("system.relayEndpoints")}</h3>
                    <p className="mt-1 text-xs leading-5 text-zinc-500">{t("system.relayHelp")}</p>
                  </div>
                  <Label>
                    {t("system.defaultBaseUrl")}
                    <Input
                      value={form.bootBaseUrl}
                      onChange={(event) => setForm({ ...form, bootBaseUrl: event.target.value })}
                      placeholder="https://new-api.example.com/v1"
                    />
                  </Label>
                  <Label>
                    {t("system.chatBaseUrl")}
                    <Input
                      value={form.bootChatBaseUrl ?? ""}
                      onChange={(event) => setForm({ ...form, bootChatBaseUrl: event.target.value || null })}
                      placeholder={t("system.fallbackDefault")}
                    />
                  </Label>
                  <Label>
                    {t("system.embeddingBaseUrl")}
                    <Input
                      value={form.bootEmbeddingBaseUrl ?? ""}
                      onChange={(event) => setForm({ ...form, bootEmbeddingBaseUrl: event.target.value || null })}
                      placeholder={t("system.fallbackDefault")}
                    />
                  </Label>
                  <Label>
                    {t("system.imageBaseUrl")}
                    <Input
                      value={form.bootImageBaseUrl ?? ""}
                      onChange={(event) => setForm({ ...form, bootImageBaseUrl: event.target.value || null })}
                      placeholder={t("system.fallbackDefault")}
                    />
                  </Label>
                </div>

                <div className="grid gap-3 rounded-lg border border-zinc-200 p-4">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-950">{t("system.modelMapping")}</h3>
                    <p className="mt-1 text-xs leading-5 text-zinc-500">{t("system.modelHelp")}</p>
                  </div>
                  <Label>
                    {t("system.chatModel")}
                    <Input value={form.bootChatModel} onChange={(event) => setForm({ ...form, bootChatModel: event.target.value })} />
                  </Label>
                  <Label>
                    {t("system.embeddingModel")}
                    <Input
                      value={form.bootEmbeddingModel}
                      onChange={(event) => setForm({ ...form, bootEmbeddingModel: event.target.value })}
                    />
                  </Label>
                  <Label>
                    {t("system.imageModel")}
                    <Input value={form.bootImageModel} onChange={(event) => setForm({ ...form, bootImageModel: event.target.value })} />
                  </Label>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
                      <span className="text-zinc-500">{t("system.memoryVector")}</span>
                      <div className="mt-1 font-semibold text-zinc-950">{t("system.dimensions", { count: settings.embeddingDimensions })}</div>
                    </div>
                    <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
                      <span className="text-zinc-500">new-api</span>
                      <div className="mt-1 font-semibold text-zinc-950">
                        {settings.newApiCompatible ? t("system.compatible") : t("system.manual")}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
                <div className="grid gap-3 rounded-lg border border-zinc-200 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-zinc-950">{t("system.searchChannel")}</h3>
                      <p className="mt-1 text-xs leading-5 text-zinc-500">{t("system.searchHelp")}</p>
                    </div>
                    <Search className="size-4 text-cyan-700" />
                  </div>
                  <Label>
                    {t("system.provider")}
                    <select
                      className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                      value={form.bootSearchProvider}
                      onChange={(event) =>
                        setForm({ ...form, bootSearchProvider: event.target.value as RuntimeSettings["bootSearchProvider"] })
                      }
                    >
                      <option value="disabled">{formatSearchProvider("disabled")}</option>
                      <option value="tavily">tavily</option>
                      <option value="brave">brave</option>
                      <option value="serper">serper</option>
                    </select>
                  </Label>
                  <Label>
                    {t("system.searchBaseUrl")}
                    <Input
                      value={form.bootSearchBaseUrl ?? ""}
                      onChange={(event) => setForm({ ...form, bootSearchBaseUrl: event.target.value || null })}
                      placeholder={t("system.providerDefault")}
                    />
                  </Label>
                  <div className="grid grid-cols-2 gap-3">
                    <Label>
                      {t("system.maxResults")}
                      <Input
                        max={10}
                        min={1}
                        type="number"
                        value={form.bootSearchMaxResults}
                        onChange={(event) => setForm({ ...form, bootSearchMaxResults: Number(event.target.value) })}
                      />
                    </Label>
                    <Label>
                      {t("system.depth")}
                      <select
                        className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                        value={form.bootSearchDepth}
                        onChange={(event) =>
                          setForm({ ...form, bootSearchDepth: event.target.value as RuntimeSettings["bootSearchDepth"] })
                        }
                      >
                        <option value="basic">{formatDepth("basic")}</option>
                        <option value="advanced">{formatDepth("advanced")}</option>
                      </select>
                    </Label>
                  </div>
                </div>

                <div className="grid gap-3 rounded-lg border border-zinc-200 p-4">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-950">{t("system.secretKeys")}</h3>
                    <p className="mt-1 text-xs leading-5 text-zinc-500">{t("system.secretHelp")}</p>
                  </div>
                  {!settings.secretStorageReady && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                      {t("system.secretStorageWarning")}
                    </div>
                  )}
                  <div className="grid gap-3">
                    {runtimeSecretLabels.map(([key, label]) => (
                      <div className="grid gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-3" key={key}>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-semibold text-zinc-800">{t(label)}</span>
                          <Badge tone={settings.secrets[key] ? "success" : "warning"}>
                            {formatStatus(settings.secrets[key] ? "configured" : "missing")}
                          </Badge>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                          <Input
                            autoComplete="off"
                            disabled={secretClears[key]}
                            placeholder={settings.secrets[key] ? t("common.keepSecret") : t("common.pasteSecret")}
                            type="password"
                            value={secretValues[key]}
                            onChange={(event) => setSecretValues({ ...secretValues, [key]: event.target.value })}
                          />
                          <label className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-700">
                            <input
                              checked={secretClears[key]}
                              className="size-4 accent-cyan-600"
                              type="checkbox"
                              onChange={(event) => setSecretClears({ ...secretClears, [key]: event.target.checked })}
                            />
                            {t("common.clear")}
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 pt-4">
                <p className="text-xs leading-5 text-zinc-500">
                  {t("system.auditHint")}
                </p>
                <Button disabled={saving || !form.bootBaseUrl.trim()} type="submit">
                  <Save className="size-4" />
                  {saving ? t("common.saving") : t("common.save")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </ResourcePage>
  );
}

function ResourcePage({
  title,
  description,
  error,
  loading,
  onRefresh,
  children
}: {
  title: string;
  description: string;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-zinc-950">{title}</h2>
          <p className="mt-1 text-sm text-zinc-500">{description}</p>
        </div>
        <Button onClick={onRefresh} variant="outline">
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          {t("common.refresh")}
        </Button>
      </div>
      <ErrorBanner message={error} />
      {children}
    </div>
  );
}

function AdminApp() {
  const [auth, setAuth] = useState<AuthState>({ user: null, loading: true });

  const refreshSession = useCallback(async () => {
    try {
      const response = await apiClient.api.auth.me.$get();
      const payload = await readJson<{ user: AdminUserDto; csrfToken: string }>(response);
      setCsrfToken(payload.csrfToken);
      setAuth({ user: payload.user, loading: false });
    } catch {
      setCsrfToken(null);
      setAuth({ user: null, loading: false });
    }
  }, []);

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  async function logout() {
    try {
      await apiClient.api.auth.logout.$post();
    } finally {
      setCsrfToken(null);
      setAuth({ user: null, loading: false });
    }
  }

  function onLogin(user: AdminUserDto, csrfToken: string) {
    setCsrfToken(csrfToken);
    setAuth({ user, loading: false });
  }

  if (auth.loading) {
    return <LoadingPanel />;
  }

  return (
    <Routes>
      <Route path="/login" element={auth.user ? <Navigate replace to="/" /> : <LoginPage onLogin={onLogin} />} />
      <Route
        element={
          auth.user ? (
            <AppShell onLogout={logout} user={auth.user} />
          ) : (
            <Navigate replace to="/login" />
          )
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="telegram" element={<TelegramPage />} />
        <Route path="conversations" element={<ConversationsPage />} />
        <Route path="memory" element={<MemoryPage />} />
        <Route path="security" element={auth.user ? <SecurityPage user={auth.user} /> : <Navigate replace to="/login" />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="system" element={<SystemPage />} />
      </Route>
      <Route path="*" element={<Navigate replace to="/" />} />
    </Routes>
  );
}

export function App() {
  return (
    <I18nProvider>
      <AdminApp />
    </I18nProvider>
  );
}
