import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Repository } from "./repository.js";
import { ConflictError, PolicyError } from "./core/errors.js";
import { calendarEventSchema, calendarStateSchema, dayAddSchema, dayConfigSchema, dayDateSchema, dayEditSchema, dayItemSchema, dayRpcContract,
  DAY_TIME_ZONE, localDay, shiftDay, weekStart, type CalendarEvent, type CalendarState, type DayItem, type DayView, type TimeReport } from "./day-contracts.js";

type JsonRow = { value_json: string };
export const EMPTY_CALENDAR: CalendarState = { status: "idle", startedAt: null, completedAt: null, message: null, events: 0, from: null, through: null };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const plannedCounts = (item: DayItem) => !item.removed && (!item.calendar || item.calendar.status === "confirmed");

export class DayPlanning {
  constructor(readonly repo: Repository, readonly clock: () => Date = () => new Date()) {}
  now() { return this.clock().toISOString(); }
  today() { return localDay(this.clock()); }
  get(id: string): DayItem {
    const row = this.repo.db.prepare("SELECT value_json FROM day_items WHERE id=?").get(id) as JsonRow | undefined;
    if (!row) throw new PolicyError("Запись дня не найдена. Обнови план.");
    return dayItemSchema.parse(JSON.parse(row.value_json));
  }
  private rows(sql: string, ...args: string[]) {
    const rows = this.repo.db.prepare(`SELECT value_json FROM day_items ${sql}`).all(...args) as JsonRow[];
    if (rows.length > 5000) throw new PolicyError("Слишком много записей для одного ответа. Выбери меньший период или отдельную задачу.");
    return rows.map(row => dayItemSchema.parse(JSON.parse(row.value_json)));
  }
  private write(raw: DayItem, before: DayItem | null, actor: string, action: string): DayItem {
    const next = dayItemSchema.parse({ ...raw, revision: before ? before.revision + 1 : 0, updatedAt: this.now() });
    this.repo.db.prepare(`INSERT INTO day_items(id,date,reported_date,task_id,calendar_key,value_json) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET date=excluded.date,reported_date=excluded.reported_date,value_json=excluded.value_json`).run(next.id, next.date, next.reportedDate, next.taskId, next.calendar?.key ?? null, JSON.stringify(next));
    this.repo.db.prepare("INSERT INTO day_item_events(item_id,at,actor,action,before_json,after_json) VALUES (?,?,?,?,?,?)")
      .run(next.id, this.now(), actor, action, before ? JSON.stringify(before) : null, JSON.stringify(next));
    return next;
  }
  private current(id: string, revision: number) {
    const item = this.get(id);
    if (item.revision !== revision) throw new ConflictError("Запись времени изменилась в другом окне. Обнови её и повтори правку.");
    return item;
  }
  private blank(date: string, taskId: string | null, title: string): DayItem {
    const count = this.repo.db.prepare("SELECT count(*) AS n FROM day_items WHERE date=?").get(date) as { n: number };
    if (count.n >= 1000) throw new PolicyError("В одном дне уже 1000 записей.");
    return { id: randomUUID(), date, reportedDate: date, kind: taskId ? "task" : "meeting", taskId, title, step: "", ordinal: count.n,
      revision: 0, plannedMinutes: null, reportedMinutes: null, plannedMode: "manual", reportedMode: "manual", state: "open", removed: false,
      carriedTo: null, calendar: null, createdAt: this.now(), updatedAt: this.now() };
  }
  taskItem(taskId: string, date: string): DayItem | null {
    const row = this.repo.db.prepare("SELECT value_json FROM day_items WHERE task_id=? AND date=?").get(taskId, date) as JsonRow | undefined;
    return row ? dayItemSchema.parse(JSON.parse(row.value_json)) : null;
  }
  add(raw: z.input<typeof dayAddSchema>, actor = "human:panel"): DayItem {
    const input = dayAddSchema.parse(raw);
    const item = this.repo.request(input.requestId, { kind: "day.add", input, actor }, () => {
      const task = this.repo.kernel.getTask(input.taskId);
      const previous = this.taskItem(input.taskId, input.date);
      if (previous) {
        // An already displayed row must be edited with its revision. Do not let
        // a second browser or agent overwrite reported time through Add.
        throw new ConflictError("Задача уже есть в этом дне. Измени существующую запись.");
      }
      const item = this.blank(input.date, task.id, task.title);
      item.step = input.step ?? this.repo.kernel.getDossier(task.id).projection.nextStep ?? "";
      item.plannedMinutes = input.plannedMinutes ?? null; item.reportedMinutes = input.reportedMinutes ?? null;
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
      item.reportedMinutes = !item.removed && event.status === "confirmed" && Date.parse(event.endAt) <= this.clock().getTime() ? item.plannedMinutes : null;
    }
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
          // Explicit reporting is assigned to this date, and stays on that date
          // if the calendar subsequently moves the meeting elsewhere.
          if (field === "reportedMinutes" && before.reportedMode === "calendar") item.reportedDate = item.date;
        }
      }
      if (input.step !== undefined) item.step = input.step;
      if (input.reportedDate !== undefined) {
        if (item.kind === "task" && input.reportedDate !== item.date) throw new PolicyError("Время задачи относится к дате её записи. Добавь запись нужного дня.");
        item.reportedDate = input.reportedDate; item.reportedMode = "manual";
      }
      if (input.state !== undefined) { item.state = input.state; item.carriedTo = null; }
      if (input.removed !== undefined) {
        item.removed = input.removed;
        if (item.removed && item.reportedMinutes !== null) item.reportedMode = "manual";
      }
      if (input.restoreAuto) {
        if (!item.calendar) throw new PolicyError("Автоматическое время доступно только для встреч из календаря.");
        if (input.restoreAuto !== "reported") item.plannedMode = "calendar";
        if (input.restoreAuto !== "planned") item.reportedMode = "calendar";
      }
      return this.write(this.automatic(item), before, actor, input.restoreAuto ? "auto_restored" : "edited");
    });
    this.repo.changed(); return result;
  }
  carry(raw: z.infer<typeof dayRpcContract.dayCarry.input>, actor = "human:panel") {
    const input = dayRpcContract.dayCarry.input.parse(raw);
    const result = this.repo.request(input.requestId, { kind: "day.carry", input, actor }, () => {
      const before = this.current(input.id, input.revision);
      if (!before.taskId || before.calendar) throw new PolicyError("Встречу нужно переносить в календаре.");
      if (input.date === before.date) throw new PolicyError("Выбери другую дату для продолжения.");
      if (before.removed) throw new PolicyError("Сначала верни запись в план.");
      if (this.taskItem(before.taskId, input.date)) throw new ConflictError("Эта задача уже есть в выбранном дне. Её время не изменено.");
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
      if (new Set(input.ids).size !== input.ids.length) throw new PolicyError("Запись повторяется в порядке дня.");
      const current = this.rows("WHERE date=?", input.date).filter(item => item.kind === "task" && !item.removed);
      if (current.length !== input.ids.length || current.some(item => !input.ids.includes(item.id))) throw new ConflictError("Состав дня изменился. Обнови план и повтори перемещение.");
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
      if (before.revision !== input.revision) throw new ConflictError("Параметры дня изменились. Обнови план.");
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
    return { ...item, title: task?.title ?? item.title, taskStatus: task?.status ?? null, reportOnly: item.date !== date };
  }
  private totals(items: DayItem[], from?: string, through?: string) {
    const inPeriod = (date: string) => !from || date >= from && date <= through!;
    return { plannedMinutes: items.reduce((n, i) => n + (inPeriod(i.date) && plannedCounts(i) ? i.plannedMinutes ?? 0 : 0), 0),
      reportedMinutes: items.reduce((n, i) => n + (inPeriod(i.reportedDate) ? i.reportedMinutes ?? 0 : 0), 0),
      missingReported: items.filter(i => inPeriod(i.date) && plannedCounts(i) && i.reportedMinutes === null && i.date <= this.today()).length };
  }
  day(raw = this.today()): DayView {
    const date = dayDateSchema.parse(raw);
    const items = this.rows("WHERE date=? OR reported_date=?", date, date)
      .sort((a, b) => a.kind === b.kind ? a.calendar && b.calendar ? Date.parse(a.calendar.startAt) - Date.parse(b.calendar.startAt) : a.ordinal - b.ordinal || a.id.localeCompare(b.id) : a.kind === "meeting" ? -1 : 1);
    return { date, today: this.today(), timeZone: DAY_TIME_ZONE, config: this.config(date), items: items.map(i => this.present(i, date)), totals: this.totals(items, date, date), calendar: this.calendarState() };
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
      const reported = item.reportedDate >= from && item.reportedDate <= through ? item.reportedMinutes : null;
      if (planned === null && reported === null) continue;
      const group = groups.get(key) ?? { key, taskId: item.taskId, title: item.taskId ? this.repo.kernel.getTask(item.taskId).title : item.title, kind: item.kind, plannedMinutes: null, reportedMinutes: null, days: [] };
      if (planned !== null) group.plannedMinutes = (group.plannedMinutes ?? 0) + planned;
      if (reported !== null) group.reportedMinutes = (group.reportedMinutes ?? 0) + reported;
      if (item.date === item.reportedDate) group.days.push({ date: item.date, itemId: item.id, plannedMinutes: planned, reportedMinutes: reported });
      else {
        if (planned !== null) group.days.push({ date: item.date, itemId: item.id, plannedMinutes: planned, reportedMinutes: null });
        if (reported !== null) group.days.push({ date: item.reportedDate, itemId: item.id, plannedMinutes: null, reportedMinutes: reported });
      }
      groups.set(key, group);
    }
    const rows = [...groups.values()]; rows.forEach(row => row.days.sort((a, b) => a.date.localeCompare(b.date)));
    return { from, through, timeZone: DAY_TIME_ZONE, totals: this.totals(items, from, through), rows };
  }
  taskTotals(taskId: string) { this.repo.kernel.getTask(taskId); return this.totals(this.rows("WHERE task_id=?", taskId)); }
  history(id: string, offset = 0) {
    this.get(id);
    const rows = this.repo.db.prepare("SELECT * FROM day_item_events WHERE item_id=? ORDER BY sequence DESC LIMIT 51 OFFSET ?").all(id, offset) as { sequence: number; at: string; actor: string; action: string; before_json: string | null; after_json: string }[];
    return { items: rows.slice(0, 50).map(r => ({ sequence: r.sequence, at: r.at, actor: r.actor, action: r.action, before: r.before_json ? dayItemSchema.parse(JSON.parse(r.before_json)) : null, after: dayItemSchema.parse(JSON.parse(r.after_json)) })), nextOffset: rows.length > 50 ? offset + 50 : null };
  }
  calendarItems(from?: string, through?: string): DayItem[] {
    return this.rows(`WHERE calendar_key IS NOT NULL${from && through ? " AND date BETWEEN ? AND ?" : ""}`, ...(from && through ? [from, through] : []));
  }
  mergeCalendar(raw: CalendarEvent[], actor = "calendar:google") {
    const events = z.array(calendarEventSchema).max(3000).parse(raw);
    if (new Set(events.map(e => e.key)).size !== events.length) throw new PolicyError("Календарь вернул повторяющиеся события.");
    const result = this.repo.store.transaction(() => {
      let changed = 0;
      for (const event of events) {
        const row = this.repo.db.prepare("SELECT value_json FROM day_items WHERE calendar_key=?").get(event.key) as JsonRow | undefined;
        const before = row ? dayItemSchema.parse(JSON.parse(row.value_json)) : null;
        if (!before && event.status !== "confirmed") continue;
        const date = localDay(new Date(event.startAt));
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
