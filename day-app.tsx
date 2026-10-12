import { ChatIndicator } from "./chat-indicator.js";
import { isLiveTask, taskStatusNames } from "./task-status.js";
import { WaitingStatus } from "./waiting-age.js";
import { beginUxAction } from "./ux-client.js";
import { useUxRpc } from "./ux-app.js";
import { usePlanningTimeZone } from "./day-zone.js";
import { sortDayItems } from "./day-sort.js";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contracts.js";
import { dayDateSchema, dayRpcContract, formatMinutes, localDay, parseMinutes, shiftDay, type DayItem, type DayView, type ReportedChange } from "./day-contracts.js";
import { z } from "zod";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Icon } from "./components/ui/icon.js";
import { cn } from "./lib/utils.js";
import { useNavigationGuard } from "./navigation.js";
import { taskDayPath, withThread } from "./desk-routes.js";

function useDaySnapshot<T>(read: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState<string | null>(null);
  const sequence = useRef(0), mounted = useRef(true), connection = useRealtimeConnectionState();
  const refresh = useCallback(async () => {
    const seq = ++sequence.current;
    try { const next = await read(); if (mounted.current && seq === sequence.current) { setData(next); setError(null); } }
    catch (e) { if (mounted.current && seq === sequence.current) setError(e instanceof Error ? e.message : String(e)); }
  }, [read]);
  useRealtime("desk-changed", refresh);
  useEffect(() => { mounted.current = true; void refresh(); const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 10000); return () => { mounted.current = false; sequence.current++; clearInterval(timer); }; }, [refresh, connection]);
  return { data, error, refresh };
}
function ErrorText({ error }: { error: string | null }) { return error ? <p role="alert" className="whitespace-pre-wrap break-words rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null; }
const shortDate = (date: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const eventTime = (at: string, timeZone: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(at));
const inputTime = (minutes: number | null) => minutes === null ? "" : formatMinutes(minutes);
type ViewItem = DayView["items"][number];
type Patch = Omit<z.input<typeof dayRpcContract.dayEdit.input>, "id" | "revision" | "requestId">;
type Flush = () => Promise<boolean>;

function DayPlannerControl({ date, beforeStart, refreshDay }: { date: string; beforeStart: Flush; refreshDay: () => Promise<void> }) {
  const timeZone = usePlanningTimeZone();
  const rpc = useUxRpc();
  const read = useCallback(() => rpc.call("dayPlannerState", {}), [rpc]);
  const { data, error, refresh } = useDaySnapshot(read);
  const [busy, setBusy] = useState(false), [mutationError, setMutationError] = useState<string | null>(null);
  const flight = useRef(false), request = useRef<{ date: string; id: string } | null>(null);
  const [launched, setLaunched] = useState<z.output<typeof dayRpcContract.dayPlannerStart.output> | null>(null);
  const run = launched && (!data?.run || launched.startedAt > data.run.startedAt) ? launched : data?.run;
  const running = run?.status === "running";
  useEffect(() => { if (run && run.status !== "running") void refreshDay(); }, [run?.id, run?.status, refreshDay]);
  async function start() {
    if (flight.current || running) return;
    flight.current = true; setBusy(true); setMutationError(null);
    try {
      if (!await beforeStart()) return;
      if (request.current?.date !== date) request.current = { date, id: crypto.randomUUID() };
      const result = await rpc.call("dayPlannerStart", { date, requestId: request.current.id });
      setLaunched(result); request.current = null;
      await refresh();
    } catch (e) { setMutationError(e instanceof Error ? e.message : String(e)); }
    finally { flight.current = false; setBusy(false); }
  }
  if (!data?.configured && !error) return null;
  const at = (time: number) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(time));
  return <section aria-label="Day planning" className="rounded-xl border border-border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-medium">Day planning</h2><p className="mt-1 text-xs text-muted-foreground">{data?.name ?? "Day planner"}{data?.scheduled && data.nextRunAt ? ` · next ${at(data.nextRunAt)}` : data?.configured ? " · schedule paused" : ""}</p></div><Button disabled={busy || running || !!error || !data?.configured || date !== data.today} onClick={() => void start()}><Icon name="Zap" />{busy ? "Starting…" : running ? "Creating plan…" : "Create day plan"}</Button></div>
    {date !== data?.today && data && <p className="mt-2 text-xs text-muted-foreground">Open Today to create a day plan.</p>}
    {run && <p role="status" className="mt-2 text-xs text-muted-foreground">{running ? "Creating today's plan. Saved tasks will appear here automatically." : run.message ? run.message : run.status === "succeeded" ? `Day planning finished · ${at(run.finishedAt ?? run.startedAt)}` : run.status === "skipped" ? `Run skipped${run.skipReason ? `: ${run.skipReason}` : "."}` : `Day planning failed · ${at(run.finishedAt ?? run.startedAt)}`}</p>}
    <ErrorText error={mutationError ?? error ?? (run?.status === "failed" ? run.error : null)} />
  </section>;
}

export function CalendarStatus({ date }: { date?: string }) {
  const timeZone = usePlanningTimeZone();
  const rpc = useUxRpc();
  const read = useCallback(() => rpc.call("calendarState", {}), [rpc]);
  const { data, error, refresh } = useDaySnapshot(read);
  const [busy, setBusy] = useState(false), [mutationError, setMutationError] = useState<string | null>(null);
  async function sync() {
    if (busy) return; setBusy(true); setMutationError(null);
    try { await rpc.call("calendarSync", date === undefined ? {} : { date }); await refresh(); }
    catch (e) { setMutationError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section aria-label="Work calendar" className="rounded-xl border border-border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-medium">Work calendar</h2><p className="mt-1 text-xs text-muted-foreground">{data?.status === "running" ? "Loading meetings…" : data?.status === "complete" ? `Meetings: ${data.events} · checked ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(data.completedAt!))}` : "Calendar from 247C settings"}{data?.from && data.through ? ` · ${shortDate(data.from)} — ${shortDate(data.through)}` : ""}</p></div><Button variant="outline" size="sm" disabled={busy || data?.status === "running"} onClick={() => void sync()}>Check calendar</Button></div>
    <p className="mt-2 text-xs text-muted-foreground">Meetings also update when checking email, Slack and Jira. Manual time edits are preserved.</p>
    <ErrorText error={mutationError ?? error ?? (data?.status === "error" ? data.message : null)} />
    {data?.status === "idle" && data.message && <p className="mt-2 text-xs text-muted-foreground">{data.message}</p>}
  </section>;
}

const sourceNames: Record<ReportedChange["source"], string> = { panel: "manual", conversation: "from chat", session_review: "session review", calendar: "auto", ai_estimate: "estimate · review", other: "other" };
// The changes behind the current reported value: the latest replacement plus accepted
// session estimates added after it (mirrors reportedComposition on the server).
function composition(changes: ReportedChange[]) {
  const result: ReportedChange[] = [];
  for (const change of [...changes].reverse()) { result.unshift(change); if (change.source !== "session_review" || change.from === null) break; }
  return result;
}
function ReportedOrigin({ changes, timeZone }: { changes: ReportedChange[]; timeZone: string }) {
  const navigate = useBbNavigate();
  // Manual panel entries and calendar time are self-explanatory; name everything else.
  const shown = composition(changes).filter(c => c.source !== "panel" && c.source !== "calendar");
  if (!shown.length) return null;
  return <div className="mt-2 space-y-1 text-xs text-muted-foreground">{shown.map((c, i) => <div key={`${c.at}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
    <span className="tabular-nums text-foreground">{c.from === null || c.source !== "session_review" ? formatMinutes(c.to) : `+${formatMinutes((c.to ?? 0) - c.from)}`}</span>
    <span>{c.label} · {new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "short", timeZone }).format(new Date(c.at))}</span>
    {c.threadId && <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => navigate.toThread(c.threadId!)}>Open chat</Button>}
    {c.reason && <p className="basis-full whitespace-pre-wrap break-words">{c.reason}</p>}
  </div>)}</div>;
}

function ItemHistory({ id }: { id: string }) {
  const timeZone = usePlanningTimeZone();
  const rpc = useUxRpc();
  const [offset, setOffset] = useState(0);
  const read = useCallback(() => rpc.call("dayHistory", { id, offset }), [rpc, id, offset]);
  const { data, error } = useDaySnapshot(read);
  return <div className="space-y-3"><ErrorText error={error} />{data?.items.map(event => <div key={event.sequence} className="rounded-lg bg-muted/40 p-3 text-xs"><div className="flex flex-wrap justify-between gap-2 text-muted-foreground"><span>{new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "short", timeZone }).format(new Date(event.at))}</span><span>{event.actor.startsWith("agent-time:") ? "Agent time / estimate" : event.actor.startsWith("calendar:") ? "Calendar" : event.actor.startsWith("bb-thread:") ? "From conversation" : event.actor.startsWith("human:session-time:") ? "Accepted session estimate" : "Manual"}</span></div><p className="mt-2">Planned: {formatMinutes(event.before?.plannedMinutes ?? null)} → {formatMinutes(event.after.plannedMinutes)} · Actual: {formatMinutes(event.before?.actualMinutes ?? null)} → {formatMinutes(event.after.actualMinutes)} · Reported: {formatMinutes(event.before?.reportedMinutes ?? null)} → {formatMinutes(event.after.reportedMinutes)}</p>{event.after.reportedMode === "estimate" && <p className="mt-1">Estimate: {event.after.reportedEstimate?.reason}</p>}{event.before?.date !== event.after.date && <p className="mt-1">Date: {event.before?.date ?? "—"} → {event.after.date}</p>}{event.after.carriedTo && <p className="mt-1">Continuation: {event.after.carriedTo}</p>}{event.before?.step !== event.after.step && event.after.step && <p className="mt-1 whitespace-pre-wrap">{event.after.step}</p>}{event.before?.removed !== event.after.removed && event.after.removed && <p className="mt-1">Removed from the day; saved reported time is excluded from totals.</p>}</div>)}{data && (offset > 0 || data.nextOffset !== null) && <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Newer</Button><Button size="sm" variant="ghost" disabled={data.nextOffset === null} onClick={() => setOffset(data.nextOffset!)}>Older</Button></div>}</div>;
}

function DayRow({ item, refresh, register, openTask, openDay, openChat, hasActiveChat, chatBusy, focused = false, hidden = false }: {
  item: ViewItem; refresh: () => Promise<void>; register: (id: string, flush: Flush | null) => void;
  openTask: (id: string) => Promise<void>; openDay: (date: string) => Promise<void>; focused?: boolean; hidden?: boolean;
  openChat: (id: string, existing: boolean) => Promise<void>; hasActiveChat: boolean; chatBusy: boolean;
}) {
  const timeZone = usePlanningTimeZone();
  const rpc = useUxRpc();
  const [draft, setDraft] = useState({ planned: inputTime(item.plannedMinutes), reported: inputTime(item.reportedMinutes), step: item.step, reportedDate: item.reportedDate });
  const [fields, setFields] = useState<Set<keyof typeof draft>>(new Set());
  const [baseRevision, setBaseRevision] = useState(item.revision), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false), [history, setHistory] = useState(false), [carryDate, setCarryDate] = useState(shiftDay(item.date, 1));
  const flight = useRef<Promise<boolean> | null>(null), retry = useRef<{ key: string; id: string } | null>(null);
  const row = useRef<HTMLElement>(null), reportedInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focused) { row.current?.scrollIntoView?.({ block: "center" }); reportedInput.current?.focus({ preventScroll: true }); reportedInput.current?.select(); }
  }, [focused, item.id]);
  const dirty = fields.size > 0;
  const pending = useRef({ draft, fields, revision: baseRevision });
  const focusedField = useRef<keyof typeof draft | null>(null);
  const [saved, setSaved] = useState(false);
  useLayoutEffect(() => {
    if (!pending.current.fields.size && !flight.current && item.revision >= pending.current.revision) {
      const next = { planned: inputTime(item.plannedMinutes), reported: inputTime(item.reportedMinutes), step: item.step, reportedDate: item.reportedDate };
      if (focusedField.current && item.revision === pending.current.revision) next[focusedField.current] = pending.current.draft[focusedField.current];
      pending.current = { draft: next, fields: new Set(), revision: item.revision };
      setDraft(next); setBaseRevision(item.revision);
    }
  }, [item.revision, item.plannedMinutes, item.reportedMinutes, item.step, item.reportedDate, dirty, busy]);
  function edit(field: keyof typeof draft, value: string) {
    const current = pending.current;
    const revision = !current.fields.size && !flight.current ? item.revision : current.revision;
    pending.current = { draft: { ...current.draft, [field]: value }, fields: new Set([...current.fields, field]), revision };
    setDraft(pending.current.draft); setFields(pending.current.fields); setBaseRevision(revision); setError(null); setSaved(false);
  }
  function discard() {
    pending.current.fields = new Set(); retry.current = null;
    setFields(new Set()); setError(null); setSaved(false);
  }
  function save(extra: Patch = {}, overwrite = false): Promise<boolean> {
    if (flight.current) {
      const active = flight.current;
      return Object.keys(extra).length || overwrite ? active.then(ok => ok || overwrite ? save(extra, overwrite) : false) : active;
    }
    if (!pending.current.fields.size && Object.keys(extra).length === 0) return Promise.resolve(true);
    // Defer execution so even a synchronous validation failure clears flight.
    flight.current = Promise.resolve().then(async () => {
      setBusy(true); setError(null);
      try {
        do {
          const snapshot = pending.current;
          const patch: Patch = {};
          if (!extra.restoreAuto) {
            if (snapshot.fields.has("planned")) patch.plannedMinutes = parseMinutes(snapshot.draft.planned);
            if (snapshot.fields.has("reported")) patch.reportedMinutes = parseMinutes(snapshot.draft.reported);
            if (snapshot.fields.has("step")) patch.step = snapshot.draft.step;
            if (snapshot.fields.has("reportedDate")) patch.reportedDate = dayDateSchema.parse(snapshot.draft.reportedDate);
          }
          const body = { id: item.id, revision: overwrite ? item.revision : snapshot.revision, ...patch, ...extra };
          const key = JSON.stringify(body);
          if (retry.current?.key !== key) retry.current = { key, id: crypto.randomUUID() };
          const result = await rpc.call("dayEdit", { ...body, requestId: retry.current.id });
          const current = pending.current;
          const remaining = new Set([...current.fields].filter(field => !snapshot.fields.has(field) || current.draft[field] !== snapshot.draft[field]));
          const next = { planned: inputTime(result.plannedMinutes), reported: inputTime(result.reportedMinutes), step: result.step, reportedDate: result.reportedDate };
          for (const field of remaining) next[field] = current.draft[field];
          if (focusedField.current) next[focusedField.current] = current.draft[focusedField.current];
          pending.current = { draft: next, fields: remaining, revision: result.revision };
          setFields(remaining); setBaseRevision(result.revision); setDraft(next); retry.current = null;
          extra = {}; overwrite = false;
          await refresh();
          // Include edits typed during the request before navigation can proceed.
        } while (pending.current.fields.size);
        setSaved(true); return true;
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); await refresh(); return false; }
      finally { flight.current = null; setBusy(false); }
    });
    return flight.current;
  }
  const saveLatest = useRef(save);
  useLayoutEffect(() => { saveLatest.current = save; });
  useEffect(() => {
    if (!dirty || busy || error) return;
    const timer = setTimeout(() => void saveLatest.current(), 600);
    return () => clearTimeout(timer);
  }, [draft, dirty, busy, error]);
  useEffect(() => { register(item.id, () => saveLatest.current()); return () => register(item.id, null); }, [item.id, register]);
  async function carry() {
    if (dirty && !await save()) return;
    setBusy(true); setError(null);
    try {
      const current = await rpc.call("day", { date: item.date });
      const latest = current.items.find(i => i.id === item.id)!;
      await rpc.call("dayCarry", { id: item.id, revision: latest.revision, date: dayDateSchema.parse(carryDate), requestId: crypto.randomUUID() }); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const inactive = item.removed || item.calendar && item.calendar.status !== "confirmed";
  return <article ref={row} hidden={hidden && !dirty && !busy && !error} aria-label={`Day entry: ${item.title}`} className={cn("border-t border-border p-4", focused && "bg-primary/5", inactive && "bg-muted/20")}>
    <div className="grid grid-cols-3 items-start gap-3 md:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_6.5rem]">
      <div className="col-span-3 flex min-w-0 items-start gap-3 md:col-span-1">
        {item.kind === "task" ? <input type="checkbox" className="mt-1 size-4 shrink-0 accent-current" aria-label={`Step completed: ${item.title}`} checked={item.state === "done"} disabled={busy && !flight.current || inactive || item.state === "carried"} onChange={e => void save({ state: e.target.checked ? "done" : "open" })} /> : <span aria-label="Calendar meeting" className="mt-0.5 text-primary">▦</span>}
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2">{item.taskId && hasActiveChat && <ChatIndicator />}{item.taskId ? <button type="button" className={cn("min-w-0 flex-1 break-words text-left text-sm font-medium underline-offset-4 hover:text-primary hover:underline", inactive && "text-muted-foreground")} onClick={() => void openTask(item.taskId!)}>{item.title}</button> : item.calendar?.url ? <a href={item.calendar.url} target="_blank" rel="noreferrer" className="break-words text-sm font-medium underline-offset-4 hover:underline">{item.title}</a> : <h3 className="break-words text-sm font-medium">{item.title}</h3>}{item.taskStatus && item.taskStatus !== "open" && <span className={cn("text-xs", item.taskStatus === "waiting" ? "rounded-full bg-sky-400/15 px-2 py-0.5 text-sky-700 dark:text-sky-300" : "text-muted-foreground")}>{item.taskStatus === "waiting" ? <WaitingStatus since={item.waitingSince} /> : taskStatusNames[item.taskStatus]}</span>}</div>
          {item.calendar ? <p className="mt-1 text-xs text-muted-foreground">{shortDate(item.date)} · {eventTime(item.calendar.startAt, timeZone)}–{eventTime(item.calendar.endAt, timeZone)} · {item.calendar.status === "cancelled" ? "canceled" : item.calendar.status === "declined" ? "invitation declined" : item.calendar.status === "excluded" ? "excluded from meeting time" : "from calendar"}</p> : item.step && <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{item.step}</p>}
          {item.carriedTo && <button className="mt-1 text-xs text-primary hover:underline" onClick={() => void openDay(item.carriedTo!)}>Continuation {shortDate(item.carriedTo)}</button>}
          {item.reportOnly && <p className="mt-1 text-xs text-muted-foreground">Reported time is saved here. The meeting is planned for {shortDate(item.date)}.</p>}
          {item.removed && <p className="mt-1 text-xs text-muted-foreground">Removed from the day; saved reported time is excluded from totals.</p>}
          {!item.calendar && item.plannedMinutes === null && item.reportedMinutes !== null && <p className="mt-1 text-xs text-muted-foreground">Outside the plan</p>}
          {item.taskId && (hasActiveChat || isLiveTask(item.taskStatus)) && <Button data-c247-ux-action={hasActiveChat ? "chat-open" : "chat-new"} type="button" className="mt-2" size="sm" variant={hasActiveChat ? "default" : "outline"} disabled={chatBusy} onClick={() => void openChat(item.taskId!, hasActiveChat)}><Icon name={hasActiveChat ? "MessageSquare" : "Plus"} aria-hidden="true" />{hasActiveChat ? "Open chat" : "New chat"}</Button>}
        </div>
      </div>
      <label className="text-xs text-muted-foreground">Planned<Input aria-label={`Planned: ${item.title}`} className="mt-1 text-right tabular-nums" value={draft.planned} placeholder="—" onFocus={() => { focusedField.current = "planned"; }} onBlur={() => { focusedField.current = null; if (!error) void save(); }} onChange={e => edit("planned", e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void save(); } }} />{item.calendar && <span className="mt-1 block text-right text-xs">{item.plannedMode === "calendar" ? "calendar" : "manual"}</span>}</label>
      <div className="text-xs text-muted-foreground">Actual<output aria-label={`Actual: ${item.title}`} className="mt-1 flex h-9 items-center justify-end rounded-md border border-transparent px-3 text-sm tabular-nums text-foreground">{formatMinutes(item.actualMinutes)}</output><span className="mt-1 block text-right text-xs">{item.kind === "meeting" ? "= reported" : "agents"}</span></div>
      <label className="text-xs text-muted-foreground">Reported<Input data-c247-ux-action="reported-edit" ref={reportedInput} aria-label={`Reported: ${item.title}`} className="mt-1 text-right tabular-nums" value={draft.reported} placeholder="—" onFocus={() => { focusedField.current = "reported"; }} onBlur={() => { focusedField.current = null; if (!error) void save(); }} onChange={e => edit("reported", e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void save(); } }} />{item.calendar && <span className="mt-1 block text-right text-xs">{item.reportedMode === "calendar" ? item.reportedMinutes === null ? "after the meeting" : "auto" : "manual"}</span>}{!item.calendar && <span className="mt-1 block text-right text-xs">{item.reportedMode === "estimate" && item.reportedMinutes !== null ? "estimate · review" : item.reportedMinutes !== null || item.reportedLocked ? sourceNames[item.reportedChanges.at(-1)?.source ?? "panel"] : (item.actualMinutes ?? 0) > 0 ? "awaiting AI estimate" : ""}</span>}</label>
    </div>
    {item.reportedMinutes !== null && item.reportedMode !== "estimate" && <ReportedOrigin changes={item.reportedChanges} timeZone={timeZone} />}
    {item.reportedMode === "estimate" && item.reportedMinutes !== null && <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><p className="min-w-48 flex-1">{item.reportedEstimate?.reason}</p><Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => void save({ reportedMinutes: item.reportedMinutes })}>Confirm reported</Button></div>}
    <div className="mt-3 flex flex-wrap items-center gap-2"><Button size="sm" variant="ghost" onClick={() => setDetails(!details)} aria-expanded={details}>Details</Button>{(dirty || busy || saved) && <span role="status" className="mr-auto text-xs text-muted-foreground">{busy ? "Saving…" : error ? "Not saved" : dirty ? "Waiting to save…" : "Saved"}</span>}{dirty && error && <><Button size="sm" variant="ghost" disabled={busy} onClick={discard}>Discard edit</Button><Button size="sm" disabled={busy} onClick={() => void save()}>Retry save</Button></>}{item.removed ? <Button size="sm" variant="outline" disabled={busy && !flight.current} onClick={() => void save({ removed: false })}>Restore to day</Button> : <Button size="sm" variant="ghost" disabled={busy && !flight.current} onClick={() => void save({ removed: true })}>Remove from day</Button>}</div>
    <ErrorText error={error} />
    {dirty && error && item.revision !== baseRevision && <div className="mt-2 rounded-lg bg-muted/40 p-3 text-xs"><p>Currently saved: planned {formatMinutes(item.plannedMinutes)}, reported {formatMinutes(item.reportedMinutes)}.</p><Button className="mt-2" size="sm" variant="outline" onClick={() => void save({}, true)}>Apply my edit</Button></div>}
    {details && <div className="mt-3 space-y-3 border-t border-border pt-3">
      <label className="block text-xs text-muted-foreground">{item.calendar ? "Meeting note" : "What to do on this day"}<textarea className="mt-1 min-h-16 w-full rounded-lg border border-input bg-transparent p-2 text-sm text-foreground" value={draft.step} onFocus={() => { focusedField.current = "step"; }} onBlur={() => { focusedField.current = null; if (!error) void save(); }} onChange={e => edit("step", e.target.value)} /></label>
      {item.kind === "task" && !item.removed && <div className="flex flex-wrap items-center gap-2"><Input type="date" aria-label={`Continuation date: ${item.title}`} className="w-40" value={carryDate} onChange={e => setCarryDate(e.target.value)} /><Button variant="outline" size="sm" disabled={busy || item.state === "carried"} onClick={() => void carry()}>Continue on another day</Button></div>}
      {item.calendar && <label className="block text-xs text-muted-foreground">Reported date<Input type="date" className="mt-1 w-40" aria-label={`Reported date: ${item.title}`} value={draft.reportedDate} onFocus={() => { focusedField.current = "reportedDate"; }} onBlur={() => { focusedField.current = null; if (!error) void save(); }} onChange={e => edit("reportedDate", e.target.value)} /></label>}
      {item.calendar && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy && !flight.current} onClick={() => void save({ reportedMinutes: 0 })}>Did not attend</Button>{item.plannedMode === "manual" && <Button size="sm" variant="ghost" disabled={busy || dirty} onClick={() => void save({ restoreAuto: "planned" })}>Planned from calendar</Button>}{item.reportedMode === "manual" && <Button size="sm" variant="ghost" disabled={busy || dirty} onClick={() => void save({ restoreAuto: "reported" })}>Automatic reported time</Button>}</div>}
      {item.taskId && item.reportedMode !== "estimate" && (item.reportedLocked || item.reportedMinutes !== null) && (item.actualMinutes ?? 0) > 0 && <Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => void save({ restoreAuto: "reported" })}>Request AI estimate</Button>}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" onClick={() => setHistory(!history)} aria-expanded={history}>Edit history</Button></div>
      {history && <ItemHistory id={item.id} />}
    </div>}
  </article>;
}

export function DayPage({ date, report = false, period = "week", threadId, focusTaskId }: { date: string; report?: boolean; period?: "day" | "week"; threadId?: string; focusTaskId?: string }) {
  const timeZone = usePlanningTimeZone();
  const rpc = useUxRpc(), navigate = useBbNavigate();
  const load = useCallback(async () => {
    const [day, tasks, time] = await Promise.all([rpc.call("day", { date }), report ? Promise.resolve(null) : rpc.call("list", { history: true }), report ? rpc.call("timeReport", { date, period }) : Promise.resolve(null)]);
    return { day, tasks: tasks?.tasks ?? [], time };
  }, [rpc, date, report, period]);
  const { data, error, refresh } = useDaySnapshot(load);
  const [mutationError, setMutationError] = useState<string | null>(null), [busy, setBusy] = useState(false), [taskId, setTaskId] = useState(focusTaskId ?? "");
  const [showClosed, setShowClosed] = useState(false), [query, setQuery] = useState("");
  const [removedDate, setRemovedDate] = useState<string | null>(null);
  const showRemoved = removedDate === date;
  const flushers = useRef(new Map<string, Flush>());
  const chatFlight = useRef(false), mounted = useRef(true);
  const chatRequests = useRef(new Map<string, string>());
  const [openingChat, setOpeningChat] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const register = useCallback((id: string, flush: Flush | null) => { if (flush) flushers.current.set(id, flush); else flushers.current.delete(id); }, []);
  const route = report ? `report/${period}/${date}` : taskDayPath(date, focusTaskId);
  async function flushAll() { for (const flush of [...flushers.current.values()]) if (!await flush()) return false; return true; }
  useNavigationGuard(() => chatFlight.current ? Promise.resolve(false) : flushAll());
  async function go(path: string) {
    if (chatFlight.current) return;
    const target = focusTaskId && /^day\/\d{4}-\d{2}-\d{2}$/.test(path) ? `${path}/task/${focusTaskId}` : path;
    if (await flushAll()) navigate.toPluginPanel("desk", { subPath: withThread(target, threadId) });
  }
  async function openTask(id: string) { await go(`${id}/from/${route}`); }
  async function openDay(next: string) { if (dayDateSchema.safeParse(next).success) await go(taskDayPath(next, focusTaskId)); }
  async function openChat(id: string, existing: boolean) {
    if (chatFlight.current) return;
    const finish = beginUxAction(existing ? "chat-open" : "chat-new");
    chatFlight.current = true; setOpeningChat(true); setMutationError(null);
    try {
      if (!await flushAll() || !mounted.current) { finish("error"); return; }
      const requestId = chatRequests.current.get(id) ?? crypto.randomUUID(); chatRequests.current.set(id, requestId);
      const session = await rpc.call("openChat", { taskId: id, requestId });
      if (!session.workerThreadId) throw new Error(session.error || "The chat is still starting. Try again.");
      if (!await flushAll() || !mounted.current) { finish("error"); return; }
      navigate.toThread(session.workerThreadId); finish("ok");
    } catch (cause) { finish("error"); if (mounted.current) setMutationError(cause instanceof Error ? cause.message : "Could not open the work chat. Try again."); }
    finally { chatFlight.current = false; if (mounted.current) setOpeningChat(false); }
  }
  async function action(work: () => Promise<unknown>) {
    if (busy || !await flushAll()) return;
    setBusy(true); setMutationError(null);
    try { await work(); await refresh(); }
    catch (e) { setMutationError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const choices = data?.tasks.filter(task => (showClosed || isLiveTask(task.status) || task.id === focusTaskId) && !data.day.items.some(i => i.taskId === task.id && !i.reportOnly) && task.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  const chosenTaskId = choices.some(task => task.id === taskId) ? taskId : choices[0]?.id ?? "";
  const totals = data?.time?.totals ?? data?.day.totals;
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-6xl space-y-4 p-4 md:p-5">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-xl font-medium">{report ? "Time report" : "Day"}</h1><p className="mt-1 text-sm text-muted-foreground">{report ? "Planned, actual and reported time are totaled separately." : "Plan the day, see agent time, and review time to report."}</p></div><div className="flex gap-2"><Button variant={report ? "outline" : "default"} onClick={() => void go(`day/${date}`)}>Day</Button><Button variant={report ? "default" : "outline"} onClick={() => void go(`report/${period}/${date}`)}>Report</Button></div></div>
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Button size="icon" variant="outline" aria-label="Previous day" onClick={() => void go(report ? `report/${period}/${shiftDay(date, -1)}` : `day/${shiftDay(date, -1)}`)}><Icon name="ChevronLeft" /></Button><Input type="date" aria-label="Plan date" value={date} className="w-40" onChange={e => { if (dayDateSchema.safeParse(e.target.value).success) void go(report ? `report/${period}/${e.target.value}` : `day/${e.target.value}`); }} /><Button size="icon" variant="outline" aria-label="Next day" onClick={() => void go(report ? `report/${period}/${shiftDay(date, 1)}` : `day/${shiftDay(date, 1)}`)}><Icon name="ChevronRight" /></Button><Button variant="ghost" size="sm" aria-label="Go to today" onClick={() => void go(report ? `report/${period}/${localDay(new Date(), timeZone)}` : `day/${localDay(new Date(), timeZone)}`)}>Today</Button></div>{report && <div className="flex gap-2"><Button size="sm" variant={period === "day" ? "default" : "outline"} onClick={() => void go(`report/day/${date}`)}>By day</Button><Button size="sm" variant={period === "week" ? "default" : "outline"} onClick={() => void go(`report/week/${date}`)}>By week</Button></div>}</div>
    <ErrorText error={mutationError ?? error} />
    {totals && <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg border border-border bg-card px-4 py-2"><div className="flex items-baseline gap-2"><p className="text-xs text-muted-foreground">Planned time</p><p className="text-base font-medium tabular-nums">{formatMinutes(totals.plannedMinutes)}</p></div><div className="flex items-baseline gap-2"><p className="text-xs text-muted-foreground">Actual time</p><p className="text-base font-medium tabular-nums">{formatMinutes(totals.actualMinutes)}</p></div><div className="flex items-baseline gap-2"><p className="text-xs text-muted-foreground">Reported time</p><p className="text-base font-medium tabular-nums">{formatMinutes(totals.reportedMinutes)}</p></div></div>}
    {!!totals?.estimatedReported && <p role="status" className="rounded-lg bg-muted/40 p-3 text-sm">Reported time includes {totals.estimatedReported} automatic estimate(s). Review them before using this work report.</p>}

    {!data && !error && <p role="status" className="text-sm text-muted-foreground">Opening the saved day…</p>}
    {data && !report && <>
      <section className="overflow-hidden rounded-xl border border-border bg-card"><div className="flex flex-wrap items-center justify-between gap-3 p-4"><h2 className="font-medium">Tasks and meetings</h2><div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><span>Reported: longest first</span><span>{data.day.items.filter(i => !i.removed).length} records</span>{data.day.items.some(i => i.removed) && <label className="flex items-center gap-2"><input type="checkbox" checked={showRemoved} onChange={e => setRemovedDate(e.target.checked ? date : null)} /> Show removed ({data.day.items.filter(i => i.removed).length})</label>}</div></div>
        {/* Keep hidden rows mounted so an in-flight save retains its draft and navigation guard. */}
        {sortDayItems(data.day.items).map(item => <DayRow key={item.id} item={item} hidden={item.removed && !showRemoved} focused={item.taskId === focusTaskId && (!item.removed || showRemoved)} refresh={refresh} register={register} openTask={openTask} openDay={openDay} openChat={openChat} hasActiveChat={Boolean(data.tasks.find(t => t.id === item.taskId)?.activeSession)} chatBusy={openingChat} />)}
        {!data.day.items.some(i => !i.removed) && <p className="border-t border-border p-7 text-center text-sm text-muted-foreground">The plan is empty. Add tasks or check the calendar.</p>}
        <form className="space-y-3 border-t border-border p-4" onSubmit={e => { e.preventDefault(); const chosen = chosenTaskId; if (chosen && choices.some(t => t.id === chosen)) void action(async () => { await rpc.call("dayAdd", { date, taskId: chosen, requestId: crypto.randomUUID() }); setTaskId(""); }); }}><div className="flex flex-wrap gap-2"><Input value={query} onChange={e => { setQuery(e.target.value); setTaskId(""); }} aria-label="Find a task for this day" placeholder="Find a task for this day" className="min-w-48 flex-1" /><label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={showClosed} onChange={e => { setShowClosed(e.target.checked); setTaskId(""); }} /> Include closed tasks</label></div><div className="flex flex-wrap gap-2"><select className="min-w-48 flex-1 rounded-lg border border-input bg-background p-2 text-sm" aria-label="Task to plan" value={chosenTaskId} onChange={e => setTaskId(e.target.value)} disabled={!choices.length || busy}>{choices.length ? choices.map(task => <option key={task.id} value={task.id}>{task.title}</option>) : <option value="">No matching tasks</option>}</select><Button type="submit" variant="outline" disabled={busy || !choices.length}>Add to day</Button></div></form>
      </section>
      <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">Planning, calendar and time details</summary><div className="mt-4 space-y-4">
    {!report && <DayPlannerControl key={date} date={date} beforeStart={flushAll} refreshDay={refresh} />}
      <DayParameters config={data.day.config} register={register} refresh={refresh} planned={data.day.totals.plannedMinutes} />
    {data && <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><p>Actual sums completed agent runs, excluding recorded approval and question waits. Parallel agents add together; meetings equal reported.{data.day.agentTime?.checkedAt ? ` Checked ${eventTime(data.day.agentTime.checkedAt, timeZone)} · tracking since ${data.day.agentTime.from}.` : ""}</p><Button size="sm" variant="outline" disabled={busy || data.day.agentTime?.running} onClick={() => void action(() => rpc.call("agentTimeSync", {}))}>Refresh agent time</Button>{data.day.agentTime?.errors.length ? <p role="alert" className="w-full whitespace-pre-wrap text-destructive">Some measurements could not be refreshed. Saved time is preserved. {data.day.agentTime.errors.join("\n")}</p> : null}</div>}
      <p className="text-xs leading-relaxed text-muted-foreground">Planned time stays as entered. Actual counts agent runtime and excludes your reading, checking and other work. Completed agent work outside the plan is added with planned = 0. AI proposes reported minutes from the volume and type of work, including reading and checking. Estimates need your review. Manual reported time is independent and preserved. A blank field means unspecified time; 0 means an explicit zero minutes. The checkbox marks the daily step. Entry edits save automatically after a short pause, when leaving the field, or when pressing Enter.</p>
      <CalendarStatus date={date} />
      </div></details>
    </>}
    {data?.time && <section className="overflow-hidden rounded-xl border border-border bg-card"><h2 className="p-4 text-sm font-medium">{shortDate(data.time.from)} — {shortDate(data.time.through)}</h2><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-muted/30 text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">Task / meeting</th><th className="px-4 py-3 text-right font-medium">Planned</th><th className="px-4 py-3 text-right font-medium">Actual</th><th className="px-4 py-3 text-right font-medium">Reported</th></tr></thead><tbody>{data.time.rows.map(row => <tr key={row.key} className="border-t border-border"><td className="px-4 py-3">{row.taskId ? <button className="text-left font-medium underline-offset-4 hover:text-primary hover:underline" onClick={() => void openTask(row.taskId!)}>{row.title}</button> : <span className="font-medium">{row.title}</span>}<div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{row.days.map(day => <button key={`${day.itemId}:${day.date}`} className="text-xs text-muted-foreground hover:text-primary hover:underline" onClick={() => void openDay(day.date)}>{shortDate(day.date)} · actual {formatMinutes(day.actualMinutes)} · reported {formatMinutes(day.reportedMinutes)}{day.estimatedReported ? " (estimate)" : ""}</button>)}</div></td><td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{formatMinutes(row.plannedMinutes)}</td><td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{formatMinutes(row.actualMinutes)}</td><td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{formatMinutes(row.reportedMinutes)}{row.estimatedReported && <span className="block text-xs text-muted-foreground">includes estimate</span>}</td></tr>)}</tbody><tfoot className="border-t border-border font-medium"><tr><td className="px-4 py-3">Total</td><td className="px-4 py-3 text-right tabular-nums">{formatMinutes(data.time.totals.plannedMinutes)}</td><td className="px-4 py-3 text-right tabular-nums">{formatMinutes(data.time.totals.actualMinutes)}</td><td className="px-4 py-3 text-right tabular-nums">{formatMinutes(data.time.totals.reportedMinutes)}</td></tr></tfoot></table></div>{!data.time.rows.length && <p className="px-4 pb-5 text-sm text-muted-foreground">No time has been entered for this period yet.</p>}<p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{data.time.totals.missingReported ? `Without reported time: ${data.time.totals.missingReported}. ` : ""}Click a date to open that day and edit an entry. Timezone: {data.time.timeZone}.</p></section>}
  </div></div>;
}

function DayParameters({ config, register, refresh, planned }: { config: DayView["config"]; register: (id: string, flush: Flush | null) => void; refresh: () => Promise<void>; planned: number }) {
  const rpc = useUxRpc();
  const [draft, setDraft] = useState({ capacity: inputTime(config.capacityMinutes), note: config.note });
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false), [error, setError] = useState<string | null>(null);
  const pending = useRef({ draft, dirty: false, revision: config.revision });
  const focusedField = useRef<keyof typeof draft | null>(null);
  const flight = useRef<Promise<boolean> | null>(null), retry = useRef<{ key: string; id: string } | null>(null);
  useLayoutEffect(() => {
    if (!pending.current.dirty && !flight.current && config.revision >= pending.current.revision) {
      const next = { capacity: inputTime(config.capacityMinutes), note: config.note };
      if (focusedField.current && config.revision === pending.current.revision) next[focusedField.current] = pending.current.draft[focusedField.current];
      pending.current = { draft: next, dirty: false, revision: config.revision }; setDraft(next);
    }
  }, [config.revision, config.capacityMinutes, config.note, dirty, busy]);
  function change(field: keyof typeof draft, value: string) {
    pending.current = { ...pending.current, draft: { ...pending.current.draft, [field]: value }, dirty: true };
    setDraft(pending.current.draft); setDirty(true); setError(null); setSaved(false);
  }
  function save(): Promise<boolean> {
    if (flight.current) return flight.current;
    if (!pending.current.dirty) return Promise.resolve(true);
    flight.current = Promise.resolve().then(async () => {
      setBusy(true); setError(null);
      try {
        do {
          const snapshot = pending.current;
          const body = { date: config.date, revision: snapshot.revision, capacityMinutes: parseMinutes(snapshot.draft.capacity), note: snapshot.draft.note };
          const key = JSON.stringify(body);
          if (retry.current?.key !== key) retry.current = { key, id: crypto.randomUUID() };
          const result = await rpc.call("dayConfig", { ...body, requestId: retry.current.id });
          const changed = pending.current.draft !== snapshot.draft;
          const next = changed ? pending.current.draft : { capacity: inputTime(result.capacityMinutes), note: result.note };
          if (focusedField.current) next[focusedField.current] = pending.current.draft[focusedField.current];
          pending.current = { draft: next, dirty: changed, revision: result.revision };
          setDraft(next); setDirty(changed); retry.current = null;
          await refresh();
        } while (pending.current.dirty);
        setSaved(true); return true;
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); await refresh(); return false; }
      finally { flight.current = null; setBusy(false); }
    }); return flight.current;
  }
  const saveLatest = useRef(save);
  useLayoutEffect(() => { saveLatest.current = save; });
  useEffect(() => {
    if (!dirty || busy || error) return;
    const timer = setTimeout(() => void saveLatest.current(), 600);
    return () => clearTimeout(timer);
  }, [draft, dirty, busy, error]);
  useEffect(() => { register("config", () => saveLatest.current()); return () => register("config", null); }, [register]);
  return <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm">Day settings{config.capacityMinutes !== null ? ` · available ${formatMinutes(config.capacityMinutes)} · ${planned <= config.capacityMinutes ? `free ${formatMinutes(config.capacityMinutes - planned)}` : `over capacity by ${formatMinutes(planned - config.capacityMinutes)}`}` : ""}</summary><div className="mt-3 space-y-3"><label className="block text-xs text-muted-foreground">How much time is available?<Input className="mt-1 max-w-48" value={draft.capacity} aria-label="Available time" placeholder="For example, 5h" onChange={e => change("capacity", e.target.value)} onFocus={() => { focusedField.current = "capacity"; }} onBlur={() => { focusedField.current = null; if (!error) void save(); }} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void save(); } }} /></label><label className="block text-xs text-muted-foreground">Day note<textarea className="mt-1 min-h-16 w-full rounded-lg border border-input bg-transparent p-2 text-sm text-foreground" value={draft.note} onChange={e => change("note", e.target.value)} onFocus={() => { focusedField.current = "note"; }} onBlur={() => { focusedField.current = null; if (!error) void save(); }} /></label><ErrorText error={error} />{(dirty || busy || saved) && <p role="status" className="text-xs text-muted-foreground">{busy ? "Saving…" : error ? "Not saved" : dirty ? "Waiting to save…" : "Saved"}</p>}{dirty && error && <div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => void save()}>Retry save</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => { pending.current.dirty = false; retry.current = null; setDirty(false); setError(null); setSaved(false); }}>Discard edit</Button></div>}</div></details>;
}

export function TaskTimeSummary({ taskId, threadId, initialDate }: { taskId: string; threadId?: string; initialDate?: string }) {
  const timeZone = usePlanningTimeZone();
  const rpc = useUxRpc(), navigate = useBbNavigate();
  const read = useCallback(() => rpc.call("taskTime", { taskId }), [rpc, taskId]);
  const { data, error } = useDaySnapshot(read);
  const [date, setDate] = useState(initialDate && dayDateSchema.safeParse(initialDate).success ? initialDate : localDay(new Date(), timeZone)), [busy, setBusy] = useState(false), [mutationError, setMutationError] = useState<string | null>(null);
  async function plan() {
    if (busy) return;
    setBusy(true); setMutationError(null);
    try { dayDateSchema.parse(date); const day = await rpc.call("day", { date }); if (!day.items.some(i => i.taskId === taskId)) await rpc.call("dayAdd", { date, taskId, plannedMinutes: 0, requestId: crypto.randomUUID() }); navigate.toPluginPanel("desk", { subPath: taskDayPath(date, taskId, threadId) }); }
    catch (e) { setMutationError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section aria-label="Task time" className="rounded-xl border border-border p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-medium">Time across all days</h2><p className="mt-1 text-sm tabular-nums">Planned: {data ? formatMinutes(data.plannedMinutes) : "…"} · Actual: {data ? formatMinutes(data.actualMinutes) : "…"} · Reported: {data ? formatMinutes(data.reportedMinutes) : "…"}{data?.estimatedReported ? " (includes estimates)" : ""}</p></div><div className="flex flex-wrap gap-2"><Input type="date" aria-label="Schedule task for a date" className="w-40" value={date} onChange={e => setDate(e.target.value)} /><Button variant="outline" size="sm" disabled={busy} onClick={() => void plan()}><Icon name="Clock" />Log time</Button></div></div><ErrorText error={mutationError ?? error} /></section>;
}
