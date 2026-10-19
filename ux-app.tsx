import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBbContext, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contracts.js";
import { UxCollector, beginUxAction, markUxFeedback, uxViewChanged } from "./ux-client.js";
import type { UxAction, UxPage, UxReport, UxState } from "./ux-contracts.js";
import { Button } from "./components/ui/button.js";

export function UxScope({ page, view = "", children, className }: { page: UxPage; view?: string; children: ReactNode; className?: string }) {
  useEffect(() => { uxViewChanged(); return () => { queueMicrotask(uxViewChanged); }; }, [page, view]);
  return <div data-c247-ux-page={page} data-c247-ux-view={view} className={className}>{children}</div>;
}
const mutations: Record<string, UxAction> = { dayAdd: "day-add", dayEdit: "day-edit", dayCarry: "day-carry", dayReorder: "day-reorder", dayConfig: "day-config", create: "task-create", note: "task-note", classify: "priority", status: "task-status", start: "session-start", finish: "thread-finish", accept: "proposal-accept", syncAccept: "proposal-accept", acceptInbox: "proposal-accept", reviewParts: "proposal-accept", reject: "proposal-reject", syncReject: "proposal-reject", syncQuickStart: "source-check", syncStart: "source-check", updaterStart: "source-check" };
export function useUxRpc(context?: "reported") {
  const rpc = useRpc<typeof rpcContract>();
  return useMemo(() => {
    const call: typeof rpc.call = async (method, ...args) => {
      const action = context === "reported" && (method === "dayEdit" || method === "dayAdd") ? "reported-save" : method === "reviewParts" && (args[0] as { decision?: string })?.decision === "reject" ? "proposal-reject" : mutations[method];
      const finish = action ? beginUxAction(action) : () => {};
      try { const result = await rpc.call(method, ...args); finish("ok"); return result; }
      catch (error) { finish("error"); throw error; }
    };
    return { call };
  }, [rpc, context]);
}
export function UxOverlay() {
  const rpc = useRpc<typeof rpcContract>(), navigate = useBbNavigate(), context = useBbContext();
  const [state, setState] = useState<UxState>(), [error, setError] = useState<string | null>(null), [shown, setShown] = useState(false), [note, setNote] = useState(""), [feedback, setFeedback] = useState(false), [saved, setSaved] = useState(false);
  const collector = useRef<UxCollector | null>(null);
  const refresh = useCallback(async () => { try { const value = await rpc.call("uxState", {}); collector.current?.update(value); setState(value); if (!value.enabled) setError(null); } catch { setError("Recording status unavailable"); } }, [rpc]);
  useRealtime("ux-changed", refresh);
  useEffect(() => {
    const c = new UxCollector(batch => rpc.call("uxRecord", batch), setError); collector.current = c;
    const check = () => setShown(Boolean(document.querySelector("[data-c247-ux-page]")));
    window.addEventListener("c247-ux-view", check);
    window.addEventListener("c247-ux-refresh", refresh);
    const timer = setInterval(() => { check(); void refresh(); }, 15000);
    check(); void refresh();
    return () => { clearInterval(timer); window.removeEventListener("c247-ux-view", check); window.removeEventListener("c247-ux-refresh", refresh); c.dispose(); collector.current = null; };
  }, [rpc, refresh]);
  useEffect(() => { const timer = setTimeout(() => { setShown(Boolean(document.querySelector("[data-c247-ux-page]"))); collector.current?.view(); }, 0); return () => clearTimeout(timer); }, [context.threadId, context.projectId]);
  if (!shown || !state && !error || state && !state.recordingId && !state.bytes && !state.controls?.length && state.storageAvailable && !error) return null;
  const warning = error || state?.storageAvailable === false;
  const label = warning ? "UX recording needs attention" : state?.enabled ? "UX recording" : state?.status === "expired" ? "UX recording expired" : "UX recording paused";
  return <aside data-c247-ux-private="" aria-label="UX recording" className="fixed bottom-3 right-3 z-40 max-w-[min(24rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-background p-2 text-xs shadow-lg">
    <div className="flex flex-wrap items-center gap-2"><span className={warning ? "text-destructive" : state?.enabled ? "text-emerald-600" : "text-amber-600"} aria-hidden="true">●</span><span role="status">{label}</span>{state?.enabled && <Button size="sm" variant="ghost" onClick={() => { setFeedback(v => !v); setSaved(false); }}>Something feels awkward</Button>}<Button size="sm" variant="ghost" aria-label="Review UX recording" onClick={() => navigate.toPluginPanel("desk", { subPath: "ux" })}>Review</Button></div>
    {state?.lastSavedAt && <p className="px-1 text-muted-foreground">Last saved {new Date(state.lastSavedAt).toLocaleString()}</p>}
    {state?.storageAvailable === false && <p role="alert" className="mt-1 text-destructive">Storage is unavailable. Retrying automatically.</p>}
    {feedback && <form className="mt-2 space-y-2" onSubmit={e => { e.preventDefault(); if (markUxFeedback(note)) { setSaved(true); setFeedback(false); setNote(""); } }}><label className="block">What felt awkward? <span className="text-muted-foreground">Optional, saved locally</span><textarea autoFocus maxLength={500} value={note} onChange={e => setNote(e.target.value)} className="mt-1 min-h-16 w-full rounded border border-input bg-background p-2" /></label><Button size="sm" type="submit">Mark this moment</Button></form>}
    {saved && <p role="status">Moment marked.</p>}{error && <p role="alert" className="mt-1 text-destructive">{error}</p>}
  </aside>;
}
export function UxPageView() {
  const rpc = useRpc<typeof rpcContract>();
  const [report, setReport] = useState<UxReport>(), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [deleting, setDeleting] = useState(false), [pausing, setPausing] = useState(false);
  const load = useCallback(async () => { try { setReport(await rpc.call("uxReport", {})); setError(null); } catch { setError("Could not read the UX recording."); } }, [rpc]);
  useEffect(() => { void load(); }, [load]);
  useRealtime("ux-changed", load);
  async function control(action: "start" | "pause" | "clear") { setBusy(true); try { await rpc.call("uxControl", { action }); setDeleting(false); setPausing(false); await load(); } catch { setError("Could not change the recording. Try again."); } finally { setBusy(false); } }
  return <div data-c247-ux-private="" className="h-full overflow-y-auto p-5"><div className="mx-auto max-w-4xl space-y-5">
    <h1 className="text-xl font-medium">UX recording</h1><p className="text-sm text-muted-foreground">Local interaction events from 247C and its thread controls. No chat text, field values, keystrokes, screenshots or model calls. Only feedback you submit includes text. Recording continues until you pause it, including after plugin updates and BB restarts. Raw events expire within 7 days or rotate at 16 MB. Daily counts are retained for 90 days. Recording runs while BB is open; it does not observe other apps.</p>
    <div className="flex flex-wrap items-center gap-2"><strong>{report?.state.status === "unavailable" ? "Storage unavailable · retrying" : report?.state.enabled ? "Recording" : report?.state.status === "expired" ? "Previous study expired" : "Paused"}</strong>{report?.state.enabled && <span className="text-xs">{report.state.endsAt ? `Stops ${new Date(report.state.endsAt).toLocaleString()}` : "Until you pause"}</span>}<Button disabled={busy || !report?.state.storageAvailable} onClick={() => report?.state.enabled ? setPausing(true) : void control("start")}>{report?.state.enabled ? "Pause recording" : "Start continuous recording"}</Button><Button variant="outline" onClick={() => void load()}>Refresh report</Button><Button variant="ghost" onClick={() => setDeleting(true)}>Delete recording</Button></div>
    {report?.state.lastSavedAt && <p className="text-xs text-muted-foreground">Last saved {new Date(report.state.lastSavedAt).toLocaleString()}. Idle periods do not generate interactions.</p>}
    {pausing && <div className="rounded border border-border p-3 text-sm">Pause recording until you start it again?<div className="mt-2 flex gap-2"><Button disabled={busy} onClick={() => void control("pause")}>Confirm pause</Button><Button variant="ghost" onClick={() => setPausing(false)}>Keep recording</Button></div></div>}
    {deleting && <div className="rounded border border-border p-3 text-sm">Delete the local interaction history and stop recording?<div className="mt-2 flex gap-2"><Button disabled={busy} onClick={() => void control("clear")}>Delete and stop</Button><Button variant="ghost" onClick={() => setDeleting(false)}>Keep recording</Button></div></div>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {report && <><p className="text-sm">{report.actions.reduce((n, a) => n + a.count, 0)} clicks · {report.results.reduce((n, r) => n + r.ok + r.errors, 0)} action outcomes · {report.events} total samples · {report.clients} browser sessions · {(report.state.bytes / 1024).toFixed(0)} KB · UI {report.builds.join(", ") || report.state.build}</p>
      <p className="text-xs text-muted-foreground">{report.rapidRepeatClicks} rapid repeated clicks. Repeats and pauses are clues to inspect, not proof of a usability problem. Background time and mouse position do not measure attention.</p>
      <div className="grid gap-5 md:grid-cols-2"><section><h2 className="mb-2 font-medium">Most used actions</h2>{report.actions.slice(0,15).map(a => <p className="flex justify-between border-b border-border py-2 text-sm" key={`${a.page}:${a.action}`}><span>{a.page} / {a.action}</span><span>{a.count}</span></p>)}</section><section><h2 className="mb-2 font-medium">Page transitions</h2>{report.transitions.slice(0,15).map(t => <p key={`${t.from}:${t.to}`} className="flex justify-between border-b border-border py-2 text-sm"><span>{t.from} → {t.to}</span><span>{t.count}</span></p>)}</section></div>
      <section><h2 className="mb-2 font-medium">Action outcomes</h2>{report.results.map(r => <p key={r.action} className="border-b border-border py-2 text-sm">{r.action}: {r.ok} succeeded, {r.errors} errors · median {r.medianMs} ms</p>)}</section>
      <section><h2 className="mb-2 font-medium">Marked moments</h2>{report.timeline.filter(e => e.kind === "feedback").map((e,i) => <p className="rounded border border-border p-3 text-sm" key={i}>{new Date(e.at).toLocaleString()} · {e.page}<br />{e.note || "Moment marked without a comment."}</p>)}</section>
      <section><h2 className="mb-2 font-medium">Daily counts · 90 days</h2><p className="mb-2 text-xs text-muted-foreground">UTC dates. Counts survive raw log rotation; no notes, coordinates or client IDs are retained here. Outcomes count instrumented operations, not individual tasks or proposals.</p>{report.daily?.map(day => <p key={day.date} className="border-b border-border py-2 text-sm">{day.date}: {day.clicks} clicks · {day.results} outcomes · {day.errors} errors</p>)}</section>
      <details><summary className="cursor-pointer text-sm">Recording controls and recovery</summary>{report.state.controls?.slice().reverse().map((event, i) => <p key={i} className="mt-1 text-xs">{new Date(event.at).toLocaleString()} · {event.reason}</p>)}</details>
      <details><summary className="cursor-pointer text-sm">Recent navigation and actions</summary><ol className="mt-3 space-y-1 text-xs">{report.timeline.filter(e => e.kind !== "feedback").map((e,i) => <li key={i}>{new Date(e.at).toLocaleTimeString()} · {e.client} · {e.page} / {e.kind} / {e.action}{e.outcome ? ` · ${e.outcome}` : ""}</li>)}</ol></details>
    </>}
  </div></div>;
}
