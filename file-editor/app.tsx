import { useCallback, useEffect, useRef, useState } from "react";
import {
  type PluginAppBuilder,
  experimental_useCodeTheme,
  useRpc,
  type PluginFileOpenerProps,
} from "@get-bb/plugin-sdk/app";
import type * as MonacoNs from "monaco-editor";
import type { editorRpcContract } from "./contracts.js";
import { toast } from "sonner";
import { CLAIMED_EXTENSIONS, languageForPath } from "./lib/languages.js";
import {
  loadMonaco,
  overflowWidgetsNode,
  setOverflowWidgetsTheme,
} from "./lib/monaco-loader.js";
import { applyCodeTheme, editorBackground } from "./lib/monaco-theme.js";
import { cn } from "./lib/utils.js";
import { FileToolbar, type SaveIndicator } from "./components/FileToolbar.js";
import { FileTreePanel } from "./components/FileTreePanel.js";
import type { FlatEntry } from "./lib/file-tree.js";
import {
  EDITOR_COMMANDS,
  forgetEditor,
  isCommandAvailable,
  markEditorActive,
  runEditorCommand,
} from "./lib/editor-commands.js";

import { SaveController, type SaveState } from "./lib/save-controller.js";

function revealLineRange(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  lineRange: PluginFileOpenerProps["experimental_lineRange"],
) {
  const model = editor.getModel();
  if (lineRange == null || model === null) return;
  const startLineNumber = Math.min(
    lineRange.startLineNumber,
    model.getLineCount(),
  );
  const endLineNumber = Math.min(lineRange.endLineNumber, model.getLineCount());
  const selection = {
    startLineNumber,
    startColumn: 1,
    endLineNumber,
    endColumn: model.getLineMaxColumn(endLineNumber),
  };
  editor.setSelection(selection);
  editor.revealRangeInCenter(selection);
}

function MonacoFileOpener({
  path,
  source,
  Original,
  experimental_lineRange,
}: PluginFileOpenerProps) {
  const rpc = useRpc<typeof editorRpcContract>();
  const codeTheme = experimental_useCodeTheme();
  const codeThemeRef = useRef(codeTheme);
  codeThemeRef.current = codeTheme;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const monacoRef = useRef<typeof MonacoNs | null>(null);
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);

  const navigationRef = useRef({ path, lineRange: experimental_lineRange });

  const [activePath, setActivePath] = useState(path);
  useEffect(() => setActivePath(path), [path]);

  const controllerRef = useRef<SaveController | null>(null);
  const refreshingRef = useRef(false);
  const [autoSave, setAutoSave] = useState(true);
  const saveStateRef = useRef<SaveState>({ kind: "clean" });

  const [saveState, setSaveStateValue] = useState<SaveState>({ kind: "clean" });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRevealing, setIsRevealing] = useState(false);
  const [pendingDiscard, setPendingDiscard] = useState(false);
  const [isFilesOpen, setIsFilesOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  const [tree, setTree] = useState<{
    entries: readonly FlatEntry[];
    root: string;
    truncated: boolean;
    isLoading: boolean;
    error: string | null;
  }>({
    entries: [],
    root: "",
    truncated: false,
    isLoading: false,
    error: null,
  });
  const [status, setStatus] = useState<
    | { kind: "loading" }
    | { kind: "ready" }
    | { kind: "delegate"; reason: string }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  const setSaveState = useCallback((next: SaveState) => {
    saveStateRef.current = next;
    setSaveStateValue(next);
  }, []);

  const save = useCallback(() => controllerRef.current?.save(), []);
  const reveal = async () => {
    if (isRevealing) return;
    setIsRevealing(true);
    try { await rpc.call("editorReveal", { path: activePath, source }); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Could not open the file location"); }
    finally { setIsRevealing(false); }
  };

  const reloadFromDisk = useCallback(async () => {
    const editor = editorRef.current;
    const controller = controllerRef.current;
    if (!editor || !controller || refreshingRef.current || saveStateRef.current.kind === "saving") return;
    refreshingRef.current = true;
    controller.setPaused(true);
    setIsRefreshing(true);
    const previousContent = editor.getValue();
    try {
      const file = await rpc.call("editorRead", { path: activePath, source });
      if (controllerRef.current !== controller) return;
      if (editor.getValue() !== previousContent) {
        controller.fail("You edited the file while it was reloading. Your changes were kept. Reload again or click Save.");
        return;
      }
      if (file.kind !== "text") {
        controller.fail("This file can no longer be loaded as text. Your changes were kept.");
        return;
      }
      editor.setValue(file.content);
      controller.acceptDisk(file.sha256);
    } catch {
      if (controllerRef.current === controller) {
        controller.fail("Reload failed. Your changes are still in the editor.");
      }
    } finally {
      if (controllerRef.current === controller) {
        refreshingRef.current = false;
        controller.setPaused(false);
        setIsRefreshing(false);
      }
    }
  }, [activePath, rpc, source]);

  const treeRequestedRef = useRef(false);
  useEffect(() => {
    if (!isFilesOpen || treeRequestedRef.current) return;
    treeRequestedRef.current = true;
    let cancelled = false;
    setTree((current) => ({ ...current, isLoading: true, error: null }));
    void rpc
      .call("editorTree", { source })
      .then((result) => {
        if (cancelled) return;
        setTree({
          entries: result.entries,
          root: result.root,
          truncated: result.truncated,
          isLoading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        treeRequestedRef.current = false;
        setTree({
          entries: [],
          root: "",
          truncated: false,
          isLoading: false,
          error:
            error instanceof Error ? error.message : "Could not list files",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [isFilesOpen, rpc, source]);

  const openFromTree = useCallback(
    (next: string) => {
      if (next === activePath || refreshingRef.current || saveStateRef.current.kind === "saving") return;
      if (saveStateRef.current.kind !== "clean") {
        controllerRef.current?.setPaused(true);
        setPendingOpen(next);
        return;
      }
      setActivePath(next);
    },
    [activePath],
  );

  const requestRefresh = useCallback(() => {
    if (refreshingRef.current || saveStateRef.current.kind === "saving") return;
    if (saveStateRef.current.kind !== "clean") {
      controllerRef.current?.setPaused(true);
      setPendingDiscard(true);
      return;
    }
    void reloadFromDisk();
  }, [reloadFromDisk]);

  useEffect(() => {
    let disposed = false;
    setStatus({ kind: "loading" });
    setSaveState({ kind: "clean" });
    setAutoSave(true);
    setPendingOpen(null);
    setPendingDiscard(false);
    refreshingRef.current = false;
    setIsRefreshing(false);

    void (async () => {
      try {
        const [{ baseUrl }, file] = await Promise.all([
          rpc.call("editorAssets"),
          rpc.call("editorRead", { path: activePath, source }),
        ]);
        if (disposed) return;
        if (file.kind === "unsupported") {
          setStatus({ kind: "delegate", reason: file.reason });
          return;
        }

        const monaco = await loadMonaco(baseUrl);
        if (disposed) return;
        const container = containerRef.current;
        if (!container) return;
        monacoRef.current = monaco;

        const applied = applyCodeTheme(monaco, codeThemeRef.current);
        setOverflowWidgetsTheme(applied.base);
        const editor = monaco.editor.create(container, {
          value: file.content,
          language: languageForPath(activePath),
          automaticLayout: true,
          lineNumbers: "on",
          theme: applied.name,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12,
          lineHeight: 20,
          fontFamily:
            getComputedStyle(document.documentElement).getPropertyValue(
              "--font-mono",
            ) || undefined,
          fixedOverflowWidgets: true,
          overflowWidgetsDomNode: overflowWidgetsNode(),
        });
        editorRef.current = editor;
        const controller = new SaveController({
          initialSha256: file.sha256,
          readContent: () => editor.getValue(),
          write: (content, expectedSha256) => rpc.call("editorWrite", {
            path: activePath, source, content, expectedSha256,
          }),
          onState: setSaveState,
        });
        controllerRef.current = controller;
        if (activePath === navigationRef.current.path) {
          revealLineRange(editor, navigationRef.current.lineRange);
        }
        const active = {
          editor,
          absolutePath: file.absolutePath,
          relativePath: file.relativePath,
        };
        markEditorActive(active);
        editor.onDidFocusEditorWidget(() => markEditorActive(active));
        setStatus({ kind: "ready" });

        editor.onDidChangeModelContent(() => controller.changed());
        editor.addCommand(
          monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
          () => void controller.save(),
        );
      } catch (error) {
        if (disposed) return;
        setStatus({
          kind: "error",
          message:
            error instanceof Error ? error.message : "Could not open this file",
        });
      }
    })();

    return () => {
      disposed = true;
      controllerRef.current?.dispose();
      controllerRef.current = null;
      if (editorRef.current) forgetEditor(editorRef.current);
      editorRef.current?.getModel()?.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, [activePath, rpc, setSaveState, source]);

  useEffect(() => {
    navigationRef.current = { path, lineRange: experimental_lineRange };
    const editor = editorRef.current;
    if (editor !== null && activePath === path) {
      revealLineRange(editor, experimental_lineRange);
    }
  }, [activePath, path, experimental_lineRange]);

  useEffect(() => {
    const monaco = monacoRef.current;
    if (monaco === null) return;
    const applied = applyCodeTheme(monaco, codeTheme);
    editorRef.current?.updateOptions({ theme: applied.name });
    setOverflowWidgetsTheme(applied.base);
  }, [codeTheme, status]);

  if (status.kind === "delegate") return <Original />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isFilesOpen ? (
        <FileTreePanel
          activePath={activePath}
          background={editorBackground(codeTheme.theme)}
          entries={tree.entries}
          error={tree.error}
          isLoading={tree.isLoading}
          root={tree.root}
          onClose={() => setIsFilesOpen(false)}
          onOpenFile={openFromTree}
          truncated={tree.truncated}
        />
      ) : null}
      <FileToolbar
        path={activePath}
        indicator={indicatorFor(saveState, status)}
        isRefreshing={isRefreshing}
        canReload={status.kind === "ready" && saveState.kind !== "saving"}
        canSave={status.kind === "ready" && !isRefreshing && !pendingDiscard && pendingOpen === null && (saveState.kind === "dirty" || saveState.kind === "error")}
        onSave={() => void save()}
        autoSave={autoSave}
        canAutoSave={status.kind === "ready" && !isRefreshing}
        onAutoSaveChange={(enabled) => {
          setAutoSave(enabled);
          controllerRef.current?.setAutoSave(enabled);
        }}
        onRefresh={requestRefresh}
        isFilesOpen={isFilesOpen}
        onToggleFiles={() => setIsFilesOpen((open) => !open)}
        canReveal={status.kind === "ready"}
        isRevealing={isRevealing}
        onReveal={() => void reveal()}
      />
      <Notice
        onDiscardCancel={() => {
          setPendingDiscard(false);
          controllerRef.current?.setPaused(false);
        }}
        onDiscardConfirm={() => {
          setPendingDiscard(false);
          void reloadFromDisk();
        }}
        onOpenCancel={() => {
          setPendingOpen(null);
          controllerRef.current?.setPaused(false);
        }}
        onOpenConfirm={() => {
          const next = pendingOpen;
          setPendingOpen(null);
          if (next !== null) setActivePath(next);
        }}
        onOverwrite={() => void controllerRef.current?.save(true)}
        onReload={() => void reloadFromDisk()}
        pendingDiscard={pendingDiscard}
        pendingOpen={pendingOpen}
        saveState={saveState}
        status={status}
      />
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}

function indicatorFor(
  saveState: SaveState,
  status: { kind: string },
): SaveIndicator {
  if (status.kind === "error") return "error";
  switch (saveState.kind) {
    case "saving":
      return "saving";
    case "dirty":
      return "dirty";
    case "error":
    case "conflict":
      return "error";
    default:
      return "clean";
  }
}

function Notice({
  onDiscardCancel,
  onDiscardConfirm,
  onOpenCancel,
  onOpenConfirm,
  onOverwrite,
  onReload,
  pendingDiscard,
  pendingOpen,
  saveState,
  status,
}: {
  onDiscardCancel: () => void;
  onDiscardConfirm: () => void;
  onOpenCancel: () => void;
  onOpenConfirm: () => void;
  onOverwrite: () => void;
  onReload: () => void;
  pendingDiscard: boolean;
  pendingOpen: string | null;
  saveState: SaveState;
  status: { kind: string; message?: string };
}) {
  if (status.kind === "error") {
    return <NoticeRow tone="error">{status.message}</NoticeRow>;
  }
  if (pendingOpen !== null) {
    return (
      <NoticeRow tone="warning">
        Open {pendingOpen.split("/").at(-1)} and discard your unsaved changes?
        <NoticeAction onClick={onOpenConfirm}>Discard and open</NoticeAction>
        <NoticeAction onClick={onOpenCancel}>Cancel</NoticeAction>
      </NoticeRow>
    );
  }
  if (pendingDiscard) {
    return (
      <NoticeRow tone="warning">
        Reload from disk and discard your unsaved changes?
        <NoticeAction onClick={onDiscardConfirm}>Discard</NoticeAction>
        <NoticeAction onClick={onDiscardCancel}>Cancel</NoticeAction>
      </NoticeRow>
    );
  }
  if (saveState.kind === "conflict") {
    return (
      <NoticeRow tone="error">
        This file changed on disk since you opened it.
        <NoticeAction onClick={onReload}>Reload</NoticeAction>
        <NoticeAction onClick={onOverwrite}>Overwrite</NoticeAction>
      </NoticeRow>
    );
  }
  if (saveState.kind === "error") {
    return <NoticeRow tone="error">{saveState.message}</NoticeRow>;
  }
  return null;
}

function NoticeRow({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "error" | "warning";
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex shrink-0 items-center gap-2 px-4 py-1.5 text-xs",
        tone === "error"
          ? "bg-destructive/10 text-destructive"
          : "bg-surface-recessed text-foreground",
      )}
    >
      {children}
    </div>
  );
}

function NoticeAction({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer rounded-sm font-medium underline underline-offset-2 hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

export function registerFileEditor(app: PluginAppBuilder) {
  app.slots.fileOpener({
    id: "file-editor",
    title: "247C File Editor",
    extensions: CLAIMED_EXTENSIONS,
    component: MonacoFileOpener,
  });

  for (const command of EDITOR_COMMANDS) {
    app.commands.register({
      id: command.id,
      title: command.title,
      isAvailable: () => isCommandAvailable(command),
      run: () => runEditorCommand(command),
    });
  }
}
