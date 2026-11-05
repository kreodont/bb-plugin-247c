import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { useUxRpc } from "./ux-app.js";
import { Button } from "./components/ui/button.js";
import { Icon } from "./components/ui/icon.js";
import { threadActionClass } from "./thread-action-style.js";
import type { automationStateSchema } from "./automation-contracts.js";
import type { z } from "zod";

function useAutomaticWork() {
  const rpc = useUxRpc(), [state, setState] = useState<z.infer<typeof automationStateSchema>>(), [error, setError] = useState("");
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    try { const value = await rpc.call("automationState", {}); if (mounted.current) { setState(value); setError(""); } }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [rpc]);
  useEffect(() => { mounted.current = true; void refresh(); const timer = setInterval(() => void refresh(), 10000); return () => { mounted.current = false; clearInterval(timer); }; }, [refresh]);
  useRealtime("desk-changed", refresh);
  return { rpc, state, error, refresh };
}
export function AutomaticWorkStatus() {
  const { state, error } = useAutomaticWork(), navigate = useBbNavigate();
  if (!state?.enabled && !state?.errors.length && !error) return null;
  const attention = (state?.sessions.filter(s => s.state === "needs_input").length ?? 0) + (state?.errors.length ?? 0);
  return <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-1 text-xs">
    <span>{error || `Automatic work ${state?.enabled ? "on" : "off"} · ${state?.queued ?? 0} queued${attention ? ` · ${attention} need attention` : ""}`}</span>
    <Button size="sm" variant="ghost" onClick={() => navigate.toPluginPanel("desk", { subPath: "automatic" })}>Manage</Button>
  </div>;
}
export function AutomaticWorkPage() {
  const { rpc, state, error, refresh } = useAutomaticWork(), navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);
  async function act(work: () => Promise<unknown>) {
    if (busy) return; setBusy(true);
    try { await work(); await refresh(); } catch (cause) { toast.error("Automatic work needs attention", { description: cause instanceof Error ? cause.message : String(cause) }); } finally { setBusy(false); }
  }
  return <div className="h-full overflow-auto p-6"><div className="mx-auto max-w-4xl space-y-5">
    <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Automatic work</h2><Button disabled={!state || busy} variant={state?.enabled ? "outline" : "default"} onClick={() => void act(() => rpc.call("automationSet", { enabled: !state?.enabled }))}>{state?.enabled ? "Turn off" : "Turn on"}</Button></div>
    <p className="text-sm text-muted-foreground">New incoming changes are accepted and work chats start automatically. Sessions stay open until you choose Finish session or Pause session. Reviews apply task changes; reported time stays in Proposals for your confirmation. External writes require your approval in the work chat.</p>
    <p className="text-sm text-muted-foreground">Up to {state?.maximumWorkers ?? 2} automatic chats work at once. Turning this off stops new launches and automatic approvals; already running responses can finish. Existing pending proposals are left for manual review when you turn it on.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {state && <p>{state.queued} updates queued · {state.paused.length} tasks paused</p>}
    {state?.errors.map(item => <div key={item.id} role="alert" className="flex items-center gap-3 rounded border border-destructive p-3"><p className="flex-1 text-sm">{item.message}</p>{item.retryable && <Button variant="outline" disabled={busy} onClick={() => void act(() => rpc.call("automationRetry", { id: item.id }))}>Retry</Button>}{item.threadId && <Button variant="outline" onClick={() => navigate.toThread(item.threadId!)}>Open chat</Button>}<Button variant="ghost" onClick={() => navigate.toPluginPanel("desk", { subPath: "proposals" })}>Proposals</Button></div>)}
    {state?.sessions.map(item => <div key={item.sessionId} className="flex items-center gap-3 rounded border border-border p-3"><div className="min-w-0 flex-1"><p>{item.title}</p><p className="text-sm text-muted-foreground">{({ working: "Working", needs_input: "Needs your input", ready: "Ready for you to finish", reviewing: "Reviewing", blocked: "Needs attention" } as Record<string,string>)[item.state] ?? item.state}{item.note ? ` · ${item.note}` : ""}</p></div>{item.threadId && <Button variant="outline" onClick={() => navigate.toThread(item.threadId!)}>Open chat</Button>}</div>)}
    {state?.paused.map(item => <div key={item.taskId} className="flex items-center gap-3 rounded border border-border p-3"><div className="flex-1"><p>{item.title}</p><p className="text-sm text-muted-foreground">Planned for {item.until} · waiting for manual continuation</p></div><Button disabled={busy} onClick={() => void act(async () => { const session = await rpc.call("openChat", { taskId: item.taskId, requestId: crypto.randomUUID() }); if (session.workerThreadId) navigate.toThread(session.workerThreadId); })}>Resume chat</Button></div>)}
  </div></div>;
}
export function ThreadPauseAction({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useUxRpc(), [visible, setVisible] = useState(false), [busy, setBusy] = useState(false), [sessionId, setSessionId] = useState("");
  const refresh = useCallback(async () => { const { session } = await rpc.call("threadSession", { threadId }); setVisible(session?.mode === "conversation" && session.workerThreadId === threadId && session.status === "working"); setSessionId(session?.id ?? ""); }, [rpc, threadId]);
  useEffect(() => { void refresh().catch(() => setVisible(false)); }, [refresh]);
  useRealtime("desk-changed", () => void refresh().catch(() => setVisible(false)));
  if (!visible) return null;
  return <Button size="sm" variant="outline" className={threadActionClass("pinned", isCompactViewport)} aria-label="Pause session" aria-description="End and review this session without choosing done or waiting. Keep the task open and plan it for tomorrow." disabled={busy} onClick={async () => {
    if (busy) return; setBusy(true);
    try { await rpc.call("pauseSession", { sessionId }); toast.success("Session paused", { description: "Results will be reviewed; the task stays open and is planned for tomorrow. Continue manually." }); }
    catch (cause) { toast.error("Could not finish pausing", { description: cause instanceof Error ? cause.message : String(cause) }); }
    finally { setBusy(false); void refresh(); }
  }}><Icon name="Pause" />{!isCompactViewport && (busy ? "Pausing…" : "Pause session")}</Button>;
}
