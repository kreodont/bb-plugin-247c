import { randomUUID } from "node:crypto";
import { z } from "zod";
import { digest, Repository } from "./repository.js";
import { reportedChanges, reportedComposition } from "./day-provenance.js";
import { ConflictError, PolicyError } from "./core/errors.js";
import { calendarEventSchema, calendarStateSchema, dayAddSchema, dayConfigSchema, dayDateSchema, dayEditSchema, dayEstimateSchema, dayItemSchema, dayRpcContract,
  DAY_TIME_ZONE, localDay, shiftDay, weekStart, type CalendarEvent, type CalendarState, type DayItem, type DayView, type TimeReport } from "./day-contracts.js";

type JsonRow = { value_json: string };
export const EMPTY_CALENDAR: CalendarState = { status: "idle", startedAt: null, completedAt: null, message: null, events: 0, from: null, through: null };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const plannedCounts = (item: DayItem) => !item.removed && (!item.calendar || item.calendar.status === "confirmed");
const actualDate = (item: DayItem) => item.kind === "meeting" ? item.reportedDate : item.date;
function decode(raw: unknown): DayItem {
  const item = dayItemSchema.parse(raw);
  if (item.kind === "meeting") item.actualMinutes = item.reportedMinutes;
  return item;
}

export class DayPlanning {
  constructor(readonly repo: Repository, readonly clock: () => Date = () => new Date(), readonly configuredTimeZone: () => string = () => DAY_TIME_ZONE,
    readonly reportMeetingsWhenPlanned: () => boolean = () => false) {}
  get timeZone() { return this.configuredTimeZone(); }
  now() { return this.clock().toISOString(); }
  today() { return localDay(this.clock(), this.timeZone); }
  get(id: string): DayItem {
    const row = this.repo.db.prepare("SELECT value_json FROM day_items WHERE id=?").get(id) as JsonRow | undefined;
    if (!row) throw new PolicyError("Day entry not found. Refresh the plan.");
    return decode(JSON.parse(row.value_json));
  }
  private rows(sql: string, ...args: string[]) {
    const rows = this.repo.db.prepare(`SELECT value_json FROM day_items ${sql}`).all(...args) as JsonRow[];
    if (rows.length > 5000) throw new PolicyError("Too many entries for one response. Choose a shorter period or a single task.");
    return rows.map(row => decode(JSON.parse(row.value_json)));
  }
  private write(raw: DayItem, before: DayItem | null, actor: string, action: string): DayItem {
    const next = decode({ ...raw, revision: before ? before.revision + 1 : 0, updatedAt: this.now() });
    this.repo.db.prepare(`INSERT INTO day_items(id,date,reported_date,task_id,calendar_key,value_json) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET date=excluded.date,reported_date=excluded.reported_date,value_json=excluded.value_json`).run(next.id, next.date, next.reportedDate, next.taskId, next.calendar?.key ?? null, JSON.stringify(next));
    this.repo.db.prepare("INSERT INTO day_item_events(item_id,at,actor,action,before_json,after_json) VALUES (?,?,?,?,?,?)")
      .run(next.id, this.now(), actor, action, before ? JSON.stringify(before) : null, JSON.stringify(next));
    if (next.taskId && action !== "agent_time_updated" && action !== "session_reported") this.repo.sessionTime.reconcile(next.taskId);
    return next;
  }
  private current(id: string, revision: number) {
    const item = this.get(id);
    if (item.revision !== revision) throw new ConflictError("The time entry changed in another window. Refresh it and retry your edit.");
    return item;
  }
  private blank(date: string, taskId: string | null, title: string): DayItem {
    const count = this.repo.db.prepare("SELECT count(*) AS n FROM day_items WHERE date=?").get(date) as { n: number };
    if (count.n >= 1000) throw new PolicyError("This day already has 1,000 entries.");
    return { id: randomUUID(), date, reportedDate: date, kind: taskId ? "task" : "meeting", taskId, title, step: "", ordinal: count.n,
      revision: 0, reportedWorkSummary: null, plannedMinutes: null, actualMinutes: null, reportedMinutes: null, plannedMode: "manual", reportedMode: "manual", reportedEstimate: null, reportedLocked: false, state: "open", removed: false,
      carriedTo: null, calendar: null, createdAt: this.now(), updatedAt: this.now() };
  }
  taskItem(taskId: string, date: string): DayItem | null {
    const row = this.repo.db.prepare("SELECT value_json FROM day_items WHERE task_id=? AND date=?").get(taskId, date) as JsonRow | undefined;
    return row ? decode(JSON.parse(row.value_json)) : null;
  }
  // Called inside the normal proposal approval transaction, never by the recorder.
  applySessionReport(taskId: string, date: string, minutes: number, actor: string, proposalId: string, workSummary?: string | null) {
    dayDateSchema.parse(date);
    const before = this.taskItem(taskId, date);
    const task = this.repo.kernel.getTask(taskId);
    const item = before ? structuredClone(before) : this.blank(date, taskId, task.title);
    item.reportedMinutes = (item.reportedMinutes ?? 0) + minutes;
    if (workSummary) {
      const combined = [item.reportedWorkSummary, workSummary].filter(Boolean).join(" ");
      item.reportedWorkSummary = combined.length > 2000 ? combined.slice(0, 1997) + "..." : combined;
    }
    item.reportedMode = "manual"; item.reportedLocked = true; item.reportedEstimate = null;
    const next = this.write(item, before, actor, "session_reported");
    this.repo.sessionEvent(actor.slice("human:session-time:".length), "reported-time-applied",
      "Reported time accepted with the session proposal.", { proposalId, date, addedMinutes: minutes, itemId: next.id });
    return next;
  }
  add(raw: z.input<typeof dayAddSchema>, actor = "human:panel"): DayItem {
    const input = dayAddSchema.parse(raw);
    const item = this.repo.request(input.requestId, { kind: "day.add", input, actor }, () => {
      const task = this.repo.kernel.getTask(input.taskId);
      const previous = this.taskItem(input.taskId, input.date);
      if (previous) {
        // An already displayed row must be edited with its revision. Do not let
        // a second browser or agent overwrite reported time through Add.
        throw new ConflictError("The task is already on this day. Edit the existing entry.");
      }
      const item = this.blank(input.date, task.id, task.title);
      item.step = input.step ?? this.repo.kernel.getDossier(task.id).projection.nextStep ?? "";
      item.plannedMinutes = input.plannedMinutes ?? null; item.reportedMinutes = input.reportedMinutes ?? null;
      item.reportedWorkSummary = input.reportedWorkSummary ?? null;
      item.reportedLocked = input.reportedMinutes !== undefined;
      return this.write(item, null, actor, "added");
    });
    this.repo.changed(); return item;
  }
  private automatic(input: DayItem): DayItem {
    if (!input.calendar) return input;
    const item = structuredClone(input), event = item.calendar!;
    if (item.plannedMode === "calendar") item.plannedMinutes = (Date.parse(event.endAt) - Date.parse(event.startAt)) / 60000;
    if (item.reportedMode === "calendar") {
      item.reportedDate = item.date;
      const reportNow = this.reportMeetingsWhenPlanned() || Date.parse(event.endAt) <= this.clock().getTime();
      item.reportedMinutes = !item.removed && event.status === "confirmed" && reportNow ? item.plannedMinutes : null;
    }
    item.actualMinutes = item.reportedMinutes;
    return item;
  }
  edit(raw: z.input<typeof dayEditSchema>, actor = "human:panel"): DayItem {
    const input = dayEditSchema.parse(raw);
    const result = this.repo.request(input.requestId, { kind: "day.edit", input, actor }, () => {
      const before = this.current(input.id, input.revision), item = structuredClone(before);
      for (const field of ["plannedMinutes", "reportedMinutes"] as const) {
        if (input[field] !== undefined) {
          item[field] = input.operation === "add" ? (item[field] ?? 0) + input[field]! : input[field]!;
          item[field === "plannedMinutes" ? "plannedMode" : "reportedMode"] = "manual";
          if (field === "reportedMinutes") { item.reportedLocked = true; item.reportedEstimate = null; }
          // Explicit reporting is assigned to this date, and stays on that date
          // if the calendar subsequently moves the meeting elsewhere.
          if (field === "reportedMinutes" && before.reportedMode === "calendar") item.reportedDate = item.date;
        }
      }
      if (input.step !== undefined) item.step = input.step;
      if (input.reportedWorkSummary !== undefined) item.reportedWorkSummary = input.reportedWorkSummary ?? null;
      if (input.reportedDate !== undefined) {
        if (item.kind === "task" && input.reportedDate !== item.date) throw new PolicyError("Task time belongs to the entry's date. Add an entry for the required day.");
        item.reportedDate = input.reportedDate; item.reportedMode = "manual";
      }
      if (input.state !== undefined) { item.state = input.state; item.carriedTo = null; }
      if (input.removed !== undefined) {
        item.removed = input.removed;
        // Removing an unattended meeting must let automatic() clear calendar
        // time. Keep saved manual values for restoration; totals exclude removed entries.
        if (item.removed && item.kind !== "meeting" && item.reportedMinutes !== null) item.reportedMode = "manual";
      }
      if (input.restoreAuto) {
        if (!item.calendar) {
          if (input.restoreAuto !== "reported" || item.actualMinutes === null || item.actualMinutes <= 0) throw new PolicyError("Automatic estimates need measured agent time. Planned task time stays manual.");
          item.reportedLocked = false; item.reportedMode = "estimate";
          item.reportedMinutes = null; item.reportedEstimate = null;
        } else {
          if (input.restoreAuto !== "reported") item.plannedMode = "calendar";
          if (input.restoreAuto !== "planned") { item.reportedMode = "calendar"; item.reportedLocked = false; }
        }
      }
      return this.write(this.automatic(item), before, actor, input.restoreAuto ? "auto_restored" : "edited");
    });
    this.repo.changed(); return result;
  }
  canEstimate(item: DayItem) {
    if (!item.taskId || item.removed || item.reportedLocked || !item.actualMinutes) return false;
    if (item.reportedMode === "estimate") return true;
    if (item.reportedMinutes !== null) return false;
    // Preserve explicit blank corrections saved before reportedLocked existed.
    return !this.repo.db.prepare(`SELECT 1 FROM day_item_events WHERE item_id=? AND action='edited'
      AND json_extract(after_json,'$.reportedLocked') IS NULL
      AND json_extract(before_json,'$.reportedMinutes') IS NOT NULL AND json_extract(after_json,'$.reportedMinutes') IS NULL LIMIT 1`).get(item.id);
  }
  reconcileActual(totals: { taskId: string; date: string; minutes: number }[]) {
    const result = this.repo.store.transaction(() => {
      let changed = 0;
      for (const total of totals) {
        dayDateSchema.parse(total.date);
        if (!Number.isFinite(total.minutes) || total.minutes < 0 || total.minutes > 525600) throw new PolicyError("Invalid measured agent duration.");
        const before = this.taskItem(total.taskId, total.date);
        if (!before && total.minutes === 0) continue;
        const task = this.repo.kernel.getTask(total.taskId);
        const item = before ? structuredClone(before) : { ...this.blank(total.date, task.id, task.title), plannedMinutes: 0, step: this.repo.kernel.getDossier(task.id).projection.nextStep ?? "" };
        item.actualMinutes = total.minutes;
        // Measurement does not invent or rescale reported time. The source
        // analyst proposes a separate estimate after reviewing work evidence.
        if (!before || !same(item, before)) { this.write(item, before, "agent-time:bb", "agent_time_updated"); changed++; }
      }
      return changed;
    });
    if (result) this.repo.changed(); return result;
  }
  estimate(raw: z.input<typeof dayEstimateSchema>, actor: string) {
    const input = dayEstimateSchema.parse(raw);
    const result = this.repo.request(input.requestId, { kind: "day.estimate", input, actor }, () => {
      const before = this.current(input.id, input.revision);
      if (!this.canEstimate(before)) throw new PolicyError("This entry has no measured work, was removed, or its reported time is manual. Leave it unchanged.");
      const item = { ...before, ...(input.workSummary && before.reportedWorkSummary === null ? { reportedWorkSummary: input.workSummary } : {}), reportedMode: "estimate" as const, reportedEstimate: { basis: "work" as const, reason: input.reason, source: actor }, reportedMinutes: input.reportedMinutes };
      return this.write(item, before, actor, "reported_estimated");
    });
    this.repo.changed(); return result;
  }
  analysisWork() {
    const result: Record<string, string> = {};
    for (let offset: number | null = 0; offset !== null;) {
      const page = this.estimateCandidates(offset);
      for (const item of page.items) {
        const request = this.repo.db.prepare("SELECT MAX(sequence) AS sequence FROM day_item_events WHERE item_id=? AND action='auto_restored'").get(item.id) as { sequence: number | null };
        // AI estimates must not trigger another pass over the same work. A
        // human request for a new estimate must, even if measured time is equal.
        result[item.id] = digest({ date: item.date, taskId: item.taskId, actualMinutes: item.actualMinutes, title: item.title, summary: item.summary, workContext: item.workContext, request: request.sequence });
      }
      offset = page.nextOffset;
    }
    return result;
  }
  estimateCandidates(offset = 0, onlyIds?: ReadonlySet<string>) {
    const items = this.rows("WHERE task_id IS NOT NULL AND date<=? ORDER BY date,id", this.today()).filter(i => this.canEstimate(i) && (!onlyIds || onlyIds.has(i.id)));
    const page = [];
    let bytes = 0;
    for (const item of items.slice(offset, offset + 5)) {
      const dossier = this.repo.kernel.getDossier(item.taskId!);
      const onDay = (at: string) => Number.isFinite(Date.parse(at)) && localDay(new Date(at), this.timeZone) === item.date;
      const facts = dossier.facts.filter(f => onDay(f.occurredAt));
      const sessions = this.repo.sessions(item.taskId!).filter(s => onDay(s.finishedAt ?? s.updatedAt));
      const candidate = { ...item, title: dossier.task.title, summary: dossier.projection.summary?.slice(0, 4000) ?? null,
        workContext: {
          date: item.date,
          acceptedFacts: facts.slice(-20).map(f => ({ id: f.id, kind: f.kind, text: f.text.slice(0, 1500), occurredAt: f.occurredAt })),
          // Session results are evidence for estimation, not accepted task changes.
          sessions: sessions.slice(0, 5).map(s => ({ id: s.id, status: s.status, finishedAt: s.finishedAt,
            objective: s.objective.slice(0, 1000), resultSummary: s.result?.summary.slice(0, 3000) ?? null,
            recordedFacts: (s.extraction?.facts ?? []).slice(0, 10).map(f => ({ kind: f.kind, text: f.text.slice(0, 1000) })) })),
          contextMayBeIncomplete: true,
        } };
      const size = Buffer.byteLength(JSON.stringify(candidate, null, 2));
      if (page.length && bytes + size > 650 * 1024) break;
      page.push(candidate); bytes += size;
    }
    const next = offset + page.length;
    return { items: page, nextOffset: next < items.length ? next : null };
  }
  carry(raw: z.infer<typeof dayRpcContract.dayCarry.input>, actor = "human:panel") {
    const input = dayRpcContract.dayCarry.input.parse(raw);
    const result = this.repo.request(input.requestId, { kind: "day.carry", input, actor }, () => {
      const before = this.current(input.id, input.revision);
      if (!before.taskId || before.calendar) throw new PolicyError("Reschedule the meeting in the calendar.");
      if (input.date === before.date) throw new PolicyError("Choose another date to continue.");
      if (before.removed) throw new PolicyError("Restore the entry to the plan first.");
      if (this.taskItem(before.taskId, input.date)) throw new ConflictError("This task is already on the selected day. Its time is unchanged.");
      const task = this.repo.kernel.getTask(before.taskId);
      const next = { ...this.blank(input.date, task.id, task.title), step: before.step };
      const original = this.write({ ...before, state: "carried", carriedTo: input.date }, before, actor, "carried");
      return { original, next: this.write(next, null, actor, "continued") };
    });
    this.repo.changed(); return result;
  }
  reorder(raw: z.infer<typeof dayRpcContract.dayReorder.input>, actor = "human:panel") {
    const input = dayRpcContract.dayReorder.input.parse(raw);
    this.repo.request(input.requestId, { kind: "day.reorder", input, actor }, () => {
      if (new Set(input.ids).size !== input.ids.length) throw new PolicyError("The day order contains a duplicate entry.");
      const current = this.rows("WHERE date=?", input.date).filter(item => item.kind === "task" && !item.removed);
      if (current.length !== input.ids.length || current.some(item => !input.ids.includes(item.id))) throw new ConflictError("The day's entries changed. Refresh the plan and retry the move.");
      const items = input.ids.map(id => this.current(id, input.revisions[id]));
      items.forEach((item, ordinal) => { if (item.ordinal !== ordinal) this.write({ ...item, ordinal }, item, actor, "reordered"); });
      return { ok: true };
    });
    this.repo.changed(); return this.day(input.date);
  }
  config(date: string) {
    const row = this.repo.db.prepare("SELECT value_json FROM day_configs WHERE date=?").get(date) as JsonRow | undefined;
    return row ? dayConfigSchema.parse(JSON.parse(row.value_json)) : { date, capacityMinutes: null, note: "", revision: 0 };
  }
  setConfig(raw: z.infer<typeof dayRpcContract.dayConfig.input>, actor = "human:panel") {
    const input = dayRpcContract.dayConfig.input.parse(raw);
    const result = this.repo.request(input.requestId, { kind: "day.config", input, actor }, () => {
      const before = this.config(input.date);
      if (before.revision !== input.revision) throw new ConflictError("Day settings changed. Refresh the plan.");
      const next = dayConfigSchema.parse({ ...input, revision: before.revision + 1 });
      this.repo.db.prepare("INSERT INTO day_configs VALUES (?,?) ON CONFLICT(date) DO UPDATE SET value_json=excluded.value_json").run(input.date, JSON.stringify(next));
      this.repo.db.prepare("INSERT INTO day_config_events(date,at,actor,before_json,after_json) VALUES (?,?,?,?,?)").run(input.date, this.now(), actor, JSON.stringify(before), JSON.stringify(next));
      return next;
    });
    this.repo.changed(); return result;
  }
  calendarState(): CalendarState {
    const row = this.repo.db.prepare("SELECT value_json FROM calendar_sync_state WHERE id=1").get() as JsonRow | undefined;
    return row ? calendarStateSchema.parse(JSON.parse(row.value_json)) : { ...EMPTY_CALENDAR };
  }
  saveCalendarState(raw: CalendarState) {
    const state = calendarStateSchema.parse(raw);
    this.repo.db.prepare("INSERT INTO calendar_sync_state VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json").run(JSON.stringify(state));
    this.repo.changed(); return state;
  }
  private present(item: DayItem, date: string) {
    const task = item.taskId ? this.repo.kernel.getTask(item.taskId) : null;
    return { ...item, title: task?.title ?? item.title, taskStatus: task?.status ?? null, waitingSince: task?.waitingSince ?? null, reportOnly: item.date !== date, reportedChanges: reportedChanges(this.repo, item.id) };
  }
  private totals(items: DayItem[], from?: string, through?: string) {
    const inPeriod = (date: string) => !from || date >= from && date <= through!;
    return { plannedMinutes: items.reduce((n, i) => n + (inPeriod(i.date) && plannedCounts(i) ? i.plannedMinutes ?? 0 : 0), 0),
      actualMinutes: items.reduce((n, i) => n + (inPeriod(actualDate(i)) ? i.actualMinutes ?? 0 : 0), 0),
      reportedMinutes: items.reduce((n, i) => n + (!i.removed && inPeriod(i.reportedDate) ? i.reportedMinutes ?? 0 : 0), 0),
      estimatedReported: items.filter(i => !i.removed && inPeriod(i.reportedDate) && i.reportedMode === "estimate" && i.reportedMinutes !== null).length,
      missingReported: items.filter(i => inPeriod(i.date) && plannedCounts(i) && i.reportedMinutes === null && i.date <= this.today()).length };
  }
  day(raw = this.today()): DayView {
    const date = dayDateSchema.parse(raw);
    const items = this.rows("WHERE date=? OR reported_date=?", date, date)
      .sort((a, b) => a.kind === b.kind ? a.calendar && b.calendar ? Date.parse(a.calendar.startAt) - Date.parse(b.calendar.startAt) : a.ordinal - b.ordinal || a.id.localeCompare(b.id) : a.kind === "meeting" ? -1 : 1);
    return { date, today: this.today(), timeZone: this.timeZone, config: this.config(date), items: items.map(i => this.present(i, date)), totals: this.totals(items, date, date), calendar: this.calendarState() };
  }
  report(raw: z.input<typeof dayRpcContract.timeReport.input>): TimeReport {
    const input = dayRpcContract.timeReport.input.parse(raw), date = input.date ?? this.today();
    const from = input.period === "week" ? weekStart(date) : date, through = input.period === "week" ? shiftDay(from, 6) : date;
    if (input.taskId) this.repo.kernel.getTask(input.taskId);
    const items = this.rows(`WHERE (date BETWEEN ? AND ? OR reported_date BETWEEN ? AND ?) ${input.taskId ? "AND task_id=?" : ""}`, from, through, from, through, ...(input.taskId ? [input.taskId] : []));
    const groups = new Map<string, TimeReport["rows"][number]>();
    for (const item of items) {
      const key = item.taskId ?? item.id;
      const planned = item.date >= from && item.date <= through && plannedCounts(item) ? item.plannedMinutes : null;
      const reported = !item.removed && item.reportedDate >= from && item.reportedDate <= through ? item.reportedMinutes : null;
      const actual = actualDate(item) >= from && actualDate(item) <= through ? item.actualMinutes : null;
      const estimatedReported = item.reportedMode === "estimate" && reported !== null;
      if (planned === null && reported === null && actual === null) continue;
      const group = groups.get(key) ?? { key, taskId: item.taskId, title: item.taskId ? this.repo.kernel.getTask(item.taskId).title : item.title, kind: item.kind, plannedMinutes: null, actualMinutes: null, reportedMinutes: null, estimatedReported: false, days: [] };
      if (planned !== null) group.plannedMinutes = (group.plannedMinutes ?? 0) + planned;
      if (actual !== null) group.actualMinutes = (group.actualMinutes ?? 0) + actual;
      if (reported !== null) group.reportedMinutes = (group.reportedMinutes ?? 0) + reported;
      group.estimatedReported ||= estimatedReported;
      const reportedFrom = reported === null ? [] : [...new Set(reportedComposition(reportedChanges(this.repo, item.id)).map(c => c.source))];
      if (item.date === item.reportedDate) group.days.push({ date: item.date, itemId: item.id, plannedMinutes: planned, actualMinutes: actual, reportedMinutes: reported, estimatedReported, reportedFrom });
      else {
        if (planned !== null) group.days.push({ date: item.date, itemId: item.id, plannedMinutes: planned, actualMinutes: null, reportedMinutes: null, estimatedReported: false, reportedFrom: [] });
        if (reported !== null || actual !== null) group.days.push({ date: item.reportedDate, itemId: item.id, plannedMinutes: null, actualMinutes: actual, reportedMinutes: reported, estimatedReported, reportedFrom });
      }
      groups.set(key, group);
    }
    const rows = [...groups.values()]; rows.forEach(row => row.days.sort((a, b) => a.date.localeCompare(b.date)));
    return { from, through, timeZone: this.timeZone, totals: this.totals(items, from, through), rows };
  }
  taskTotals(taskId: string) { this.repo.kernel.getTask(taskId); return this.totals(this.rows("WHERE task_id=?", taskId)); }
  history(id: string, offset = 0) {
    this.get(id);
    const rows = this.repo.db.prepare("SELECT * FROM day_item_events WHERE item_id=? ORDER BY sequence DESC LIMIT 51 OFFSET ?").all(id, offset) as { sequence: number; at: string; actor: string; action: string; before_json: string | null; after_json: string }[];
    return { items: rows.slice(0, 50).map(r => ({ sequence: r.sequence, at: r.at, actor: r.actor, action: r.action, before: r.before_json ? decode(JSON.parse(r.before_json)) : null, after: decode(JSON.parse(r.after_json)) })), nextOffset: rows.length > 50 ? offset + 50 : null };
  }
  calendarItems(from?: string, through?: string): DayItem[] {
    return this.rows(`WHERE calendar_key IS NOT NULL${from && through ? " AND date BETWEEN ? AND ?" : ""}`, ...(from && through ? [from, through] : []));
  }
  mergeCalendar(raw: CalendarEvent[], actor = "calendar:google") {
    const events = z.array(calendarEventSchema).max(3000).parse(raw);
    if (new Set(events.map(e => e.key)).size !== events.length) throw new PolicyError("The calendar returned duplicate events.");
    const result = this.repo.store.transaction(() => {
      let changed = 0;
      for (const event of events) {
        const row = this.repo.db.prepare("SELECT value_json FROM day_items WHERE calendar_key=?").get(event.key) as JsonRow | undefined;
        const before = row ? decode(JSON.parse(row.value_json)) : null;
        if (!before && event.status !== "confirmed") continue;
        const date = localDay(new Date(event.startAt), this.timeZone);
        const initial = before ?? { ...this.blank(date, null, event.title), plannedMode: "calendar" as const, reportedMode: "calendar" as const };
        const next = this.automatic({ ...initial, calendar: event, title: event.title, date });
        if (!before || !same(next, before)) { this.write(next, before, actor, before ? "calendar_updated" : "calendar_added"); changed++; }
      }
      return { changed, events: events.length };
    });
    if (result.changed) this.repo.changed(); return result;
  }
  tick() {
    const result = this.repo.store.transaction(() => {
      let changed = 0;
      for (const before of this.rows("WHERE calendar_key IS NOT NULL AND json_extract(value_json,'$.reportedMode')='calendar' AND json_extract(value_json,'$.reportedMinutes') IS NULL AND json_extract(value_json,'$.calendar.status')='confirmed'")) {
        const after = this.automatic(before);
        if (!same(before, after)) { this.write(after, before, "calendar:clock", "meeting_reported"); changed++; }
      }
      return changed;
    });
    if (result) this.repo.changed(); return result;
  }
}
