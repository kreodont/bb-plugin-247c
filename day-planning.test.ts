import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { DayPlanning } from "./day-planning.js";
import { formatMinutes, parseMinutes, type CalendarEvent } from "./day-contracts.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() {
  const f = await fixture(); hosts.push(f);
  let now = new Date("2026-09-10T12:00:00Z");
  return { f, task: await f.create(), days: new DayPlanning(f.repo, () => now), setNow: (value: string) => { now = new Date(value); } };
}
function meeting(patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return { key: "gcal:test", calendarId: "owner@example.com", eventId: "event1", occurrenceId: null, title: "Созвон",
    startAt: "2026-09-10T10:00:00Z", endAt: "2026-09-10T10:30:00Z", url: null, status: "confirmed", ...patch };
}

it("persists independent planned/reported, distinguishes blank from zero, and keeps the dossier unchanged", async () => {
  const { f, task, days } = await setup(); const before = f.repo.detail(task.id);
  const input = { taskId: task.id, date: "2026-09-10", plannedMinutes: 10, reportedMinutes: 180, requestId: randomUUID() };
  let item = days.add(input); expect(days.add(input)).toEqual(item);
  item = days.edit({ id: item.id, revision: item.revision, reportedMinutes: 20, operation: "add", requestId: randomUUID() });
  expect(item.plannedMinutes).toBe(10); expect(item.reportedMinutes).toBe(200);
  item = days.edit({ id: item.id, revision: item.revision, plannedMinutes: null, requestId: randomUUID() });
  expect(item.plannedMinutes).toBeNull(); expect(item.reportedMinutes).toBe(200);
  item = days.edit({ id: item.id, revision: item.revision, reportedMinutes: 0, requestId: randomUUID() });
  expect(days.report({ date: item.date, period: "day" }).rows[0]).toMatchObject({ plannedMinutes: null, reportedMinutes: 0 });
  expect(f.repo.detail(task.id)).toEqual(before);
  await f.reload(); expect(new DayPlanning(f.repo).get(item.id)).toEqual(item);
  expect(new DayPlanning(f.repo).history(item.id).items).toHaveLength(4);
});

it("carries a step without rewriting history, prevents duplicate dates and logs time after task closure", async () => {
  const { f, task, days } = await setup();
  const initial = days.add({ taskId: task.id, date: "2026-09-10", step: "Проверить два поля", plannedMinutes: 10, reportedMinutes: 180, requestId: randomUUID() });
  const moved = days.carry({ id: initial.id, revision: 0, date: "2026-09-11", requestId: randomUUID() });
  expect(moved.original).toMatchObject({ plannedMinutes: 10, reportedMinutes: 180, state: "carried" });
  expect(moved.next).toMatchObject({ plannedMinutes: null, reportedMinutes: null, step: initial.step });
  expect(() => days.add({ taskId: task.id, date: moved.next.date, requestId: randomUUID() })).toThrow(/already/);
  f.repo.status(task.id, "done", f.repo.kernel.getTask(task.id).revision);
  const edited = days.edit({ id: moved.next.id, revision: 0, reportedMinutes: 45, requestId: randomUUID() });
  expect(edited.reportedMinutes).toBe(45);
  expect(days.taskTotals(task.id)).toMatchObject({ plannedMinutes: 10, reportedMinutes: 225 });
  expect(days.day(initial.date).items[0].taskStatus).toBe("done");
});

it("rejects stale edits and rolls the record and audit back together", async () => {
  const { f, task, days } = await setup();
  const initial = days.add({ taskId: task.id, date: "2026-09-10", requestId: randomUUID() });
  const current = days.edit({ id: initial.id, revision: 0, reportedMinutes: 180, requestId: randomUUID() });
  expect(() => days.edit({ id: initial.id, revision: 0, plannedMinutes: 10, requestId: randomUUID() })).toThrow(/changed/);
  f.repo.db.exec("CREATE TRIGGER fail_day_audit BEFORE INSERT ON day_item_events BEGIN SELECT RAISE(ABORT,'audit failed'); END");
  expect(() => days.edit({ id: current.id, revision: current.revision, plannedMinutes: 20, requestId: randomUUID() })).toThrow(/audit failed/);
  expect(days.get(current.id)).toEqual(current); expect(days.history(current.id).items).toHaveLength(2);
});

it("reports meetings after their end, respects each manual field and supports return to calendar", async () => {
  const { days, setNow } = await setup();
  const event = meeting({ startAt: "2026-09-10T13:00:00Z", endAt: "2026-09-10T13:30:00Z" });
  days.mergeCalendar([event]); let item = days.calendarItems()[0];
  expect(item).toMatchObject({ plannedMinutes: 30, reportedMinutes: null });
  setNow("2026-09-10T13:30:00Z"); expect(days.tick()).toBe(1); item = days.get(item.id); expect(item.reportedMinutes).toBe(30);
  item = days.edit({ id: item.id, revision: item.revision, plannedMinutes: 45, requestId: randomUUID() }); expect(item.reportedMinutes).toBe(45);
  item = days.edit({ id: item.id, revision: item.revision, reportedMinutes: 20, requestId: randomUUID() });
  days.mergeCalendar([{ ...event, endAt: "2026-09-10T14:00:00Z" }]); item = days.get(item.id);
  expect(item).toMatchObject({ plannedMinutes: 45, reportedMinutes: 20 });
  item = days.edit({ id: item.id, revision: item.revision, restoreAuto: "planned", requestId: randomUUID() });
  expect(item).toMatchObject({ plannedMinutes: 60, reportedMinutes: 20 });
  setNow("2026-09-10T14:00:00Z");
  item = days.edit({ id: item.id, revision: item.revision, restoreAuto: "reported", requestId: randomUUID() });
  expect(item.reportedMinutes).toBe(60); expect(days.tick()).toBe(0);
  expect(days.mergeCalendar([item.calendar!]).changed).toBe(0);
});

it("keeps manual reported on its original day when the calendar moves or cancels a meeting", async () => {
  const { days } = await setup(); days.mergeCalendar([meeting()]); let item = days.calendarItems()[0];
  item = days.edit({ id: item.id, revision: item.revision, reportedMinutes: 25, requestId: randomUUID() });
  days.mergeCalendar([meeting({ startAt: "2026-09-11T10:00:00Z", endAt: "2026-09-11T10:30:00Z" })]);
  expect(days.calendarItems()).toHaveLength(1);
  expect(days.day("2026-09-10").items[0]).toMatchObject({ reportOnly: true, reportedDate: "2026-09-10" });
  expect(days.report({ date: "2026-09-10", period: "day" }).totals).toMatchObject({ plannedMinutes: 0, reportedMinutes: 25 });
  expect(days.report({ date: "2026-09-11", period: "day" }).totals).toMatchObject({ plannedMinutes: 30, reportedMinutes: 0 });
  days.mergeCalendar([meeting({ status: "cancelled" })]);
  expect(days.report({ date: "2026-09-10", period: "week" }).totals).toMatchObject({ plannedMinutes: 0, reportedMinutes: 25 });
  item = days.get(item.id);
  item = days.edit({ id: item.id, revision: item.revision, reportedDate: "2026-09-11", requestId: randomUUID() });
  expect(days.report({ date: "2026-09-11", period: "day" }).totals.reportedMinutes).toBe(25);
});

it("keeps identical meeting titles separate and sums a task over the Monday-based week", async () => {
  const { days, task } = await setup();
  days.add({ taskId: task.id, date: "2026-09-07", plannedMinutes: 10, reportedMinutes: 180, requestId: randomUUID() });
  days.add({ taskId: task.id, date: "2026-09-10", plannedMinutes: 30, reportedMinutes: 20, requestId: randomUUID() });
  days.add({ taskId: task.id, date: "2026-09-06", reportedMinutes: 999, requestId: randomUUID() });
  days.mergeCalendar([meeting(), meeting({ key: "gcal:second", eventId: "second" })]);
  const report = days.report({ date: "2026-09-13", period: "week" });
  expect(report.from).toBe("2026-09-07"); expect(report.through).toBe("2026-09-13");
  expect(report.rows).toHaveLength(3); expect(report.rows.filter(r => r.kind === "meeting")).toHaveLength(2);
  expect(report.totals).toMatchObject({ plannedMinutes: 100, reportedMinutes: 260 });
});

it("parses durations including fractional hours without accepting negative or malformed times", () => {
  expect(parseMinutes("3ч")).toBe(180); expect(parseMinutes("1,5ч")).toBe(90); expect(parseMinutes("1:20")).toBe(80);
  expect(parseMinutes("10м 30с")).toBe(10.5); expect(parseMinutes("")).toBeNull(); expect(parseMinutes("0")).toBe(0);
  expect(formatMinutes(10.5)).toBe("10m 30s"); expect(() => parseMinutes("-10")).toThrow(); expect(() => parseMinutes("1:99")).toThrow();
});

it("adds a reported delta exactly once and rejects reuse with a different amount", async () => {
  const { days, task } = await setup();
  const item = days.add({ taskId: task.id, date: "2026-09-10", reportedMinutes: 180, requestId: randomUUID() });
  const input = { id: item.id, revision: item.revision, reportedMinutes: 20, operation: "add" as const, requestId: randomUUID() };
  expect(days.edit(input).reportedMinutes).toBe(200); expect(days.edit(input).reportedMinutes).toBe(200);
  expect(() => days.edit({ ...input, reportedMinutes: 30 })).toThrow();
  expect(days.history(item.id).items).toHaveLength(2);
});

it("reorders atomically, rejects stale membership and preserves reports when removing a plan", async () => {
  const { days, task, f } = await setup(); const other = await f.create();
  const first = days.add({ date: "2026-09-10", taskId: task.id, plannedMinutes: 10, reportedMinutes: 180, requestId: randomUUID() });
  const second = days.add({ date: first.date, taskId: other.id, requestId: randomUUID() });
  const order = { date: first.date, ids: [second.id, first.id], revisions: { [first.id]: 0, [second.id]: 0 }, requestId: randomUUID() };
  expect(days.reorder(order).items.map(i => i.id)).toEqual(order.ids);
  expect(() => days.reorder({ ...order, requestId: randomUUID() })).toThrow(/changed/);
  expect(days.day(first.date).items.map(i => i.id)).toEqual(order.ids);
  const current = days.get(first.id);
  days.edit({ id: first.id, revision: current.revision, removed: true, requestId: randomUUID() });
  expect(days.report({ date: first.date, period: "day" }).totals).toMatchObject({ plannedMinutes: 0, reportedMinutes: 180 });
  expect(days.history(first.id).items[0].before?.plannedMinutes).toBe(10);
});

it("confines worker time edits to its task and denies recording agents", async () => {
  const { f, days, task } = await setup(), other = await f.create();
  const mine = days.add({ date: "2026-09-10", taskId: task.id, requestId: randomUUID() });
  const theirs = days.add({ date: mine.date, taskId: other.id, requestId: randomUUID() });
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const session = f.repo.sessions(task.id)[0], ctx = { threadId: session.workerThreadId! };
  const edit = (id: string) => ({ id, revision: 0, reportedMinutes: 180, requestId: randomUUID() });
  await expect(f.harness.behavior.callAgentTool("c247_time_edit", edit(theirs.id), ctx)).rejects.toThrow(/only for its own task/);
  await f.harness.behavior.callAgentTool("c247_time_edit", edit(mine.id), ctx);
  expect(days.get(mine.id).reportedMinutes).toBe(180); expect(days.get(theirs.id).reportedMinutes).toBeNull();
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const reviewerId = f.repo.session(session.id).reviewerThreadId!;
  await expect(f.harness.behavior.callAgentTool("c247_day", { date: mine.date }, { threadId: reviewerId })).rejects.toThrow(/only for its own task/);
});
