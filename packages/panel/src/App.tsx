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
  Server,
  Shield,
  Zap
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, NavLink, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import type { AdminUserDto } from "@raiden/shared";
import { ErrorBanner } from "./components/page.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";
import { Input, Label } from "./components/ui/input.js";
import { apiClient, readJson, setCsrfToken } from "./lib/apiClient.js";
import { I18nProvider, useI18n } from "./lib/i18n.js";
import { cn, errorMessage } from "./lib/utils.js";
import { AuditPage } from "./pages/AuditPage.js";
import { ConversationsPage } from "./pages/ConversationsPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { MemoryPage } from "./pages/MemoryPage.js";
import { SecurityPage } from "./pages/SecurityPage.js";
import { SystemPage } from "./pages/SystemPage.js";
import { TelegramPage } from "./pages/TelegramPage.js";

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

function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md border border-zinc-300 bg-white p-1">
      <Languages className="ml-2 size-4 text-cyan-700" />
      {(["zh", "en"] as const).map((value) => (
        <button
          className={cn(
            "h-7 whitespace-nowrap rounded px-2 text-xs font-semibold transition",
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
          <div className="mb-8 flex flex-wrap items-center gap-3">
            <div className="grid size-11 place-items-center rounded-lg bg-zinc-950 text-cyan-300">
              <Shield className="size-5" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-700">RaidenShinBoot</p>
              <h1 className="text-2xl font-semibold tracking-normal text-zinc-950">{t("login.productName")}</h1>
            </div>
            <div className="ml-auto flex max-[420px]:ml-0 max-[420px]:w-full max-[420px]:justify-end">
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
  const visibleNavItems = useMemo(() => navItems.filter((item) => canSee(item, user)), [user.role]);

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
          {visibleNavItems.map((item) => (
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
            {visibleNavItems.map((item) => (
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
