import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contracts.js";
import type { PinnedFile } from "./pinned-files-contracts.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Icon } from "./components/ui/icon.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog.js";

export function PinnedFilesButton({ compact = false }: { compact?: boolean }) {
  const rpc = useRpc<typeof rpcContract>(), navigate = useBbNavigate();
  const connection = useRealtimeConnectionState();
  const [open, setOpen] = useState(false), [files, setFiles] = useState<PinnedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [adding, setAdding] = useState(false);
  const [name, setName] = useState(""), [path, setPath] = useState("");
  const generation = useRef(0), mutating = useRef(false);
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
    catch { setError("Could not save pinned files. Use an absolute path and check the local settings file permissions. Up to 24 files can be pinned."); }
    finally { mutating.current = false; setBusy(false); }
  }
  function pin(event: FormEvent) {
    event.preventDefault();
    const label = name.trim() || path.trim().split(/[\\/]/u).at(-1) || "File";
    void mutate(() => rpc.call("pinFile", { name: label, path: path.trim() }));
  }
  function openFile(file: PinnedFile) {
    try {
      // A navigation intent only. File Editor owns reading and editing; do not
      // attach contents to a message or send file paths to UX instrumentation.
      if (navigate.experimental_openFilePreview({ target: { kind: "host", hostId: file.hostId, path: file.path }, location: null })) { changeOpen(false); return; }
    } catch { /* Do not surface host error payloads from a private file. */ }
    setError("Could not open the file panel. Try again from an open thread.");
  }
  return <span data-c247-ux-private="" className="inline-flex" title="Pinned files">
    <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-xs" aria-label="Pinned files" onClick={() => changeOpen(true)}>
      <Icon name="Folder" aria-hidden="true" />{!compact && "Pinned files"}
    </Button>
    <Dialog open={open} onOpenChange={changeOpen}><DialogContent data-c247-ux-private="" className="gap-3 p-4 sm:max-w-lg">
      <DialogTitle className="text-base">Pinned files</DialogTitle>
      <DialogDescription>Local shortcuts shared across your threads. Files open in the side panel.</DialogDescription>
      {error && <p role="alert" className="text-sm text-destructive">{error} <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>Retry</Button></p>}
      {!files && !error && <p role="status" className="py-4 text-sm text-muted-foreground">Loading pinned files…</p>}
      {files?.length === 0 && <p className="py-4 text-sm text-muted-foreground">No pinned files yet.</p>}
      {!!files?.length && <ul aria-label="Pinned files" className="max-h-[50vh] space-y-1 overflow-y-auto">
        {files.map(file => <li key={file.id} className="flex items-center gap-1 rounded-md hover:bg-muted/60">
          <button type="button" disabled={busy} onClick={() => openFile(file)} className="min-w-0 flex-1 rounded-md p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Open ${file.name}`}>
            <span className="block truncate text-sm font-medium">{file.name}</span><span className="block truncate text-xs text-muted-foreground" title={file.path}>{file.path}</span>
          </button>
          <span title="Remove shortcut; keep the file"><Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={`Unpin ${file.name}`} onClick={() => void mutate(() => rpc.call("unpinFile", { id: file.id }))}><Icon name="X" aria-hidden="true" /></Button></span>
        </li>)}
      </ul>}
      {adding ? <form className="space-y-3 border-t border-border pt-3" onSubmit={pin}>
        <label className="block text-sm">File path<Input autoFocus required maxLength={4096} value={path} onChange={event => setPath(event.target.value)} placeholder="/path/to/notes.md" disabled={busy} autoComplete="off" spellCheck={false} /></label>
        <label className="block text-sm">Name <span className="text-muted-foreground">(optional)</span><Input maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={busy} autoComplete="off" /></label>
        <div className="flex gap-2"><Button type="submit" size="sm" disabled={busy || !path.trim()}>{busy ? "Saving…" : "Pin file"}</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setAdding(false); setName(""); setPath(""); }}>Cancel</Button></div>
      </form> : <Button type="button" size="sm" variant="outline" disabled={busy || !files || files.length >= 24} onClick={() => setAdding(true)}>Pin a file</Button>}
    </DialogContent></Dialog>
  </span>;
}

export function ThreadPinnedFiles({ isCompactViewport }: PluginThreadHeaderActionProps) { return <PinnedFilesButton compact={isCompactViewport} />; }
export function PagePinnedFiles() { return <PinnedFilesButton />; }
