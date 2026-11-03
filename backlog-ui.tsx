import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract, Dossier, TaskCard } from "./contracts.js";
import type { backlogRpcContract } from "./backlog-contracts.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Icon } from "./components/ui/icon.js";
import { sourceHref } from "./task-sources.js";

type State = z.infer<typeof backlogRpcContract.backlogState.output>;
type Review = (dossier: Dossier, proposal: Dossier["proposals"][number], busy: boolean, action: (fn: () => Promise<unknown>) => Promise<boolean>) => ReactNode;
const outcomes = { ready: "Ready to work", waiting: "Waiting for someone", close: "Can be closed", decision: "Your decision", duplicate: "Possible duplicate", unverified: "Could not verify" };
const tones = { ready: "border-l-emerald-500", waiting: "border-l-sky-500", close: "border-l-violet-500", decision: "border-l-amber-500", duplicate: "border-l-orange-500", unverified: "border-l-red-500" };

export function BacklogPage({ renderProposal }: { renderProposal: Review }) {
  const rpc = useRpc<typeof rpcContract>(), navigate = useBbNavigate();
  const [data, setData] = useState<State | null>(null), [tasks, setTasks] = useState<TaskCard[]>([]);
  const [selected, setSelected] = useState<Set<string> | null>(null), [query, setQuery] = useState("");
  const [tab, setTab] = useState<"tasks" | "results">("tasks"), [outcome, setOutcome] = useState("");
  const [runId, setRunId] = useState<string | undefined>(), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ taskId: string; proposalId: string; dossier: Dossier } | null>(null);
  const mounted = useRef(true), generation = useRef(0), flight = useRef(false), launch = useRef<{ key: string; id: string } | null>(null);
  const chatRequests = useRef(new Map<string, string>());
  const refresh = useCallback(async () => {
    const seq = ++generation.current;
    try {
      const [state, list] = await Promise.all([rpc.call("backlogState", runId ? { runId } : {}), rpc.call("list", { history: false })]);
      if (mounted.current && seq === generation.current) { setData(state); setTasks(list.tasks); setSelected(previous => previous ?? new Set(list.tasks.map(t => t.id))); }
    } catch (cause) { if (mounted.current && seq === generation.current) setError(String(cause)); }
  }, [rpc, runId]);
  useEffect(() => { mounted.current = true; void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => { mounted.current = false; generation.current++; clearInterval(timer); }; }, [refresh]);
  useRealtime("desk-changed", refresh);
  const running = data?.history.some(r => ["starting", "running"].includes(r.status)) ?? false;
  const picked = tasks.filter(t => selected?.has(t.id));
  const filtered = tasks.filter(t => `${t.title} ${t.customer ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  async function action(fn: () => Promise<unknown>) {
    if (flight.current) return false;
    flight.current = true; setBusy(true); setError(null);
    try { await fn(); await refresh(); return true; }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  async function start() {
    const ids = picked.map(t => t.id).sort(), key = JSON.stringify(ids);
    if (launch.current?.key !== key) launch.current = { key, id: crypto.randomUUID() };
    await action(async () => { const run = await rpc.call("backlogStart", { taskIds: ids, requestId: launch.current!.id }); if (mounted.current) { setRunId(run.id); setTab("results"); launch.current = null; } });
  }
  async function openChat(taskId: string) {
    await action(async () => {
      const requestId = chatRequests.current.get(taskId) ?? crypto.randomUUID(); chatRequests.current.set(taskId, requestId);
      const session = await rpc.call("openChat", { taskId, requestId });
      if (!session.workerThreadId) throw new Error(session.error || "The chat is still starting. Try again.");
      navigate.toThread(session.workerThreadId);
    });
  }
  async function review(taskId: string, proposalId: string) {
    await action(async () => { const dossier = await rpc.call("detail", { id: taskId }); if (mounted.current) setDetail({ taskId, proposalId, dossier }); });
  }
  async function decide(fn: () => Promise<unknown>) {
    return action(async () => { await fn(); if (detail) { const dossier = await rpc.call("detail", { id: detail.taskId }); if (mounted.current) setDetail({ ...detail, dossier }); } });
  }
  let proposal = detail?.dossier.proposals.find(p => p.id === detail.proposalId);
  const seen = new Set<string>();
  while (proposal?.partReview?.remainingId && !seen.has(proposal.id)) { seen.add(proposal.id); proposal = detail?.dossier.proposals.find(p => p.id === proposal!.partReview!.remainingId) ?? proposal; }
  return <div className="h-full overflow-y-auto"><div className="mx-auto max-w-6xl space-y-5 p-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-medium">Backlog</h1><p className="mt-1 text-sm text-muted-foreground">Review what is still needed, what is waiting, and what can be closed.</p></div>
      <Button disabled={busy || running || !data?.configured || !picked.length} onClick={() => void start()}><Icon name="Search" />Review selected · {picked.length}</Button></div>
    {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">{error}<Button size="sm" variant="ghost" onClick={() => { setError(null); void refresh(); }}>Refresh</Button></div>}
    {data && <p className="text-xs text-muted-foreground">{data.configured ? `Corporate account: ${data.providerId} · ${data.model}. Changes stay pending until you accept them.` : "Configure the corporate Backlog provider and model in 247C settings before starting."}</p>}
    {data?.run && <section aria-label="Review progress" className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
      <div className="flex flex-wrap items-center gap-3"><strong className="mr-auto">{data.run.status === "running" ? "Reviewing" : data.run.status === "starting" ? "Starting review" : data.run.status === "completed" ? "Review complete" : data.run.status === "stopped" ? "Review stopped" : "Review incomplete"} · {data.run.checked}/{data.run.total}</strong>
        {data.run.threadId && <Button size="sm" variant="outline" onClick={() => navigate.toThread(data.run!.threadId!)}>Open review chat</Button>}
        {["running", "starting"].includes(data.run.status) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(() => rpc.call("backlogStop", { runId: data.run!.id }))}>Stop review</Button>}</div>
      <progress className="h-2 w-full accent-primary" aria-label="Tasks reviewed" max={data.run.total} value={data.run.checked} />
      <p className="text-xs text-muted-foreground">{data.run.unverified} could not be verified · {data.run.total - data.run.checked} not reviewed. Saved results remain available after leaving this page.</p>
      {data.run.error && <p role="alert" className="text-sm text-destructive">{data.run.error}</p>}
    </section>}
    <div className="flex flex-wrap items-center gap-2"><Button variant={tab === "tasks" ? "secondary" : "ghost"} onClick={() => setTab("tasks")}>Tasks to review · {tasks.length}</Button><Button variant={tab === "results" ? "secondary" : "ghost"} onClick={() => setTab("results")}>Results · {data?.run?.checked ?? 0}</Button>
      {data && data.history.length > 1 && <select aria-label="Review history" className="ml-auto rounded border border-input bg-background p-2 text-sm" value={data.run?.id ?? ""} onChange={e => { setRunId(e.target.value); setTab("results"); setDetail(null); }}>{data.history.map(r => <option key={r.id} value={r.id}>{new Date(r.startedAt).toLocaleString()} · {r.checked}/{r.total}</option>)}</select>}</div>
    <Input aria-label="Filter backlog tasks" placeholder="Filter tasks" value={query} onChange={e => setQuery(e.target.value)} />
    {tab === "tasks" ? <>
      <div className="flex flex-wrap items-center gap-3 text-sm"><span>{picked.length} of {tasks.length} selected{query ? ` · ${filtered.length} shown` : ""}</span><Button size="sm" variant="outline" disabled={busy || running} onClick={() => setSelected(new Set(tasks.map(t => t.id)))}>Select all</Button><Button size="sm" variant="ghost" disabled={busy || running} onClick={() => setSelected(new Set())}>Clear selection</Button></div>
      {!data && <p role="status">Loading backlog…</p>}
      {data && !tasks.length && <p className="text-sm text-muted-foreground">No open or waiting tasks.</p>}
      <div className="space-y-2">{filtered.map(t => <label key={t.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-4 hover:bg-muted/30"><input type="checkbox" className="mt-1 size-4 accent-primary" aria-label={`Select ${t.title}`} checked={selected?.has(t.id) ?? true} disabled={busy || running} onChange={e => setSelected(previous => { const next = new Set(previous); e.target.checked ? next.add(t.id) : next.delete(t.id); return next; })} /><span className="min-w-0"><span className="font-medium">{t.title}</span><span className="mt-1 block text-xs text-muted-foreground">{t.status === "waiting" ? "Waiting for response" : "Open"} · Updated {new Date(t.updatedAt).toLocaleDateString()}{t.pendingCount ? ` · ${t.pendingCount} pending proposals` : ""}</span>{t.nextStep && <span className="mt-1 block truncate text-sm text-muted-foreground">{t.nextStep}</span>}</span></label>)}</div>
    </> : <>
      <select aria-label="Filter review results" className="rounded border border-input bg-background p-2 text-sm" value={outcome} onChange={e => setOutcome(e.target.value)}><option value="">All results and unchecked tasks</option>{Object.entries(outcomes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}<option value="unchecked">Not reviewed</option></select>
      {!data?.run && <p className="text-sm text-muted-foreground">Select tasks and start a review. Results will appear here as each task is checked.</p>}
      <div className="space-y-3">{data?.items.filter(i => i.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (!outcome || (outcome === "unchecked" ? !i.result : i.result?.outcome === outcome))).map(i => <article key={i.taskId} className={`rounded-xl border border-l-4 border-border p-4 ${i.result ? tones[i.result.outcome] : ""}`}>
        <div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><p className="text-xs font-medium text-muted-foreground">{i.taskStatus === "done" ? "Closed" : i.taskStatus === "archived" ? "Archived" : i.result ? outcomes[i.result.outcome] : "Not reviewed"}{i.stale && !["done", "archived"].includes(i.taskStatus) ? " · Task changed since this review" : ""}</p><h2 className="mt-1 font-medium">{i.title}</h2></div><Button size="sm" variant="outline" onClick={() => navigate.toPluginPanel("desk", { subPath: i.taskId })}>Open task</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void openChat(i.taskId)}>Open chat</Button></div>
        {i.result && <div className="mt-3 space-y-2 text-sm"><p>{i.result.summary}</p>{i.result.action && !["done", "archived"].includes(i.taskStatus) && <p className="font-medium">{i.result.action}</p>}<p className="text-xs text-muted-foreground">{i.result.sourceDetail}</p>{i.result.duplicateTaskId && <Button variant="link" size="sm" onClick={() => navigate.toPluginPanel("desk", { subPath: i.result!.duplicateTaskId! })}>Open related task</Button>}</div>}
        {i.sources.length > 0 && <div className="mt-2 flex flex-wrap gap-3 text-xs">{i.sources.map((s, index) => <a key={s.url} href={sourceHref(s.url, true)} target="_blank" rel="noopener noreferrer" className="text-primary underline">{s.label} · Source {index + 1}</a>)}</div>}
        {i.proposalNote && <p className="mt-3 text-xs text-muted-foreground">{i.proposalNote}</p>}
        {i.proposalId && <div className="mt-3"><Button size="sm" disabled={busy} variant="secondary" onClick={() => void review(i.taskId, i.proposalId!)}>Review proposal · {i.proposalStatus}</Button></div>}
        {detail?.taskId === i.taskId && proposal && <div className="mt-4">{renderProposal(detail.dossier, proposal, busy, decide)}<Button size="sm" variant="ghost" disabled={busy} onClick={() => setDetail(null)}>Hide changes</Button></div>}
      </article>)}</div>
    </>}
  </div></div>;
}
