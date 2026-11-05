import { expect, it } from "vitest";
import { withCalendarHealth } from "./calendar-health.js";
import { emptyUpdaterHealth } from "./updater-health.js";
import { CalendarRuntime } from "./calendar-runtime.js";
import { DayPlanning } from "./day-planning.js";
import { fixture } from "./test-support.js";

const failed = { status: "error" as const, startedAt: "2026-11-05T15:00:00Z", completedAt: "2026-11-05T14:02:00Z",
  message: "Calendar reader failed", events: 24, from: "2026-11-02", through: "2026-11-12" };

it.each(["healthy", "waiting", "disabled"] as const)("surfaces calendar failures when sources are %s", status => {
  const source = { ...emptyUpdaterHealth(0), status, alert: status === "waiting" };
  const result = withCalendarHealth(source, failed, true);
  expect(result).toMatchObject({ status: "attention", configured: true, alert: true, calendarAlert: true, title: "Work calendar needs attention" });
  expect(result.calendar?.completedAt).toBe(failed.completedAt);
  expect(withCalendarHealth(source, failed, false)).toMatchObject({ calendarAlert: false, alert: source.alert, status });
});

it("preserves simultaneous source errors and clears the calendar alert only after recovery", () => {
  const source = { ...emptyUpdaterHealth(0), status: "paused" as const, alert: true, title: "Updater paused", detail: "Source failure", incidentId: "source-1" };
  const result = withCalendarHealth(source, failed, true);
  expect(result).toMatchObject({ title: source.title, detail: source.detail, calendarAlert: true });
  const retry = { ...failed, status: "running" as const, startedAt: "2026-11-05T16:00:00Z", message: null, lastError: failed.message, errorSince: failed.startedAt };
  expect(withCalendarHealth(source, retry, true).incidentId).toBe(result.incidentId);
  expect(withCalendarHealth(source, { ...retry, status: "complete", lastError: null, errorSince: null }, true)).toMatchObject({ calendarAlert: false, alert: true, incidentId: "source-1" });
});

it("keeps the calendar incident through retries, returns it over RPC and clears it on a successful merge", async () => {
  const f = await fixture();
  try {
    await f.harness.behavior.setSettings({ calendarMeetings: true });
    const days = new DayPlanning(f.repo);
    days.saveCalendarState(failed);
    expect(await f.harness.behavior.callRpc("updaterHealth", {})).toMatchObject({ calendarAlert: true, alert: true, calendar: failed });
    let finish!: (value: { events: []; readCount: number }) => void;
    const runtime = new CalendarRuntime(days, async () => true, () => new Promise(resolve => { finish = resolve; }));
    await runtime.start("2026-11-05");
    expect(days.calendarState()).toMatchObject({ status: "running", lastError: failed.message, errorSince: failed.startedAt, completedAt: failed.completedAt });
    expect(await f.harness.behavior.callRpc("updaterHealth", {})).toMatchObject({ calendarAlert: true });
    finish({ events: [], readCount: 0 }); await runtime.settled();
    expect(days.calendarState()).toMatchObject({ status: "complete", lastError: null, errorSince: null });
    expect(await f.harness.behavior.callRpc("updaterHealth", {})).toMatchObject({ calendarAlert: false });
    runtime.dispose();
  } finally { await f.harness.lifecycle.dispose(); }
});
