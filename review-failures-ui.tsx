import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contracts.js";
import type { ReviewFailures } from "./review-failures-contracts.js";
import { taskReviewPath } from "./desk-routes.js";
import { Button } from "./components/ui/button.js";
import { Icon } from "./components/ui/icon.js";

export function useReviewFailures() {
  const rpc = useRpc<typeof rpcContract>(), connection = useRealtimeConnectionState();
  const [data, setData] = useState<ReviewFailures | null>(null), [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useRealtime("desk-changed", refresh);
  useEffect(() => {
    const timer = setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [refresh]);
  useEffect(() => {
    let current = true;
    rpc.call("reviewFailures", {}).then(value => {
      if (current) { setData(value); setError(null); }
    }, () => { if (current) setError("Unable to read conversation review status."); });
    return () => { current = false; };
  }, [rpc, revision, connection]);
  return { data, error, refresh };
}

export function ReviewFailureBadge() {
  const { data, error } = useReviewFailures(), navigate = useBbNavigate();
  if (!error && !data?.total) return null;
  const label = error ? "Conversation review status unavailable" : `Failed conversation reviews: ${data!.total}`;
  return <button type="button" data-c247-review-shortcut="" aria-label={label} title={`${label}. Open failed reviews`}
    className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-destructive font-bold text-white"
    onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); navigate.toPluginPanel("desk", { subPath: "reviews" }); }}>!</button>;
}

const DISMISSED_KEY = "247c:review-dismissed-incidents";
function readDismissed(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]"); return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(-1000) : []; }
  catch { return []; }
}
export function ReviewFailureNotification() {
  const { data, error } = useReviewFailures(), navigate = useBbNavigate();
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === DISMISSED_KEY || event.key === null) setDismissed(readDismissed()); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const unseen = data?.failures.filter(failure => !dismissed.includes(failure.incidentId)) ?? [];
  const failure = unseen[0];
  if (!failure || error) return null;
  const dismiss = () => {
    const next = [...new Set([...readDismissed(), ...dismissed, ...unseen.map(f => f.incidentId)])].slice(-1000);
    setDismissed(next);
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)); } catch { /* The sidebar and task warnings remain. */ }
  };
  return <aside role="alert" aria-label="247C review failure notification" className="fixed right-4 top-16 z-50 w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-destructive/50 bg-background p-4 shadow-lg">
    <div className="flex items-start gap-3"><Icon name="AlertCircle" className="mt-0.5 size-5 shrink-0 text-destructive" /><div className="min-w-0 flex-1">
      <p className="font-medium">247C: review failed</p>
      <p className="mt-2 line-clamp-3 break-words text-sm font-medium">{failure.taskTitle}</p>
      <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm text-destructive">{failure.error}</p>
      <p className="mt-2 text-xs text-muted-foreground">The conversation review needs attention. Open it to inspect the error and retry.</p>
      {data && data.total > 1 && <p className="mt-2 text-xs">Reviews needing attention: {data.total}</p>}
      <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" onClick={() => { navigate.toPluginPanel("desk", { subPath: taskReviewPath(failure.taskId, failure.sessionId) }); dismiss(); }}>Open failed review</Button><Button size="sm" variant="ghost" onClick={dismiss}>Dismiss notification</Button></div>
    </div></div>
  </aside>;
}

export function ReviewFailuresPage() {
  const { data, error, refresh } = useReviewFailures(), navigate = useBbNavigate();
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-4xl space-y-4 p-5">
    <div className="flex items-center justify-between gap-3"><h1 className="text-xl font-medium">Failed reviews{data?.total ? ` · ${data.total}` : ""}</h1><Button size="sm" variant="outline" onClick={refresh}>Refresh</Button></div>
    <p className="text-sm text-muted-foreground">These conversation reviews did not finish. Open the affected session to retry or discuss the review. Dismissing a notification keeps the failure here until recovery; closed tasks keep their previous errors in Work history.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!data && !error && <p role="status">Loading review status…</p>}
    {data?.total === 0 && !error && <p role="status" className="rounded-lg border border-border p-4">No failed reviews need attention.</p>}
    {data?.failures.map(failure => <article key={failure.incidentId} className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
      <h2 className="break-words text-sm font-medium">{failure.taskTitle}</h2>
      <p className="whitespace-pre-wrap break-words text-sm text-destructive">{failure.error}</p>
      <div className="flex flex-wrap items-center justify-between gap-3"><time className="text-xs text-muted-foreground" dateTime={failure.failedAt}>{new Date(failure.failedAt).toLocaleString()}</time><Button size="sm" variant="outline" onClick={() => navigate.toPluginPanel("desk", { subPath: taskReviewPath(failure.taskId, failure.sessionId) })}>Open failed review</Button></div>
    </article>)}
    {data && data.total > data.failures.length && <p className="text-sm text-muted-foreground">Showing the latest {data.failures.length} of {data.total} failed reviews.</p>}
  </div></div>;
}
