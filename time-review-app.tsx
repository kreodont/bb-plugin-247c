import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc, useRealtime, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contracts.js";
import type { timeReviewRpcContract } from "./time-review-contracts.js";
import { formatMinutes, parseMinutes } from "./day-contracts.js";
import type { z } from "zod";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";

type Review = z.infer<typeof timeReviewRpcContract.timeReview.output>;
export function TimeReviewPanel({ date, week = false, beforeChange, onChanged }: { date?: string; week?: boolean; beforeChange?: () => Promise<boolean>; onChanged?: () => Promise<void> }) {
  const rpc = useRpc<typeof rpcContract>(), navigate = useBbNavigate();
  const [data, setData] = useState<Review | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const locked = useRef(false), sequence = useRef(0), keys = useRef(new Map<string, string>());
  const load = useCallback(async () => {
    const seq = ++sequence.current;
    try { const next = await rpc.call("timeReview", { date, week }); if (seq === sequence.current) setData(next); }
    catch (e) { if (seq === sequence.current) setError(String(e)); }
  }, [rpc, date, week]);
  useEffect(() => { void load(); const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 10000); return () => { sequence.current++; clearInterval(timer); }; }, [load]);
  useRealtime("desk-changed", load);
  function requestId(key: string) { if (!keys.current.has(key)) keys.current.set(key, crypto.randomUUID()); return keys.current.get(key)!; }
  async function action(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null);
    try { if (beforeChange && !await beforeChange()) return; await work(); await onChanged?.(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { await load(); locked.current = false; setBusy(false); }
  }
  function minutes(row: Review["proposals"][number]) { return drafts[row.id] === undefined ? row.minutes : parseMinutes(drafts[row.id]); }
  async function decide(row: Review["proposals"][number], decision: "accept" | "reject") {
    const value = decision === "accept" ? minutes(row) : undefined;
    if (value === null) throw new Error("Enter the time before confirming.");
    await rpc.call("timeReviewDecide", { id: row.id, decision, ...(value !== undefined ? { minutes: value } : {}), requestId: requestId(`${row.id}:${decision}:${value}`) });
  }
  if (!data) return error ? <p role="alert">{error}</p> : null;
  const ready = data.proposals.filter(row => !row.blockedReason && (drafts[row.id]?.trim() || row.minutes !== null));
  return <section aria-label="Time review" className="space-y-3 rounded-xl border border-border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">Time proposals{data.proposals.length ? ` · ${data.proposals.length}` : ""}</h2>{ready.length > 0 && <Button size="sm" disabled={busy} onClick={() => void action(async () => { const values = ready.map(row => ({ row, value: minutes(row) })); if (values.some(entry => entry.value === null)) throw new Error("Enter all durations before confirming."); for (const { row } of values) await decide(row, "accept"); })}>Confirm all time proposals</Button>}</div>
    {data.weekly.targetMinutes > 0 && <p className="text-sm" aria-label="Weekly reported minimum">Week of {data.weekly.from}: {formatMinutes(data.weekly.reportedMinutes)} reported / {formatMinutes(data.weekly.targetMinutes)} minimum. {data.weekly.remainingMinutes ? `${formatMinutes(data.weekly.remainingMinutes)} remaining.` : "Minimum reached."}</p>}
    <p className="text-xs text-muted-foreground">Draft estimates are excluded from reported totals. Confirm or edit the total for each task and date. Meetings are counted automatically after they end.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {data.proposals.map(row => <article key={row.id} aria-label={`Time proposal: ${row.title}`} className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><button type="button" className="text-left text-sm font-medium" onClick={() => navigate.toPluginPanel("desk", { subPath: row.taskId })}>{row.title}</button><span className="text-xs text-muted-foreground">{row.date}</span></div>
      <p className="text-sm whitespace-pre-wrap">{row.reason}</p>{row.question && <p className="text-sm">{row.question}</p>}
      <details className="text-xs text-muted-foreground"><summary>Evidence</summary>{row.evidence.map(e => <p className="my-2 whitespace-pre-wrap" key={e.id}>{e.source} · {e.at}{e.url && /^https?:\/\//.test(e.url) ? <> · <a href={e.url} target="_blank" rel="noreferrer">Open source</a></> : null}<br />{e.text}</p>)}</details>
      {row.blockedReason && <p className="text-sm text-destructive">{row.blockedReason}</p>}
      <div className="flex flex-wrap gap-2"><Input aria-label={`Time to confirm: ${row.title}`} className="w-32" placeholder="e.g. 30m" disabled={busy || !!row.blockedReason} value={drafts[row.id] ?? (row.minutes === null ? "" : formatMinutes(row.minutes))} onChange={e => setDrafts(previous => ({ ...previous, [row.id]: e.target.value }))} /><Button size="sm" disabled={busy || !!row.blockedReason} onClick={() => void action(() => decide(row, "accept"))}>Confirm time</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void action(() => decide(row, "reject"))}>Reject time</Button></div>
    </article>)}
    {!data.proposals.length && <p className="text-sm text-muted-foreground">No pending time proposals for {week ? "this week" : "this day"}.</p>}
    {!week && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3"><p role="status" className="text-sm">{data.reviewedAt ? "Day reviewed." : data.due ? "Daily time review is due." : `Daily time review at ${String(data.reviewHour).padStart(2, "0")}:00.`} {data.missingReported > 0 ? `${data.missingReported} entries still have no reported time. Check whether you worked on them.` : ""}</p><Button size="sm" variant="outline" disabled={busy || !!data.reviewedAt || data.proposals.length > 0} onClick={() => void action(async () => { await rpc.call("timeReviewComplete", { requestId: requestId(`complete:${data.date}:${data.revision}`), date: data.date, revision: data.revision }); })}>Mark day reviewed</Button></div>}
  </section>;
}

export function TimeReviewReminder() {
  const rpc = useRpc<typeof rpcContract>(), navigate = useBbNavigate();
  const [data, setData] = useState<Review | null>(null);
  const load = useCallback(async () => { try { setData(await rpc.call("timeReview", { week: false })); } catch { /* The Day page shows retrieval errors. */ } }, [rpc]);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 60000); return () => clearInterval(timer); }, [load]);
  useRealtime("desk-changed", load);
  if (!data?.due) return null;
  return <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4"><p className="text-sm">Review today's time. {data.proposals.length} time proposals await confirmation. {data.missingReported} entries have no reported time.</p><Button size="sm" onClick={() => navigate.toPluginPanel("desk", { subPath: `day/${data.date}` })}>Review today's time</Button></div>;
}
