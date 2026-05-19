import type { ComponentType, SVGProps } from "react";

type EmptyStateProps = {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  detail: string;
};

export function EmptyState({ icon: Icon, title, detail }: EmptyStateProps) {
  return (
    <div className="grid justify-items-center gap-2 px-4 py-8 text-center">
      <div className="grid size-10 place-items-center rounded-md bg-zinc-100 text-zinc-500">
        <Icon aria-hidden className="size-5" />
      </div>
      <p className="text-sm font-semibold text-zinc-800">{title}</p>
      <p className="max-w-sm text-sm leading-6 text-zinc-500">{detail}</p>
    </div>
  );
}

