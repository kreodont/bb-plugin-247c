import { cn } from "./lib/utils.js";

// Role accents follow the host palette. Labels and icons remain the primary
// identifiers, including in themes with a limited color range.
const accents = {
  task: "[--c247-action-color:var(--timeline-accent)]",
  terminal: "[--c247-action-color:var(--ansi-5)]",
  pinned: "[--c247-action-color:var(--ansi-3)]",
  time: "[--c247-action-color:var(--ansi-6)]",
  proposal: "[--c247-action-color:var(--attention)]",
  finish: "[--c247-action-color:var(--success)]",
  error: "[--c247-action-color:var(--destructive)]",
};

export function threadActionTone(role: keyof typeof accents | "neutral") {
  if (role === "neutral") return "border-input bg-muted/60 text-foreground hover:bg-muted hover:text-foreground";
  return cn(accents[role],
    "border-[color:color-mix(in_oklab,var(--c247-action-color)_55%,var(--background))] bg-[color:color-mix(in_oklab,var(--c247-action-color)_22%,var(--background))] text-foreground hover:bg-[color:color-mix(in_oklab,var(--c247-action-color)_34%,var(--background))] hover:text-foreground",
    "[&_svg]:text-[color:color-mix(in_oklab,var(--c247-action-color)_60%,var(--foreground))]",
  );
}

export function threadActionClass(role: Parameters<typeof threadActionTone>[0], compact = false) {
  return cn("h-8 shrink-0 gap-1.5 text-xs font-semibold focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    compact ? "w-8 px-0" : "px-2", threadActionTone(role));
}
