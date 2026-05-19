import type { ComponentType, SVGProps } from "react";

type StatusPillProps = {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  value: string;
  tone?: "neutral" | "success" | "warning" | "danger";
};

const toneClassNames = {
  danger: "border-red-200 bg-red-50 text-red-700",
  neutral: "border-zinc-200 bg-zinc-50 text-zinc-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700"
};

export function StatusPill({ icon: Icon, label, value, tone = "neutral" }: StatusPillProps) {
  return (
    <div className={`inline-flex min-h-9 items-center gap-2 rounded-md border px-3 text-sm ${toneClassNames[tone]}`}>
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="font-medium text-zinc-600">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

