import type { ComponentType, SVGProps } from "react";

type MetricProps = {
  label: string;
  value: number | string;
  detail: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone?: "violet" | "emerald" | "amber" | "sky";
};

const toneClassNames = {
  amber: "bg-amber-100 text-amber-700",
  emerald: "bg-emerald-100 text-emerald-700",
  sky: "bg-sky-100 text-sky-700",
  violet: "bg-violet-100 text-violet-700"
};

export function Metric({ label, value, detail, icon: Icon, tone = "violet" }: MetricProps) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-zinc-500">{label}</p>
          <p className="mt-2 text-2xl font-semibold text-zinc-950">{value}</p>
        </div>
        <div className={`grid size-10 place-items-center rounded-md ${toneClassNames[tone]}`}>
          <Icon aria-hidden className="size-5" />
        </div>
      </div>
      <p className="mt-3 text-sm text-zinc-500">{detail}</p>
    </section>
  );
}
