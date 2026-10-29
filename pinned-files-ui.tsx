import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contracts.js";
import { pinnedFileSaveError, type PinnedFile } from "./pinned-files-contracts.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Icon } from "./components/ui/icon.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog.js";
import { threadActionClass, threadActionTone } from "./thread-action-style.js";
import { cn } from "./lib/utils.js";

export function PinnedFilesButton({ compact = false, threadId = null }: { compact?: boolean; threadId?: string | null }) {
  const rpc = useRpc<typeof rpcContract>(), navigate = useBbNavigate();
  const connection = useRealtimeConnectionState();
  const [open, setOpen] = useState(false), [files, setFiles] = useState<PinnedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [adding, setAdding] = useState(false);
  const [name, setName] = useState(""), [path, setPath] = useState("");
  const generation = useRef(0), mutating = useRef(false);
  const currentThread = useRef(threadId); currentThread.current = threadId;
  useEffect(() => () => { currentThread.current = null; }, []);
  const load = useCallback(async () => {
    const request = ++generation.current;
    try { const value = await rpc.call("pinnedFiles", {}); if (request === generation.current) { setFiles(value.files); setError(null); } }
    catch { if (request === generation.current) setError("Could not load pinned files. Check the local settings and try again."); }
  }, [rpc]);
  useEffect(() => { if (open) void load(); return () => { generation.current++; }; }, [open, connection, load]);
  useRealtime("pinned-files-changed", () => { if (open && !mutating.current) void load(); });
  function changeOpen(next: boolean) { if (mutating.current) return; setOpen(next); if (!next) { setAdding(false); setPath(""); setName(""); setError(null); } }
  async function mutate(action: () => Promise<{ files: PinnedFile[] }>) {
    if (mutating.current) return;
    mutating.current = true; generation.current++; setBusy(true); setError(null);
    try { setFiles((await action()).files); setAdding(false); setName(""); setPath(""); }
    catch (error) { setError(pinnedFileSaveError(error)); }
    finally { mutating.current = false; setBusy(false); }
  }
  function pin(event: FormEvent) {
    event.preventDefault();
    const label = name.trim() || path.trim().split(/[\\/]/u).at(-1) || "File";
    void mutate(() => rpc.call("pinFile", { name: label, path: path.trim() }));
  }
  async function openFile(shortcut: PinnedFile) {
    if (!threadId || mutating.current) return;
    const origin = threadId;
    mutating.current = true; setBusy(true); setError(null);
    try {
      const file = await rpc.call("pinnedFileTarget", { id: shortcut.id, threadId: origin });
      if (currentThread.current !== origin) return;
      // A navigation intent only. File Editor owns reading and editing; do not
      // attach contents to a message or send file paths to UX instrumentation.
      if (navigate.experimental_openFilePreview({ target: { kind: "host", hostId: file.hostId, path: file.path }, location: null })) { setOpen(false); setAdding(false); setPath(""); setName(""); return; }
    } catch { /* Do not surface host error payloads from a private file. */ }
    finally { mutating.current = false; setBusy(false); }
    if (currentThread.current === origin) setError("Could not open the file panel. Use a thread with a workspace on the file's machine, or refresh the shortcut list.");
  }
  return <span data-c247-ux-private="" className={cn("inline-flex", threadId && "ms-2")} title="Pinned files">
    <Button type="button" size="sm" variant="outline" className={threadId ? threadActionClass("pinned", compact) : cn("h-7 gap-1.5 px-2 text-xs", threadActionTone("pinned"))} aria-label="Pinned files" onClick={() => changeOpen(true)}>
      <Icon name="Pin" aria-hidden="true" />{!compact && "Pinned files"}
    </Button>
    <Dialog open={open} onOpenChange={changeOpen}><DialogContent data-c247-ux-private="" className="gap-3 p-4 sm:max-w-lg">
      <DialogTitle className="text-base">Pinned files</DialogTitle>
      <DialogDescription>Local shortcuts shared across your threads. Files open in the side panel.</DialogDescription>
      {!threadId && <p className="text-sm text-muted-foreground">Open a thread to view or edit these files. You can manage shortcuts here.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error} <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>Retry</Button></p>}
      {!files && !error && <p role="status" className="py-4 text-sm text-muted-foreground">Loading pinned files…</p>}
      {files?.length === 0 && <p className="py-4 text-sm text-muted-foreground">No pinned files yet.</p>}
      {!!files?.length && <ul aria-label="Pinned files" className="max-h-[50vh] space-y-1 overflow-y-auto">
        {files.map(file => <li key={file.id} className="flex items-center gap-1 rounded-md hover:bg-muted/60">
          <button type="button" disabled={busy || !threadId} onClick={() => void openFile(file)} className="min-w-0 flex-1 rounded-md p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default" aria-label={`Open ${file.name}`}>
            <span className="block truncate text-sm font-medium">{file.name}</span><span className="block truncate text-xs text-muted-foreground" title={file.path}>{file.path}</span>
          </button>
          <span title="Remove shortcut; keep the file"><Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={`Unpin ${file.name}`} onClick={() => void mutate(() => rpc.call("unpinFile", { id: file.id }))}><Icon name="X" aria-hidden="true" /></Button></span>
        </li>)}
      </ul>}
      {adding ? <form className="space-y-3 border-t border-border pt-3" onSubmit={pin}>
        <label className="block text-sm">File path<Input autoFocus required maxLength={4096} value={path} onChange={event => setPath(event.target.value)} placeholder="/path/to/notes.md" disabled={busy} autoComplete="off" spellCheck={false} /></label>
        <p className="text-xs text-muted-foreground">Use a path on the machine running BB. Windows paths are converted automatically in WSL.</p>
        <label className="block text-sm">Name <span className="text-muted-foreground">(optional)</span><Input maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={busy} autoComplete="off" /></label>
        <div className="flex gap-2"><Button type="submit" size="sm" disabled={busy || !path.trim()}>{busy ? "Saving…" : "Pin file"}</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setAdding(false); setName(""); setPath(""); }}>Cancel</Button></div>
      </form> : <Button type="button" size="sm" variant="outline" disabled={busy || !files || files.length >= 24} onClick={() => setAdding(true)}>Pin a file</Button>}
    </DialogContent></Dialog>
  </span>;
}

export function ThreadPinnedFiles({ isCompactViewport, threadId }: PluginThreadHeaderActionProps) { return <PinnedFilesButton compact={isCompactViewport} threadId={threadId} />; }
export function PagePinnedFiles() { return <PinnedFilesButton />; }
