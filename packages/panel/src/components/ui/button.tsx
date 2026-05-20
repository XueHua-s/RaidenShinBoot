import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "secondary" | "ghost" | "destructive" | "outline";
  size?: "sm" | "md" | "icon";
};

const variants = {
  default: "bg-zinc-950 text-white hover:bg-zinc-800",
  secondary: "bg-cyan-500 text-zinc-950 hover:bg-cyan-400",
  ghost: "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950",
  destructive: "bg-red-600 text-white hover:bg-red-700",
  outline: "border border-zinc-300 bg-white text-zinc-800 hover:border-zinc-950 hover:text-zinc-950"
};

const sizes = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  icon: "size-9 p-0"
};

export function Button({ className, variant = "default", size = "md", ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-semibold transition focus:outline-none focus:ring-2 focus:ring-cyan-300 disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    />
  );
}
