import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "../lib/utils.js";

export type SaveIndicator = "clean" | "dirty" | "saving" | "error";

export interface FileToolbarProps {
  path: string;
  indicator: SaveIndicator;
  isRefreshing: boolean;
  canReload: boolean;
  canSave: boolean;
  onSave: () => void;
  autoSave: boolean;
  canAutoSave: boolean;
  onAutoSaveChange: (enabled: boolean) => void;
  onRefresh: () => void;
  isFilesOpen: boolean;
  onToggleFiles: () => void;
  canReveal: boolean;
  isRevealing: boolean;
  onReveal: () => void;
}

export function FileToolbar({
  path,
  indicator,
  isRefreshing,
  canReload,
  canSave,
  onSave,
  autoSave,
  canAutoSave,
  onAutoSaveChange,
  onRefresh,
  isFilesOpen,
  onToggleFiles,
  canReveal,
  isRevealing,
  onReveal,
}: FileToolbarProps) {
  return (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 py-1 bg-surface-raised px-4">
      <div className="flex min-w-20 flex-1 items-center gap-1.5">
        <FileGlyph
          path={path}
          className="size-3.5 shrink-0 text-subtle-foreground"
        />
        <CopyablePath path={path} />
        <ToolbarButton label={isRevealing ? "Opening file location" : "Show in folder"} onClick={onReveal} disabled={!canReveal || isRevealing}>
          <svg viewBox="0 0 24 24" fill="none" className="size-3.5" aria-hidden>
            <path d="M3 7V5a2 2 0 012-2h5l2 3h7a2 2 0 012 2v11a2 2 0 01-2 2H5a2 2 0 01-2-2V7zm6 6h7m-3-3l3 3-3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          label={isRefreshing ? "Reloading file" : "Reload from disk"}
          onClick={onRefresh}
          disabled={isRefreshing || !canReload}
        >
          <RotateIcon className={cn(isRefreshing && "animate-spin")} />
        </ToolbarButton>
      </div>
      <SaveDot indicator={indicator} />
      <button
        type="button"
        onClick={onSave}
        disabled={!canSave}
        title="Save file (⌘S / Ctrl+S)"
        className="shrink-0 cursor-pointer rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50"
      >
        {indicator === "saving" ? "Saving…" : "Save"}
      </button>
      <label
        className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
        title="Save this file after 1 second without typing. On by default. Turn off to save manually."
      >
        <input
          type="checkbox"
          checked={autoSave}
          disabled={!canAutoSave}
          onChange={(event) => onAutoSaveChange(event.currentTarget.checked)}
          className="accent-foreground"
        />
        Auto-save
      </label>
      <ToolbarButton
        label={isFilesOpen ? "Hide files" : "Show in files"}
        onClick={onToggleFiles}
        pressed={isFilesOpen}
      >
        <TreeIcon />
      </ToolbarButton>
    </div>
  );
}

function SaveDot({ indicator }: { indicator: SaveIndicator }) {
  if (indicator === "clean") {
    return <span className="size-4 shrink-0" aria-hidden />;
  }
  const label =
    indicator === "saving"
      ? "Saving…"
      : indicator === "error"
        ? "Could not save — unsaved changes"
        : "Unsaved changes";
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center"
      title={label}
      role="status"
      aria-label={label}
    >
      <span
        className={cn(
          "size-2 rounded-full transition-colors",
          indicator === "saving" && "animate-pulse bg-foreground",
          indicator === "dirty" && "bg-foreground",
          indicator === "error" && "bg-destructive",
        )}
      />
    </span>
  );
}

function CopyablePath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(path)
      .then(() => {
        setCopied(true);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1500);
        toast.success("File path copied");
      })
      .catch(() => toast.error("Failed to copy file path"));
  }, [path]);

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? "Copied" : "Copy file path"}
      aria-label="Copy file path"
      className={cn(
        "min-w-0 cursor-pointer truncate rounded-sm text-left font-mono text-sm",
        "font-medium leading-5 text-file-accent underline-offset-2",
        "hover:underline focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
      )}
      style={{ direction: "rtl", textAlign: "left" }}
    >
      <bdi>{path}</bdi>
    </button>
  );
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      className={cn(
        "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md",
        "transition-colors hover:bg-state-hover hover:text-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-50",
        pressed ? "bg-state-hover text-foreground" : "text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}

function TreeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-3.5" aria-hidden>
      <path
        d="M4 3v14a2 2 0 002 2h3M4 10h5M14 5h6M14 12h6M14 19h6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileGlyph({ path, className }: { path: string; className?: string }) {
  const kind = glyphKindForPath(path);
  if (kind === "code") {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
        <path
          d="M8 6L2 12l6 6M16 6l6 6-6 6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === "data") {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
        <path
          d="M8 3H7a2 2 0 00-2 2v4a2 2 0 01-2 2 2 2 0 012 2v4a2 2 0 002 2h1M16 3h1a2 2 0 012 2v4a2 2 0 002 2 2 2 0 00-2 2v4a2 2 0 01-2 2h-1"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 2v6h6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const DATA_EXTENSIONS = new Set([
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "xml",
  "csv",
  "tsv",
]);

const DOC_EXTENSIONS = new Set([
  "md",
  "mdx",
  "markdown",
  "txt",
  "text",
  "rst",
  "adoc",
  "log",
]);

function glyphKindForPath(path: string): "code" | "data" | "doc" {
  const name = path.split("/").at(-1) ?? path;
  const dotIndex = name.lastIndexOf(".");
  const extension = dotIndex <= 0 ? "" : name.slice(dotIndex + 1).toLowerCase();
  if (DATA_EXTENSIONS.has(extension)) return "data";
  if (DOC_EXTENSIONS.has(extension)) return "doc";
  return "code";
}

function RotateIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn("size-3.5", className)}
      aria-hidden
    >
      <path
        d="M3 2v6h6M3.51 15a9 9 0 102.13-9.36L3 8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
