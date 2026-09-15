import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc, useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contracts.js";
import { dayDateSchema, dayRpcContract, formatMinutes, localDay, parseMinutes, shiftDay, DAY_TIME_ZONE, type DayItem, type DayView } from "./day-contracts.js";
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
const eventTime = (at: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: DAY_TIME_ZONE }).format(new Date(at));
const inputTime = (minutes: number | null) => minutes === null ? "" : formatMinutes(minutes);
type ViewItem = DayView["items"][number];
type Patch = Omit<z.input<typeof dayRpcContract.dayEdit.input>, "id" | "revision" | "requestId">;
type Flush = () => Promise<boolean>;

function DayPlannerControl({ date, beforeStart, refreshDay }: { date: string; beforeStart: Flush; refreshDay: () => Promise<void> }) {
  const rpc = useRpc<typeof rpcContract>();
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
  const at = (time: number) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: DAY_TIME_ZONE }).format(new Date(time));
  return <section aria-label="Day planning" className="rounded-xl border border-border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-medium">Day planning</h2><p className="mt-1 text-xs text-muted-foreground">{data?.name ?? "Day planner"}{data?.scheduled && data.nextRunAt ? ` · next ${at(data.nextRunAt)}` : data?.configured ? " · schedule paused" : ""}</p></div><Button disabled={busy || running || !!error || !data?.configured || date !== data.today} onClick={() => void start()}><Icon name="Zap" />{busy ? "Starting…" : running ? "Creating plan…" : "Create day plan"}</Button></div>
    {date !== data?.today && data && <p className="mt-2 text-xs text-muted-foreground">Open Today to create a day plan.</p>}
    {run && <p role="status" className="mt-2 text-xs text-muted-foreground">{running ? "Creating today's plan. Saved tasks will appear here automatically." : run.status === "succeeded" ? `Day planning finished · ${at(run.finishedAt ?? run.startedAt)}` : run.status === "skipped" ? `Run skipped${run.skipReason ? `: ${run.skipReason}` : "."}` : `Day planning failed · ${at(run.finishedAt ?? run.startedAt)}`}</p>}
    <ErrorText error={mutationError ?? error ?? (run?.status === "failed" ? run.error : null)} />
  </section>;
}

export function CalendarStatus({ date }: { date?: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const read = useCallback(() => rpc.call("calendarState", {}), [rpc]);
  const { data, error, refresh } = useDaySnapshot(read);
  const [busy, setBusy] = useState(false), [mutationError, setMutationError] = useState<string | null>(null);
  async function sync() {
    if (busy) return; setBusy(true); setMutationError(null);
    try { await rpc.call("calendarSync", { date }); await refresh(); }
    catch (e) { setMutationError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section aria-label="Work calendar" className="rounded-xl border border-border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-medium">Work calendar</h2><p className="mt-1 text-xs text-muted-foreground">{data?.status === "running" ? "Loading meetings…" : data?.status === "complete" ? `Meetings: ${data.events} · checked ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: DAY_TIME_ZONE }).format(new Date(data.completedAt!))}` : "Calendar from 247C settings"}{data?.from && data.through ? ` · ${shortDate(data.from)} — ${shortDate(data.through)}` : ""}</p></div><Button variant="outline" size="sm" disabled={busy || data?.status === "running"} onClick={() => void sync()}>Check calendar</Button></div>
    <p className="mt-2 text-xs text-muted-foreground">Meetings also update when checking email, Slack and Jira. Manual time edits are preserved.</p>
    <ErrorText error={mutationError ?? error ?? (data?.status === "error" ? data.message : null)} />
    {data?.status === "idle" && data.message && <p className="mt-2 text-xs text-muted-foreground">{data.message}</p>}
  </section>;
}

function ItemHistory({ id }: { id: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [offset, setOffset] = useState(0);
  const read = useCallback(() => rpc.call("dayHistory", { id, offset }), [rpc, id, offset]);
  const { data, error } = useDaySnapshot(read);
  return <div className="space-y-3"><ErrorText error={error} />{data?.items.map(event => <div key={event.sequence} className="rounded-lg bg-muted/40 p-3 text-xs"><div className="flex flex-wrap justify-between gap-2 text-muted-foreground"><span>{new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "short", timeZone: DAY_TIME_ZONE }).format(new Date(event.at))}</span><span>{event.actor.startsWith("agent-time:") ? "Agent time / estimate" : event.actor.startsWith("calendar:") ? "Calendar" : event.actor.startsWith("bb-thread:") ? "From conversation" : "Manual"}</span></div><p className="mt-2">Planned: {formatMinutes(event.before?.plannedMinutes ?? null)} → {formatMinutes(event.after.plannedMinutes)} · Actual: {formatMinutes(event.before?.actualMinutes ?? null)} → {formatMinutes(event.after.actualMinutes)} · Reported: {formatMinutes(event.before?.reportedMinutes ?? null)} → {formatMinutes(event.after.reportedMinutes)}</p>{event.after.reportedMode === "estimate" && <p className="mt-1">Estimate: {event.after.reportedEstimate?.reason}</p>}{event.before?.date !== event.after.date && <p className="mt-1">Date: {event.before?.date ?? "—"} → {event.after.date}</p>}{event.after.carriedTo && <p className="mt-1">Continuation: {event.after.carriedTo}</p>}{event.before?.step !== event.after.step && event.after.step && <p className="mt-1 whitespace-pre-wrap">{event.after.step}</p>}{event.before?.removed !== event.after.removed && event.after.removed && <p className="mt-1">Removed from the plan; reported time preserved.</p>}</div>)}{data && (offset > 0 || data.nextOffset !== null) && <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Newer</Button><Button size="sm" variant="ghost" disabled={data.nextOffset === null} onClick={() => setOffset(data.nextOffset!)}>Older</Button></div>}</div>;
}

function DayRow({ item, refresh, register, openTask, openDay, move, moveDisabled, focused = false }: {
  item: ViewItem; refresh: () => Promise<void>; register: (id: string, flush: Flush | null) => void;
  openTask: (id: string) => Promise<void>; openDay: (date: string) => Promise<void>; move: (id: string, direction: number) => Promise<void>; moveDisabled: boolean; focused?: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
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
  useEffect(() => { if (!dirty) { setDraft({ planned: inputTime(item.plannedMinutes), reported: inputTime(item.reportedMinutes), step: item.step, reportedDate: item.reportedDate }); setBaseRevision(item.revision); } }, [item.revision, item.plannedMinutes, item.reportedMinutes, item.step, item.reportedDate, dirty]);
  function edit(field: keyof typeof draft, value: string) {
    if (!dirty) setBaseRevision(item.revision);
    setDraft(previous => ({ ...previous, [field]: value })); setFields(previous => new Set([...previous, field])); setError(null);
  }
  function save(extra: Patch = {}, overwrite = false): Promise<boolean> {
    if (flight.current) return flight.current;
    if (!dirty && Object.keys(extra).length === 0) return Promise.resolve(true);
    const run = async () => {
      setBusy(true); setError(null);
      try {
        const patch: Patch = {};
        if (!extra.restoreAuto) {
          if (fields.has("planned")) patch.plannedMinutes = parseMinutes(draft.planned);
          if (fields.has("reported")) patch.reportedMinutes = parseMinutes(draft.reported);
          if (fields.has("step")) patch.step = draft.step;
          if (fields.has("reportedDate")) patch.reportedDate = dayDateSchema.parse(draft.reportedDate);
        }
        const body = { id: item.id, revision: overwrite || !dirty ? item.revision : baseRevision, ...patch, ...extra };
        const key = JSON.stringify(body);
        if (retry.current?.key !== key) retry.current = { key, id: crypto.randomUUID() };
        const result = await rpc.call("dayEdit", { ...body, requestId: retry.current.id });
        setFields(new Set()); setBaseRevision(result.revision); setDraft({ planned: inputTime(result.plannedMinutes), reported: inputTime(result.reportedMinutes), step: result.step, reportedDate: result.reportedDate }); retry.current = null;
        await refresh(); return true;
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); await refresh(); return false; }
      finally { setBusy(false); flight.current = null; }
    };
    flight.current = run(); return flight.current;
  }
  useEffect(() => { register(item.id, () => save()); return () => register(item.id, null); });
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
  return <article ref={row} aria-label={`Day entry: ${item.title}`} className={cn("border-t border-border p-4", focused && "bg-primary/5", inactive && "bg-muted/20")}>
    <div className="grid grid-cols-3 items-start gap-3 md:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_6.5rem]">
      <div className="col-span-3 flex min-w-0 items-start gap-3 md:col-span-1">
        {item.kind === "task" ? <input type="checkbox" className="mt-1 size-4 shrink-0 accent-current" aria-label={`Step completed: ${item.title}`} checked={item.state === "done"} disabled={busy || inactive || item.state === "carried"} onChange={e => void save({ state: e.target.checked ? "done" : "open" })} /> : <span aria-label="Calendar meeting" className="mt-0.5 text-primary">▦</span>}
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2">{item.taskId ? <button type="button" className={cn("break-words text-left text-sm font-medium underline-offset-4 hover:text-primary hover:underline", inactive && "text-muted-foreground")} onClick={() => void openTask(item.taskId!)}>{item.title}</button> : item.calendar?.url ? <a href={item.calendar.url} target="_blank" rel="noreferrer" className="break-words text-sm font-medium underline-offset-4 hover:underline">{item.title}</a> : <h3 className="break-words text-sm font-medium">{item.title}</h3>}{item.taskStatus && item.taskStatus !== "open" && <span className="text-xs text-muted-foreground">Task {item.taskStatus === "done" ? "closed" : "archived"}</span>}</div>
          {item.calendar ? <p className="mt-1 text-xs text-muted-foreground">{shortDate(item.date)} · {eventTime(item.calendar.startAt)}–{eventTime(item.calendar.endAt)} · {item.calendar.status === "cancelled" ? "canceled" : item.calendar.status === "declined" ? "invitation declined" : item.calendar.status === "excluded" ? "excluded from meeting time" : "from calendar"}</p> : item.step && <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{item.step}</p>}
          {item.carriedTo && <button className="mt-1 text-xs text-primary hover:underline" onClick={() => void openDay(item.carriedTo!)}>Continuation {shortDate(item.carriedTo)}</button>}
          {item.reportOnly && <p className="mt-1 text-xs text-muted-foreground">Reported time is saved here. The meeting is planned for {shortDate(item.date)}.</p>}
          {item.removed && <p className="mt-1 text-xs text-muted-foreground">Removed from the plan; reported time preserved.</p>}
          {!item.calendar && item.plannedMinutes === null && item.reportedMinutes !== null && <p className="mt-1 text-xs text-muted-foreground">Outside the plan</p>}
        </div>
      </div>
      <label className="text-xs text-muted-foreground">Planned<Input aria-label={`Planned: ${item.title}`} className="mt-1 text-right tabular-nums" value={draft.planned} placeholder="—" disabled={busy} onChange={e => edit("planned", e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void save(); } }} />{item.calendar && <span className="mt-1 block text-right text-xs">{item.plannedMode === "calendar" ? "calendar" : "manual"}</span>}</label>
      <div className="text-xs text-muted-foreground">Actual<output aria-label={`Actual: ${item.title}`} className="mt-1 flex h-9 items-center justify-end rounded-md border border-transparent px-3 text-sm tabular-nums text-foreground">{formatMinutes(item.actualMinutes)}</output><span className="mt-1 block text-right text-xs">{item.kind === "meeting" ? "= reported" : "agents"}</span></div>
      <label className="text-xs text-muted-foreground">Reported<Input ref={reportedInput} aria-label={`Reported: ${item.title}`} className="mt-1 text-right tabular-nums" value={draft.reported} placeholder="—" disabled={busy} onChange={e => edit("reported", e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void save(); } }} />{item.calendar && <span className="mt-1 block text-right text-xs">{item.reportedMode === "calendar" ? item.reportedMinutes === null ? "after the meeting" : "auto" : "manual"}</span>}{!item.calendar && <span className="mt-1 block text-right text-xs">{item.reportedMode === "estimate" && item.reportedMinutes !== null ? "estimate · review" : item.reportedMinutes !== null || item.reportedLocked ? "manual" : (item.actualMinutes ?? 0) > 0 ? "awaiting AI estimate" : ""}</span>}</label>
    </div>
    {item.reportedMode === "estimate" && item.reportedMinutes !== null && <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><p className="min-w-48 flex-1">{item.reportedEstimate?.reason}</p><Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => void save({ reportedMinutes: item.reportedMinutes })}>Confirm reported</Button></div>}
    <div className="mt-3 flex flex-wrap items-center gap-2"><Button size="sm" variant="ghost" onClick={() => setDetails(!details)} aria-expanded={details}>Details</Button>{dirty && <><span className="mr-auto text-xs text-muted-foreground">Unsaved edit</span><Button size="sm" variant="ghost" disabled={busy} onClick={() => { setFields(new Set()); setError(null); }}>Discard edit</Button><Button size="sm" disabled={busy} onClick={() => void save()}>Save time</Button></>}{item.removed && <Button size="sm" variant="outline" disabled={busy} onClick={() => void save({ removed: false })}>Restore to plan</Button>}</div>
    <ErrorText error={error} />
    {dirty && error && item.revision !== baseRevision && <div className="mt-2 rounded-lg bg-muted/40 p-3 text-xs"><p>Currently saved: planned {formatMinutes(item.plannedMinutes)}, reported {formatMinutes(item.reportedMinutes)}.</p><Button className="mt-2" size="sm" variant="outline" onClick={() => void save({}, true)}>Apply my edit</Button></div>}
    {details && <div className="mt-3 space-y-3 border-t border-border pt-3">
      <label className="block text-xs text-muted-foreground">{item.calendar ? "Meeting note" : "What to do on this day"}<textarea className="mt-1 min-h-16 w-full rounded-lg border border-input bg-transparent p-2 text-sm text-foreground" value={draft.step} disabled={busy} onChange={e => edit("step", e.target.value)} /></label>
      {item.kind === "task" && !item.removed && <div className="flex flex-wrap items-center gap-2"><Input type="date" aria-label={`Continuation date: ${item.title}`} className="w-40" value={carryDate} onChange={e => setCarryDate(e.target.value)} /><Button variant="outline" size="sm" disabled={busy || item.state === "carried"} onClick={() => void carry()}>Continue on another day</Button><Button size="sm" variant="ghost" disabled={busy || moveDisabled} onClick={() => void move(item.id, -1)}>Move up</Button><Button size="sm" variant="ghost" disabled={busy || moveDisabled} onClick={() => void move(item.id, 1)}>Move down</Button></div>}
      {item.calendar && <label className="block text-xs text-muted-foreground">Reported date<Input type="date" className="mt-1 w-40" aria-label={`Reported date: ${item.title}`} value={draft.reportedDate} disabled={busy} onChange={e => edit("reportedDate", e.target.value)} /></label>}
      {item.calendar && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void save({ reportedMinutes: 0 })}>Did not attend</Button>{item.plannedMode === "manual" && <Button size="sm" variant="ghost" disabled={busy || dirty} onClick={() => void save({ restoreAuto: "planned" })}>Planned from calendar</Button>}{item.reportedMode === "manual" && <Button size="sm" variant="ghost" disabled={busy || dirty} onClick={() => void save({ restoreAuto: "reported" })}>Automatic reported time</Button>}</div>}
      {item.taskId && item.reportedMode !== "estimate" && (item.reportedLocked || item.reportedMinutes !== null) && (item.actualMinutes ?? 0) > 0 && <Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => void save({ restoreAuto: "reported" })}>Request AI estimate</Button>}
      <div className="flex flex-wrap gap-2">{!item.removed && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save({ removed: true })}>Remove from plan</Button>}<Button size="sm" variant="ghost" onClick={() => setHistory(!history)} aria-expanded={history}>Edit history</Button></div>
      {history && <ItemHistory id={item.id} />}
    </div>}
  </article>;
}

export function DayPage({ date, report = false, period = "week", threadId, focusTaskId }: { date: string; report?: boolean; period?: "day" | "week"; threadId?: string; focusTaskId?: string }) {
  const rpc = useRpc<typeof rpcContract>(), navigate = useBbNavigate();
  const load = useCallback(async () => {
    const [day, tasks, time] = await Promise.all([rpc.call("day", { date }), report ? Promise.resolve(null) : rpc.call("list", { history: true }), report ? rpc.call("timeReport", { date, period }) : Promise.resolve(null)]);
    return { day, tasks: tasks?.tasks ?? [], time };
  }, [rpc, date, report, period]);
  const { data, error, refresh } = useDaySnapshot(load);
  const [mutationError, setMutationError] = useState<string | null>(null), [busy, setBusy] = useState(false), [taskId, setTaskId] = useState(focusTaskId ?? "");
  const [showClosed, setShowClosed] = useState(false), [query, setQuery] = useState("");
  const flushers = useRef(new Map<string, Flush>());
  const register = useCallback((id: string, flush: Flush | null) => { if (flush) flushers.current.set(id, flush); else flushers.current.delete(id); }, []);
  const route = report ? `report/${period}/${date}` : taskDayPath(date, focusTaskId);
  async function flushAll() { for (const flush of [...flushers.current.values()]) if (!await flush()) return false; return true; }
  useNavigationGuard(flushAll);
  async function go(path: string) {
    const target = focusTaskId && /^day\/\d{4}-\d{2}-\d{2}$/.test(path) ? `${path}/task/${focusTaskId}` : path;
    if (await flushAll()) navigate.toPluginPanel("desk", { subPath: withThread(target, threadId) });
  }
  async function openTask(id: string) { await go(`${id}/from/${route}`); }
  async function openDay(next: string) { if (dayDateSchema.safeParse(next).success) await go(taskDayPath(next, focusTaskId)); }
  async function action(work: () => Promise<unknown>) {
    if (busy || !await flushAll()) return;
    setBusy(true); setMutationError(null);
    try { await work(); await refresh(); }
    catch (e) { setMutationError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function reorder(id: string, direction: number) {
    await action(async () => {
      const current = await rpc.call("day", { date });
      const items = current.items.filter(i => i.kind === "task" && !i.removed);
      const index = items.findIndex(i => i.id === id), target = index + direction;
      if (index < 0 || target < 0 || target >= items.length) return;
      [items[index], items[target]] = [items[target], items[index]];
      await rpc.call("dayReorder", { requestId: crypto.randomUUID(), date, ids: items.map(i => i.id), revisions: Object.fromEntries(items.map(i => [i.id, i.revision])) });
    });
  }
  const choices = data?.tasks.filter(task => (showClosed || task.status === "open" || task.id === focusTaskId) && !data.day.items.some(i => i.taskId === task.id && !i.reportOnly) && task.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  const chosenTaskId = choices.some(task => task.id === taskId) ? taskId : choices[0]?.id ?? "";
  const totals = data?.time?.totals ?? data?.day.totals;
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-6xl space-y-5 p-5 md:p-8">
    <Button variant="ghost" size="sm" className="-ml-3" onClick={() => void go("")}><Icon name="ChevronLeft" /> All tasks</Button>
    <div className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-2xl font-medium">{report ? "Time report" : "Day"}</h1><p className="mt-1 text-sm text-muted-foreground">{report ? "Planned, actual and reported time are totaled separately." : "Plan the day, see agent time, and review time to report."}</p></div><div className="flex gap-2"><Button variant={report ? "outline" : "default"} onClick={() => void go(`day/${date}`)}>Day</Button><Button variant={report ? "default" : "outline"} onClick={() => void go(`report/${period}/${date}`)}>Report</Button></div></div>
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Button size="icon" variant="outline" aria-label="Previous day" onClick={() => void go(report ? `report/${period}/${shiftDay(date, -1)}` : `day/${shiftDay(date, -1)}`)}><Icon name="ChevronLeft" /></Button><Input type="date" aria-label="Plan date" value={date} className="w-40" onChange={e => { if (dayDateSchema.safeParse(e.target.value).success) void go(report ? `report/${period}/${e.target.value}` : `day/${e.target.value}`); }} /><Button size="icon" variant="outline" aria-label="Next day" onClick={() => void go(report ? `report/${period}/${shiftDay(date, 1)}` : `day/${shiftDay(date, 1)}`)}><Icon name="ChevronRight" /></Button><Button variant="ghost" size="sm" onClick={() => void go(report ? `report/${period}/${localDay()}` : `day/${localDay()}`)}>Today</Button></div>{report && <div className="flex gap-2"><Button size="sm" variant={period === "day" ? "default" : "outline"} onClick={() => void go(`report/day/${date}`)}>By day</Button><Button size="sm" variant={period === "week" ? "default" : "outline"} onClick={() => void go(`report/week/${date}`)}>By week</Button></div>}</div>
    <ErrorText error={mutationError ?? error} />
    {!report && <DayPlannerControl key={date} date={date} beforeStart={flushAll} refreshDay={refresh} />}
    {totals && <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><div className="rounded-xl border border-border bg-card p-4"><p className="text-xs text-muted-foreground">Planned time</p><p className="mt-2 text-2xl font-medium tabular-nums">{formatMinutes(totals.plannedMinutes)}</p></div><div className="rounded-xl border border-border bg-card p-4"><p className="text-xs text-muted-foreground">Actual time</p><p className="mt-2 text-2xl font-medium tabular-nums">{formatMinutes(totals.actualMinutes)}</p></div><div className="rounded-xl border border-border bg-card p-4"><p className="text-xs text-muted-foreground">Reported time</p><p className="mt-2 text-2xl font-medium tabular-nums">{formatMinutes(totals.reportedMinutes)}</p></div></div>}
    {!!totals?.estimatedReported && <p role="status" className="rounded-lg bg-muted/40 p-3 text-sm">Reported time includes {totals.estimatedReported} automatic estimate(s). Review them before using this work report.</p>}
    {data && <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><p>Actual sums completed agent runs, excluding recorded approval and question waits. Parallel agents add together; meetings equal reported.{data.day.agentTime?.checkedAt ? ` Checked ${eventTime(data.day.agentTime.checkedAt)} · tracking since ${data.day.agentTime.from}.` : ""}</p><Button size="sm" variant="outline" disabled={busy || data.day.agentTime?.running} onClick={() => void action(() => rpc.call("agentTimeSync", {}))}>Refresh agent time</Button>{data.day.agentTime?.errors.length ? <p role="alert" className="w-full whitespace-pre-wrap text-destructive">Some measurements could not be refreshed. Saved time is preserved. {data.day.agentTime.errors.join("\n")}</p> : null}</div>}
    {!data && !error && <p role="status" className="text-sm text-muted-foreground">Opening the saved day…</p>}
    {data && !report && <>
      <DayParameters config={data.day.config} register={register} refresh={refresh} planned={data.day.totals.plannedMinutes} />
      <section className="overflow-hidden rounded-xl border border-border bg-card"><div className="flex items-center justify-between gap-3 p-4"><h2 className="font-medium">Tasks and meetings</h2><span className="text-xs text-muted-foreground">{data.day.items.filter(i => !i.removed).length} records</span></div>
        {data.day.items.map(item => <DayRow key={item.id} item={item} focused={item.taskId === focusTaskId} refresh={refresh} register={register} openTask={openTask} openDay={openDay} move={reorder} moveDisabled={busy} />)}
        {!data.day.items.length && <p className="border-t border-border p-7 text-center text-sm text-muted-foreground">The plan is empty. Add tasks or check the calendar.</p>}
        <form className="space-y-3 border-t border-border p-4" onSubmit={e => { e.preventDefault(); const chosen = chosenTaskId; if (chosen && choices.some(t => t.id === chosen)) void action(async () => { await rpc.call("dayAdd", { date, taskId: chosen, requestId: crypto.randomUUID() }); setTaskId(""); }); }}><div className="flex flex-wrap gap-2"><Input value={query} onChange={e => { setQuery(e.target.value); setTaskId(""); }} aria-label="Find a task for this day" placeholder="Find a task for this day" className="min-w-48 flex-1" /><label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={showClosed} onChange={e => { setShowClosed(e.target.checked); setTaskId(""); }} /> Include closed tasks</label></div><div className="flex flex-wrap gap-2"><select className="min-w-48 flex-1 rounded-lg border border-input bg-background p-2 text-sm" aria-label="Task to plan" value={chosenTaskId} onChange={e => setTaskId(e.target.value)} disabled={!choices.length || busy}>{choices.length ? choices.map(task => <option key={task.id} value={task.id}>{task.title}</option>) : <option value="">No matching tasks</option>}</select><Button type="submit" variant="outline" disabled={busy || !choices.length}>Add to day</Button></div></form>
      </section>
      <p className="text-xs leading-relaxed text-muted-foreground">Planned time stays as entered. Actual counts agent runtime and excludes your reading, checking and other work. Completed agent work outside the plan is added with planned = 0. AI proposes reported minutes from the volume and type of work, including reading and checking. Estimates need your review. Manual reported time is independent and preserved. A blank field means unspecified time; 0 means an explicit zero minutes. The checkbox marks the daily step. Save edits with the button, Enter, or by opening a task or another day.</p>
      <CalendarStatus date={date} />
    </>}
    {data?.time && <section className="overflow-hidden rounded-xl border border-border bg-card"><h2 className="p-4 text-sm font-medium">{shortDate(data.time.from)} — {shortDate(data.time.through)}</h2><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-muted/30 text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">Task / meeting</th><th className="px-4 py-3 text-right font-medium">Planned</th><th className="px-4 py-3 text-right font-medium">Actual</th><th className="px-4 py-3 text-right font-medium">Reported</th></tr></thead><tbody>{data.time.rows.map(row => <tr key={row.key} className="border-t border-border"><td className="px-4 py-3">{row.taskId ? <button className="text-left font-medium underline-offset-4 hover:text-primary hover:underline" onClick={() => void openTask(row.taskId!)}>{row.title}</button> : <span className="font-medium">{row.title}</span>}<div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{row.days.map(day => <button key={`${day.itemId}:${day.date}`} className="text-xs text-muted-foreground hover:text-primary hover:underline" onClick={() => void openDay(day.date)}>{shortDate(day.date)} · actual {formatMinutes(day.actualMinutes)} · reported {formatMinutes(day.reportedMinutes)}{day.estimatedReported ? " (estimate)" : ""}</button>)}</div></td><td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{formatMinutes(row.plannedMinutes)}</td><td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{formatMinutes(row.actualMinutes)}</td><td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{formatMinutes(row.reportedMinutes)}{row.estimatedReported && <span className="block text-xs text-muted-foreground">includes estimate</span>}</td></tr>)}</tbody><tfoot className="border-t border-border font-medium"><tr><td className="px-4 py-3">Total</td><td className="px-4 py-3 text-right tabular-nums">{formatMinutes(data.time.totals.plannedMinutes)}</td><td className="px-4 py-3 text-right tabular-nums">{formatMinutes(data.time.totals.actualMinutes)}</td><td className="px-4 py-3 text-right tabular-nums">{formatMinutes(data.time.totals.reportedMinutes)}</td></tr></tfoot></table></div>{!data.time.rows.length && <p className="px-4 pb-5 text-sm text-muted-foreground">No time has been entered for this period yet.</p>}<p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{data.time.totals.missingReported ? `Without reported time: ${data.time.totals.missingReported}. ` : ""}Click a date to open that day and edit an entry. Timezone: {DAY_TIME_ZONE}.</p></section>}
  </div></div>;
}

function DayParameters({ config, register, refresh, planned }: { config: DayView["config"]; register: (id: string, flush: Flush | null) => void; refresh: () => Promise<void>; planned: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const [capacity, setCapacity] = useState(inputTime(config.capacityMinutes)), [note, setNote] = useState(config.note), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const revision = useRef(config.revision), flight = useRef<Promise<boolean> | null>(null), request = useRef<string>(crypto.randomUUID());
  useEffect(() => { if (!dirty) { setCapacity(inputTime(config.capacityMinutes)); setNote(config.note); revision.current = config.revision; } }, [config.revision, config.capacityMinutes, config.note, dirty]);
  function change(fn: () => void) { if (!dirty) revision.current = config.revision; request.current = crypto.randomUUID(); fn(); setDirty(true); }
  function save(): Promise<boolean> {
    if (flight.current) return flight.current;
    if (!dirty) return Promise.resolve(true);
    flight.current = Promise.resolve().then(async () => { setBusy(true); setError(null); try { await rpc.call("dayConfig", { ...config, revision: revision.current, capacityMinutes: parseMinutes(capacity), note, requestId: request.current }); setDirty(false); await refresh(); return true; } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); flight.current = null; } }); return flight.current;
  }
  useEffect(() => { register("config", save); return () => register("config", null); });
  return <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm">Day settings{config.capacityMinutes !== null ? ` · available ${formatMinutes(config.capacityMinutes)} · ${planned <= config.capacityMinutes ? `free ${formatMinutes(config.capacityMinutes - planned)}` : `over capacity by ${formatMinutes(planned - config.capacityMinutes)}`}` : ""}</summary><div className="mt-3 space-y-3"><label className="block text-xs text-muted-foreground">How much time is available?<Input className="mt-1 max-w-48" value={capacity} aria-label="Available time" placeholder="For example, 5h" disabled={busy} onChange={e => change(() => setCapacity(e.target.value))} /></label><label className="block text-xs text-muted-foreground">Day note<textarea className="mt-1 min-h-16 w-full rounded-lg border border-input bg-transparent p-2 text-sm text-foreground" value={note} disabled={busy} onChange={e => change(() => setNote(e.target.value))} /></label><ErrorText error={error} />{dirty && <div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => void save()}>Save day</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDirty(false); setError(null); }}>Discard edit</Button></div>}</div></details>;
}

export function TaskTimeSummary({ taskId, threadId, initialDate }: { taskId: string; threadId?: string; initialDate?: string }) {
  const rpc = useRpc<typeof rpcContract>(), navigate = useBbNavigate();
  const read = useCallback(() => rpc.call("taskTime", { taskId }), [rpc, taskId]);
  const { data, error } = useDaySnapshot(read);
  const [date, setDate] = useState(initialDate && dayDateSchema.safeParse(initialDate).success ? initialDate : localDay()), [busy, setBusy] = useState(false), [mutationError, setMutationError] = useState<string | null>(null);
  async function plan() {
    if (busy) return;
    setBusy(true); setMutationError(null);
    try { dayDateSchema.parse(date); const day = await rpc.call("day", { date }); if (!day.items.some(i => i.taskId === taskId)) await rpc.call("dayAdd", { date, taskId, plannedMinutes: 0, requestId: crypto.randomUUID() }); navigate.toPluginPanel("desk", { subPath: taskDayPath(date, taskId, threadId) }); }
    catch (e) { setMutationError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section aria-label="Task time" className="rounded-xl border border-border p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-medium">Time across all days</h2><p className="mt-1 text-sm tabular-nums">Planned: {data ? formatMinutes(data.plannedMinutes) : "…"} · Actual: {data ? formatMinutes(data.actualMinutes) : "…"} · Reported: {data ? formatMinutes(data.reportedMinutes) : "…"}{data?.estimatedReported ? " (includes estimates)" : ""}</p></div><div className="flex flex-wrap gap-2"><Input type="date" aria-label="Schedule task for a date" className="w-40" value={date} onChange={e => setDate(e.target.value)} /><Button variant="outline" size="sm" disabled={busy} onClick={() => void plan()}><Icon name="Clock" />Log time</Button></div></div><ErrorText error={mutationError ?? error} /></section>;
}
