import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readCalendar, normalizeCalendarEvent } from "./calendar-reader.js";
import { WORK_CALENDAR } from "./source-connectors.js";
import { CalendarRuntime } from "./calendar-runtime.js";
import { DayPlanning } from "./day-planning.js";
import { fixture } from "./test-support.js";
import * as reader from "./calendar-reader.js";
import * as collector from "./source-collector.js";
import { syncStartSchema, type SyncRun } from "./contracts.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); vi.restoreAllMocks(); });
const event = (id = "first", patch: Record<string, unknown> = {}) => ({ id, summary: "Созвон", start: { dateTime: "2026-09-10T23:30:00+03:00" }, end: { dateTime: "2026-09-11T00:00:00+03:00" }, ...patch });
function connection(answer: (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>) {
  const close = vi.fn(async () => {}), call = vi.fn(async (name: string, args: Record<string, unknown>) => ({ structuredContent: await answer(name, args) }));
  return { connect: async () => ({ call, close }), close, call };
}
const input = () => ({ from: "2026-09-07", through: "2026-09-17", known: [], signal: new AbortController().signal });
async function setup() { const f = await fixture(); hosts.push(f); return { f, days: new DayPlanning(f.repo, () => new Date("2026-09-12T00:00:00Z")) }; }

it("reads every calendar page, deduplicates occurrences, and assigns the local meeting date", async () => {
  const { days } = await setup();
  const recurring = event("second", { originalStartTime: { dateTime: "2026-09-11T23:30:00+03:00" }, recurringEventId: "series" });
  const c = connection((name, args) => name === "list_calendars" ? args.pageToken ? { calendars: [{ id: WORK_CALENDAR }] } : { calendars: [{ id: "other" }], nextPageToken: "cal-2" }
    : args.pageToken ? { events: [recurring, event("first")] } : { events: [event("first"), event("all-day", { start: { date: "2026-09-10" }, end: { date: "2026-09-11" } })], nextPageToken: "events-2" });
  const result = await readCalendar(input(), c.connect);
  expect(result.events).toHaveLength(2); expect(result.readCount).toBe(4); expect(c.close).toHaveBeenCalledOnce();
  expect(c.call.mock.calls.filter(([name]) => name === "list_events")[0][1]).toMatchObject({ calendarId: WORK_CALENDAR, timeZone: "Europe/Athens", endTime: "2026-09-18T00:00:00" });
  days.mergeCalendar(result.events);
  expect(days.day("2026-09-10").totals).toMatchObject({ plannedMinutes: 60, reportedMinutes: 60 });
  expect(days.day("2026-09-11").items).toHaveLength(0);
  expect(days.mergeCalendar(result.events).changed).toBe(0);
});

it("rechecks missing events and excludes converted all-day events while preserving manual reports", async () => {
  const { days } = await setup();
  days.mergeCalendar([normalizeCalendarEvent(event("missing"))!, normalizeCalendarEvent(event("converted"))!]);
  let item = days.calendarItems().find(i => i.calendar?.eventId === "converted")!;
  item = days.edit({ id: item.id, revision: item.revision, reportedMinutes: 25, requestId: randomUUID() });
  const c = connection((name) => {
    if (name === "list_calendars") return { calendars: [{ id: WORK_CALENDAR }] };
    if (name === "list_events") return { events: [event("converted", { start: { date: "2026-09-10" }, end: { date: "2026-09-11" } })] };
    throw new Error("HTTP 404 NOT_FOUND");
  });
  days.mergeCalendar((await readCalendar({ ...input(), known: days.calendarItems() }, c.connect)).events);
  expect(days.get(item.id)).toMatchObject({ reportedMinutes: 25, calendar: { status: "excluded" } });
  expect(days.calendarItems().find(i => i.calendar?.eventId === "missing")?.calendar?.status).toBe("cancelled");
  expect(days.report({ date: item.date, period: "day" }).totals).toMatchObject({ plannedMinutes: 0, reportedMinutes: 25 });
});

it("does not infer cancellation or apply a partial batch after a read failure", async () => {
  const { days } = await setup(); days.mergeCalendar([normalizeCalendarEvent(event("missing"))!]);
  const before = days.calendarItems();
  const c = connection(name => {
    if (name === "list_calendars") return { calendars: [{ id: WORK_CALENDAR }] };
    if (name === "list_events") return { events: [event("new")] };
    throw new Error("403 permission denied");
  });
  const runtime = new CalendarRuntime(days, async () => true, data => readCalendar(data, c.connect));
  await runtime.start("2026-09-10"); await runtime.settled();
  expect(days.calendarState()).toMatchObject({ status: "error", message: expect.stringContaining("403") });
  expect(days.calendarItems()).toEqual(before); expect(c.close).toHaveBeenCalledOnce();
});

it("refuses wrong accounts, repeated pages, malformed dates and recurring masters", async () => {
  const wrong = connection(() => ({ calendars: [{ id: "personal@example.com" }] }));
  await expect(readCalendar(input(), wrong.connect)).rejects.toThrow(/does not contain the work calendar/); expect(wrong.close).toHaveBeenCalledOnce();
  const cycle = connection(name => name === "list_calendars" ? { calendars: [{ id: WORK_CALENDAR }] } : { events: [], nextPageToken: "same" });
  await expect(readCalendar(input(), cycle.connect)).rejects.toThrow(/repeats a page/);
  expect(() => normalizeCalendarEvent(event("bad", { start: { dateTime: "2026-09-10T23:30:00" } }))).toThrow();
  expect(() => normalizeCalendarEvent(event("master", { recurrence: ["RRULE:FREQ=WEEKLY"] }))).toThrow(/recurring series/);
  expect(() => normalizeCalendarEvent({ id: "bad" }, normalizeCalendarEvent(event())!)).toThrow(/no start or end time/);
});

it("keeps imported meetings after cancellation or disposal, even if a connector returns late", async () => {
  const { days } = await setup(); days.mergeCalendar([normalizeCalendarEvent(event())!]); const before = days.calendarItems();
  let finish!: (value: Awaited<ReturnType<typeof readCalendar>>) => void;
  const read = vi.fn(() => new Promise<Awaited<ReturnType<typeof readCalendar>>>(resolve => { finish = resolve; }));
  const runtime = new CalendarRuntime(days, async () => true, read), controller = new AbortController();
  await runtime.start("2026-09-10", controller.signal);
  await runtime.start("2026-09-10"); expect(read).toHaveBeenCalledOnce();
  controller.abort(); finish({ events: [normalizeCalendarEvent(event("new"))!], readCount: 1 }); await runtime.settled();
  expect(days.calendarState().status).toBe("idle"); expect(days.calendarItems()).toEqual(before);
  await runtime.start("2026-09-10"); runtime.dispose(); const state = days.calendarState();
  finish({ events: [], readCount: 0 }); await runtime.settled(); expect(days.calendarItems()).toEqual(before); expect(days.calendarState()).toEqual(state);
});

it("imports calendar meetings when source collection fails and starts only once per request", async () => {
  vi.spyOn(collector, "collectSources").mockRejectedValue(new Error("Mail offline"));
  const read = vi.spyOn(reader, "readCalendar").mockResolvedValue({ events: [normalizeCalendarEvent(event())!], readCount: 1 });
  const { f, days } = await setup(); await f.harness.behavior.setSettings({ calendarMeetings: true });
  const start = syncStartSchema.parse({ requestId: randomUUID(), since: null, request: f.startInput("unused", 0).request });
  await f.harness.behavior.callRpc("syncStart", start); await f.harness.behavior.callRpc("syncStart", start);
  await vi.waitFor(() => expect(days.calendarState().status).toBe("complete"));
  expect(read).toHaveBeenCalledOnce(); expect(days.calendarItems()).toHaveLength(1); expect(f.repo.list().total).toBe(0);
});

it("stops the calendar started by a cancelled update check", async () => {
  vi.spyOn(collector, "collectSources").mockImplementation(async (_run, _tasks, options) => new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })));
  let signal!: AbortSignal;
  vi.spyOn(reader, "readCalendar").mockImplementation(async input => new Promise((_, reject) => { signal = input.signal; signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); }));
  const { f, days } = await setup(); await f.harness.behavior.setSettings({ calendarMeetings: true });
  const run = await f.harness.behavior.callRpc("syncStart", { requestId: randomUUID(), since: null, request: f.startInput("unused", 0).request }) as SyncRun;
  await vi.waitFor(() => expect(days.calendarState().status).toBe("running"));
  await f.harness.behavior.callRpc("syncCancel", { runId: run.id });
  await vi.waitFor(() => expect(days.calendarState().status).toBe("idle")); expect(signal.aborted).toBe(true);
});
