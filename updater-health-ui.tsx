import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { localDay } from "./day-contracts.js";
import type { rpcContract } from "./contracts.js";
import type { UpdaterHealthState } from "./updater-health-contracts.js";
import { Button } from "./components/ui/button.js";
import { Icon } from "./components/ui/icon.js";

export function useUpdaterHealth() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<UpdaterHealthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useRealtime("updater-health-changed", refresh);
  useRealtime("desk-changed", refresh);
  useEffect(() => {
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [refresh]);
  useEffect(() => {
    let mounted = true;
    rpc.call("updaterHealth", {}).then(value => { if (mounted) { setData(value); setError(null); } }, () => {
      if (mounted) setError("Unable to read updater status. The task list may be out of date.");
    });
    return () => { mounted = false; };
  }, [rpc, revision]);
  return { data, error, refresh };
}
function timestamp(value: number | null, zone: string) {
  return value === null ? "None recorded in recent history" : new Intl.DateTimeFormat("en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: zone,
  }).format(value);
}
function HealthDetails({ data }: { data: UpdaterHealthState }) {
  return <>
    <p className="mt-1 whitespace-pre-wrap break-words text-sm">{data.detail}</p>
    {data.calendarAlert && data.calendar && <div className="mt-2 rounded border border-destructive/30 p-2" aria-label="Calendar sync error"><p className="font-medium">Calendar sync failed</p><p className="text-sm whitespace-pre-wrap break-words">{data.calendar.lastError ?? data.calendar.message}</p><p className="mt-1 text-xs">Last successful calendar sync: {timestamp(data.calendar.completedAt ? Date.parse(data.calendar.completedAt) : null, data.timeZone)} · {data.timeZone}</p>{data.calendar.status === "running" && <p className="text-xs">Retry in progress. This warning remains until the calendar is updated successfully.</p>}</div>}
    <p className="mt-2 text-xs text-muted-foreground">Last successful run: {timestamp(data.lastSuccessAt, data.timeZone)} · {data.timeZone}</p>
    {data.running && <p className="mt-1 text-sm">{data.status === "waiting" ? "A check is running. Saved records will be analyzed in batches." : "A new check is running. This warning remains until recovery is confirmed."}</p>}
    {data.pendingRecords > 0 && <p className="mt-1 text-sm">Records awaiting analysis: {data.pendingRecords}</p>}
  </>;
}

export function analysisStateLabel(state: string) {
  return ({ launching: "Starting analysis", analyzing: "Analyzing", ready: "Saved; import pending",
    imported: "Imported into Proposals", failed: "Needs repair" } as Record<string, string>)[state] ?? state;
}
function SavedAnalysisAttempt({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [text, setText] = useState<string | null>(null);
  return <div><Button size="sm" variant="outline" onClick={() => {
    if (text !== null) { setText(null); return; }
    rpc.call("scriptAnalysisAttempt", { threadId }).then(attempt => setText(attempt
      ? JSON.stringify(attempt, null, 2) : "No saved submission is available."), () => setText("Could not load the saved submission. Try again."));
  }}>{text === null ? "View saved submission" : "Hide saved submission"}</Button>
    {text !== null && <pre aria-label="Saved analysis submission" className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border p-2 text-xs">{text}</pre>}
  </div>;
}

function statusPath(data: UpdaterHealthState | null) {
  return data?.calendarAlert ? `day/${localDay(new Date(), data.timeZone)}` : "updates";
}

function isAdvisory(data: UpdaterHealthState | null) {
  return Boolean(data && !data.calendarAlert && (data.status === "waiting"
    || (data.status === "overdue" && !data.running && data.nextRunAt !== null)));
}

export function UpdaterHealthBanner({ showHealthy = false }: { showHealthy?: boolean }) {
  const { data, error } = useUpdaterHealth();
  const navigate = useBbNavigate();
  if (error) return <div role="alert" className="m-4 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">{error}</div>;
  if (!data?.configured || (!data.alert && !showHealthy)) return null;
  const waiting = isAdvisory(data);
  return <section role={data.alert && !waiting ? "alert" : "status"} aria-label="Source updater status" className={`m-4 max-h-48 shrink-0 overflow-auto rounded-lg border p-4 ${waiting ? "border-amber-400/60 bg-amber-400/10" : data.alert ? "border-destructive/40 bg-destructive/5" : "border-border"}`}>
    <p className={`font-medium ${waiting ? "text-amber-800 dark:text-amber-300" : data.alert ? "text-destructive" : ""}`}>{data.title}</p>
    <HealthDetails data={data} />
    {data.calendarAlert && <Button className="mt-2" size="sm" variant="outline" onClick={() => navigate.toPluginPanel("desk", { subPath: statusPath(data) })}>Open calendar</Button>}
    {showHealthy && Boolean(data.analysisThreads?.length) && <div className="mt-2">
      <Button size="sm" variant="outline" onClick={() => navigate.toThread(data.analysisThreads![0].threadId)}>Analysis conversation</Button>
      <span className="ml-2 text-xs">{analysisStateLabel(data.analysisThreads![0].state)} · {data.analysisThreads![0].model} · {data.analysisThreads![0].reasoningLevel}</span>
      <details className="mt-2 text-xs"><summary>Analysis history · {data.analysisThreads!.length}</summary>{data.analysisThreads!.map(thread => <div key={thread.threadId} className="mt-1"><Button size="sm" variant="ghost" onClick={() => navigate.toThread(thread.threadId)}>{thread.title}</Button> · {analysisStateLabel(thread.state)}{thread.error && <p>{thread.error}</p>}{thread.hasSavedAttempt && <SavedAnalysisAttempt threadId={thread.threadId} />}</div>)}</details>
    </div>}
    {(showHealthy || waiting || data.pendingRecords > 0) && data.nextRunAt && <p className="mt-2 text-xs text-muted-foreground">Next scheduled run: {timestamp(data.nextRunAt, data.timeZone)}</p>}
  </section>;
}

export function UpdaterHealthBadge() {
  const { data, error } = useUpdaterHealth();
  const navigate = useBbNavigate();
  if (!error && (!data?.alert || isAdvisory(data))) return null;
  const label = error ? "Source updater status unavailable" : data!.title;
  return <button type="button" data-c247-updater-shortcut="" aria-label={label} title={`${label}. Open update status`}
    className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-destructive font-bold text-white"
    onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); navigate.toPluginPanel("desk", { subPath: statusPath(data) }); }}>!</button>;
}

const DISMISSED_KEY = "247c:updater-dismissed-incident";
export function UpdaterHealthNotification() {
  const { data, error } = useUpdaterHealth();
  const navigate = useBbNavigate();
  const [dismissed, setDismissed] = useState<string | null>(() => { try { return localStorage.getItem(DISMISSED_KEY); } catch { return null; } });
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === DISMISSED_KEY) setDismissed(event.newValue); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  useEffect(() => {
    if (!error && data?.configured && !data.alert) {
      setDismissed(null);
      try { localStorage.removeItem(DISMISSED_KEY); } catch { /* Keep the in-memory state. */ }
    }
  }, [data?.configured, data?.alert, error]);
  const incident = error ? "monitor-unavailable" : data?.incidentId;
  if (!incident || incident === dismissed || (!error && (!data?.alert || isAdvisory(data)))) return null;
  const dismiss = () => { setDismissed(incident); try { localStorage.setItem(DISMISSED_KEY, incident); } catch { /* The banner remains visible. */ } };
  return <aside role="alert" aria-label="247C updater notification" className="fixed bottom-4 right-4 z-50 w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-destructive/50 bg-background p-4 shadow-lg">
    <div className="flex items-start gap-3"><Icon name="AlertCircle" className="mt-0.5 size-5 shrink-0 text-destructive" /><div className="min-w-0 flex-1">
      <p className="font-medium">247C: {error ? "updater status unavailable" : data!.title}</p>
      <p className="mt-2 text-sm">{error ?? (data?.calendarAlert ? "Calendar sync failed. Meetings and day totals may be out of date." : "Source checks need attention. An empty proposal list does not mean there is no new work.")}</p>
      {data && <p className="mt-2 text-xs text-muted-foreground">{data.calendarAlert ? "Last successful calendar sync" : "Last successful run"}: {timestamp(data.calendarAlert ? (data.calendar?.completedAt ? Date.parse(data.calendar.completedAt) : null) : data.lastSuccessAt, data.timeZone)} · {data.timeZone}</p>}
      <div className="mt-3 flex gap-2"><Button size="sm" onClick={() => { navigate.toPluginPanel("desk", { subPath: statusPath(data) }); dismiss(); }}>{data?.calendarAlert ? "Open calendar" : "Open update status"}</Button><Button size="sm" variant="ghost" onClick={dismiss}>Dismiss notification</Button></div>
    </div></div>
  </aside>;
}
