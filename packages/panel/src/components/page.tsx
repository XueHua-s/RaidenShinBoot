import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "./ui/button.js";
import { Card, CardContent } from "./ui/card.js";
import { cn } from "../lib/utils.js";
import { useI18n } from "../lib/i18n.js";

export function statusTone(value: string) {
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

export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td className="px-4 py-10 text-center text-sm text-zinc-500" colSpan={colSpan}>
        {children}
      </td>
    </tr>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
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

export function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  tone = "neutral"
}: {
  icon: LucideIcon;
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

export function ResourcePage({
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
  onRefresh: () => void | Promise<void>;
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
