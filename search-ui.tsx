import { openSearchMessage } from "./search-navigation.js";
import { toast } from "sonner";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contracts.js";
import type { SearchInput, SearchResult } from "./search-contracts.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Icon } from "./components/ui/icon.js";
import { withThread } from "./desk-routes.js";

// Keep a return-to-search draft in this window only, never in routes, telemetry,
// browser storage, settings, exports or the repository.
let draft = "";
let savedScope: SearchInput["scope"] = "all", savedStatus: SearchInput["status"] = "all";
const searchListeners = new Set<(target: HTMLElement) => void>();
export function prepareSearch(query?: string, target?: HTMLElement) {
  if (query !== undefined) draft = query.slice(0, 300);
  savedScope = "all"; savedStatus = "all";
  if (target) for (const listener of searchListeners) listener(target);
}
export function SearchHighlight({ text }: { text: string }) {
  return <>{text.split("\u0001").map((part, i) => {
    if (i === 0) return part;
    const end = part.indexOf("\u0002");
    return <span key={i}><mark className="rounded bg-yellow-400/25 text-foreground">{end < 0 ? part : part.slice(0, end)}</mark>{end < 0 ? "" : part.slice(end + 1)}</span>;
  })}</>;
}

export function SearchPage({ threadId }: { threadId?: string }) {
  const rpc = useRpc<typeof rpcContract>(), navigate = useBbNavigate();
  const [query, setQuery] = useState(draft), [scope, setScope] = useState(savedScope), [status, setStatus] = useState(savedStatus);
  const [offset, setOffset] = useState(0), [data, setData] = useState<SearchResult | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const generation = useRef(0), mounted = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, [focusRequest]);
  useEffect(() => {
    const receive = (target?: HTMLElement) => {
      if (target && !target.contains(input.current)) return;
      setQuery(draft); setScope(savedScope); setStatus(savedStatus); setOffset(0);
      setFocusRequest(value => value + 1);
    };
    searchListeners.add(receive);
    receive();
    return () => { searchListeners.delete(receive); };
  }, []);
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    setBusy(true);
    try {
      const result = await rpc.call("search", { query, scope, status, offset });
      if (mounted.current && generation.current === version) { setData(result); setError(null); }
    } catch { if (mounted.current && generation.current === version) { setData(null); setError("Could not search. Try again."); } }
    finally { if (mounted.current && generation.current === version) setBusy(false); }
  }, [rpc, query, scope, status, offset]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    generation.current++; setData(null); setBusy(true);
    const timer = setTimeout(() => void refresh(), 200);
    return () => { clearTimeout(timer); generation.current++; };
  }, [refresh]);
  useRealtime("search-changed", refresh);
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 10000); return () => clearInterval(timer); }, [refresh]);
  const selectClass = "h-9 rounded-lg border border-input bg-background px-3 text-sm";
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-5xl space-y-4 p-4 md:p-5">
    <div><h1 className="text-xl font-medium">Search</h1><p className="mt-1 text-sm text-muted-foreground">Tasks, dossier history and conversations, including closed tasks.</p></div>
    <form onSubmit={event => { event.preventDefault(); void refresh(); }} className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-64 flex-1"><Icon name="Search" className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input ref={input} autoFocus className="pl-9" maxLength={300} type="search" aria-label="Search all tasks and conversations" placeholder='Words, "exact phrase" or BK-812' value={query} onChange={event => { draft = event.target.value; setQuery(draft); setOffset(0); }} /></div>
      <select aria-label="Search in" className={selectClass} value={scope} onChange={event => { savedScope = event.target.value as SearchInput["scope"]; setScope(savedScope); setOffset(0); }}><option value="all">Everything</option><option value="tasks">Current tasks</option><option value="history">Dossier history</option><option value="messages">Conversations</option></select>
      <select aria-label="Task status" className={selectClass} value={status} onChange={event => { savedStatus = event.target.value as SearchInput["status"]; setStatus(savedStatus); setOffset(0); }}><option value="all">All statuses</option><option value="unfinished">Unfinished</option><option value="closed">Closed</option></select>
      <Button type="submit" variant="outline">Search</Button>
    </form>
    {error && <p role="alert" className="text-sm text-destructive">{error} <Button size="sm" variant="ghost" onClick={() => void refresh()}>Retry</Button></p>}
    {data && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-label="Search index status">
      <span>{data.state.documents.toLocaleString()} indexed records · {data.state.indexedThreads}/{data.state.threads} chats checked</span>
      {data.state.pending > 0 && <span role="status">Indexing continues in the background. More results may appear.</span>}
      {data.state.unavailableThreads > 0 && <span role="status" className="text-amber-600">{data.state.unavailableThreads} {data.state.unavailableThreads === 1 ? "chat" : "chats"} could not be read. Any saved text remains searchable. <Button variant="ghost" size="sm" onClick={async () => { try { await rpc.call("searchRetry", {}); await refresh(); } catch { setError("Could not retry indexing. Try again."); } }}>Retry indexing</Button></span>}
    </div>}
    {busy && !data && <p role="status" className="text-sm text-muted-foreground">Searching…</p>}
    {data && query.trim() && <p aria-live="polite" className="text-sm text-muted-foreground">{data.total} matches{busy ? " · Updating…" : ""}</p>}
    {data && !query.trim() && <p className="rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">Find an old discussion, a decision or a ticket number. Search uses words and prefixes; put an exact phrase in quotes.</p>}
    {data && query.trim() && !data.hits.length && <p className="rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">No matches{data.state.pending || data.state.unavailableThreads ? " in the text indexed so far" : ""}. Try fewer words or another filter.</p>}
    <div className="space-y-3">{data?.hits.map(hit => <article key={hit.id} className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2"><button type="button" data-c247-ux-action="task-open" className="min-w-0 text-left text-sm font-medium text-primary hover:underline" onClick={() => navigate.toPluginPanel("desk", { subPath: withThread(hit.taskId, threadId) })}><SearchHighlight text={hit.titleMatch || hit.taskTitle} /></button><span className="text-xs text-muted-foreground">{hit.taskStatus === "waiting" ? "Waiting for response" : hit.taskStatus}</span></div>
      <div className="mt-1 text-xs text-muted-foreground">{hit.label}{hit.at ? ` · ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(hit.at))}` : ""}</div>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed"><SearchHighlight text={hit.snippet} /></p>
      <div className="mt-3 flex flex-wrap items-center gap-3"><Button variant="outline" size="sm" data-c247-ux-action="task-open" onClick={() => navigate.toPluginPanel("desk", { subPath: withThread(hit.taskId, threadId) })}>Open task</Button>
        {hit.threadId && <><Button variant="outline" size="sm" data-c247-ux-action="chat-open" onClick={() => navigate.toThread(hit.threadId!)}>Open chat</Button>{hit.sequence !== null && <Button variant="outline" size="sm" onClick={() => void openSearchMessage(hit.threadId!, hit.sequence!, navigate).catch(error => toast.error(error.message))}>Open message</Button>}</>}
      </div>
    </article>)}</div>
    {data && (offset > 0 || data.nextOffset !== null) && <div className="flex items-center justify-between"><Button variant="outline" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))}>Previous</Button><span className="text-xs text-muted-foreground">{offset + 1}–{offset + data.hits.length} of {data.total}</span><Button variant="outline" disabled={busy || data.nextOffset === null} onClick={() => setOffset(data.nextOffset!)}>Next</Button></div>}
  </div></div>;
}
