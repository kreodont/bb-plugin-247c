// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { rpcContract } from "./contracts.js";
import { DayPlanning } from "./day-planning.js";
import { normalizeCalendarEvent } from "./calendar-reader.js";

let app: CapturedPluginApp;
const mounts: RenderedSlot[] = [], hosts: Awaited<ReturnType<typeof fixture>>[] = [];
beforeAll(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(async () => { for (const slot of mounts.splice(0)) slot.lifecycle.unmount(); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup() {
  const f = await fixture(); hosts.push(f); const task = await f.create(), days = new DayPlanning(f.repo);
  const item = days.add({ date: "2026-09-10", taskId: task.id, requestId: randomUUID() });
  function mount(subPath: string) {
    const rpc = Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
    const slot = renderSlot(app.navPanels[0], { subPath }, { rpc }); mounts.push(slot); return slot;
  }
  return { f, task, days, item, mount };
}

it("shows measured actual, flags estimates in reports, and lets the user confirm reported time", async () => {
  const { task, days, item, mount } = await setup();
  days.reconcileActual([{ taskId: task.id, date: item.date, minutes: 10 }]);
  days.estimate({ id: item.id, revision: days.get(item.id).revision, reportedMinutes: 20, reason: "Review the implementation and verify the results.", requestId: randomUUID() }, "agent-time:test");
  const report = mount(`report/day/${item.date}`);
  expect(await report.findByText(/Reported time includes 1 automatic estimate/)).toBeTruthy();
  expect(report.getByRole("columnheader", { name: "Actual" })).toBeTruthy();
  expect(report.getByText("includes estimate")).toBeTruthy(); report.lifecycle.unmount();
  const slot = mount(`day/${item.date}`);
  const actual = await slot.findByLabelText(`Actual: ${task.title}`);
  expect(actual.textContent).toBe("10m"); expect(actual.tagName).toBe("OUTPUT");
  fireEvent.click(slot.getByRole("button", { name: "Confirm reported" }));
  await waitFor(() => expect(days.get(item.id)).toMatchObject({ actualMinutes: 10, reportedMinutes: 20, reportedMode: "manual", reportedLocked: true }));
  expect(days.report({ date: item.date, period: "day" }).totals.estimatedReported).toBe(0);
  days.reconcileActual([{ taskId: task.id, date: item.date, minutes: 12 }]);
  expect(days.get(item.id).reportedMinutes).toBe(20);
});

it("saves manual reported time above measured actual without a cap warning, including after reopening", async () => {
  const { task, days, item, mount } = await setup();
  days.reconcileActual([{ taskId: task.id, date: item.date, minutes: 10 }]);
  const slot = mount(`day/${item.date}`), reported = await slot.findByLabelText(`Reported: ${task.title}`);
  fireEvent.change(reported, { target: { value: "31m" } }); fireEvent.click(slot.getByRole("button", { name: "Save time" }));
  await waitFor(() => expect(days.get(item.id)).toMatchObject({ reportedMinutes: 31, reportedMode: "manual", reportedLocked: true }));
  await waitFor(() => expect(slot.queryByText("Unsaved edit")).toBeNull());
  expect((reported as HTMLInputElement).value).toBe("31m");
  expect(slot.queryByText(/Saved manual time exceeds|Reported time cannot exceed/)).toBeNull();
  slot.lifecycle.unmount();
  days.reconcileActual([{ taskId: task.id, date: item.date, minutes: 5 }]);
  const reopened = mount(`day/${item.date}`);
  expect((await reopened.findByLabelText(`Reported: ${task.title}`) as HTMLInputElement).value).toBe("31m");
  expect(reopened.queryByText(/Saved manual time exceeds|Reported time cannot exceed/)).toBeNull();
});

it("requests a new AI estimate without manufacturing a value or offering to confirm a blank", async () => {
  const { task, days, item, mount } = await setup();
  days.reconcileActual([{ taskId: task.id, date: item.date, minutes: 10 }]);
  days.edit({ id: item.id, revision: days.get(item.id).revision, reportedMinutes: 90, requestId: randomUUID() });
  const slot = mount(`day/${item.date}`);
  fireEvent.click(await slot.findByRole("button", { name: "Details" }));
  fireEvent.click(slot.getByRole("button", { name: "Request AI estimate" }));
  await waitFor(() => expect(days.get(item.id)).toMatchObject({ reportedMinutes: null, reportedLocked: false, reportedEstimate: null }));
  await slot.findByText("awaiting AI estimate");
  expect(slot.queryByRole("button", { name: "Confirm reported" })).toBeNull();
  expect(days.report({ date: item.date, period: "day" }).totals.estimatedReported).toBe(0);
});

it.each(["Back", "Forward"] as const)("saves time and day settings before %s traverses history", async direction => {
  vi.stubGlobal("navigation", Object.assign(new EventTarget(), { canGoBack: true, canGoForward: true }));
  const { task, days, item, mount } = await setup(); const slot = mount("day/2026-09-10");
  const traverse = vi.spyOn(window.history, direction === "Back" ? "back" : "forward").mockImplementation(() => {
    expect(days.get(item.id)).toMatchObject({ plannedMinutes: 15, reportedMinutes: 30 });
    expect(days.config("2026-09-10").capacityMinutes).toBe(300);
  });
  fireEvent.change(await slot.findByLabelText(`Planned: ${task.title}`), { target: { value: "15m" } });
  fireEvent.change(slot.getByLabelText(`Reported: ${task.title}`), { target: { value: "30m" } });
  fireEvent.click(slot.getByText("Day settings"));
  fireEvent.change(slot.getByLabelText("Available time"), { target: { value: "5h" } });
  fireEvent.click(slot.getByRole("button", { name: direction }));
  await waitFor(() => expect(traverse).toHaveBeenCalledOnce());
});

it("keeps a conflicting time edit on the page when Back is clicked", async () => {
  vi.stubGlobal("navigation", Object.assign(new EventTarget(), { canGoBack: true, canGoForward: true }));
  const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
  const { task, days, item, mount } = await setup(); const slot = mount("day/2026-09-10");
  fireEvent.change(await slot.findByLabelText(`Reported: ${task.title}`), { target: { value: "3h" } });
  days.edit({ id: item.id, revision: item.revision, reportedMinutes: 20, requestId: randomUUID() });
  await slot.behavior.emitRealtime("desk-changed", {});
  fireEvent.click(slot.getByRole("button", { name: "Back" }));
  await slot.findByRole("alert");
  expect(back).not.toHaveBeenCalled();
  expect(days.get(item.id).reportedMinutes).toBe(20);
  expect((slot.getByLabelText(`Reported: ${task.title}`) as HTMLInputElement).value).toBe("3h");
});

it("saves 10 minutes planned and 3 hours reported before opening a task and returning to the same day", async () => {
  const { f, task, days, item, mount } = await setup(); const original = f.repo.detail(task.id);
  const slot = mount("day/2026-09-10");
  fireEvent.change(await slot.findByLabelText(`Planned: ${task.title}`), { target: { value: "10m" } });
  fireEvent.change(slot.getByLabelText(`Reported: ${task.title}`), { target: { value: "3h" } });
  fireEvent.click(slot.getByRole("button", { name: task.title }));
  await waitFor(() => expect(JSON.stringify(slot.inspection.navigateCalls)).toContain(`${task.id}/from/day/2026-09-10`));
  expect(days.get(item.id)).toMatchObject({ plannedMinutes: 10, reportedMinutes: 180 }); expect(f.repo.detail(task.id)).toEqual(original);
  slot.lifecycle.unmount();
  const dossier = mount(`${task.id}/from/day/2026-09-10`);
  await dossier.findByRole("heading", { name: task.title });
  expect(await dossier.findByText("Planned: 10m · Actual: 0m · Reported: 3h")).toBeTruthy();
  fireEvent.click(dossier.getByRole("button", { name: "Back to day plan" }));
  expect(JSON.stringify(dossier.inspection.navigateCalls)).toContain("day/2026-09-10");
  dossier.lifecycle.unmount(); const returned = mount("day/2026-09-10");
  expect((await returned.findByLabelText(`Reported: ${task.title}`) as HTMLInputElement).value).toBe("3h");
  expect((returned.getByLabelText("Plan date") as HTMLInputElement).value).toBe("2026-09-10");
});

it("keeps a conflicting draft, blocks navigation, and applies it only after the explicit overwrite action", async () => {
  const { task, days, item, mount } = await setup(); const slot = mount("day/2026-09-10");
  fireEvent.change(await slot.findByLabelText(`Reported: ${task.title}`), { target: { value: "3h" } });
  days.edit({ id: item.id, revision: item.revision, plannedMinutes: 10, reportedMinutes: 20, requestId: randomUUID() });
  await act(async () => { await slot.behavior.emitRealtime("desk-changed", {}); });
  fireEvent.click(slot.getByRole("button", { name: task.title }));
  await slot.findByRole("alert");
  expect(slot.inspection.navigateCalls).toHaveLength(0); expect((slot.getByLabelText(`Reported: ${task.title}`) as HTMLInputElement).value).toBe("3h");
  fireEvent.click(await slot.findByRole("button", { name: "Apply my edit" }));
  await waitFor(() => expect(days.get(item.id)).toMatchObject({ plannedMinutes: 10, reportedMinutes: 180 }));
  await waitFor(() => expect(slot.queryByText("Unsaved edit")).toBeNull());
});

it("lets a validation error be corrected and flushes day parameters when the date changes", async () => {
  const { days, mount } = await setup(); const slot = mount("day/2026-09-10");
  fireEvent.click(await slot.findByText("Day settings"));
  fireEvent.change(slot.getByLabelText("Available time"), { target: { value: "-2" } });
  fireEvent.click(slot.getByRole("button", { name: "Save day" })); await slot.findByRole("alert");
  fireEvent.change(slot.getByLabelText("Available time"), { target: { value: "5h" } });
  fireEvent.click(slot.getByRole("button", { name: "Next day" }));
  await waitFor(() => expect(JSON.stringify(slot.inspection.navigateCalls)).toContain("day/2026-09-11"));
  expect(days.config("2026-09-10").capacityMinutes).toBe(300);
});

it("overrides a meeting manually, preserves it through calendar changes and restores each field separately", async () => {
  const { days, mount } = await setup();
  const event = normalizeCalendarEvent({ id: "meeting", summary: "Work meeting", start: { dateTime: "2026-09-10T08:00:00Z" }, end: { dateTime: "2026-09-10T08:30:00Z" } })!;
  days.mergeCalendar([event]); const id = days.calendarItems()[0].id;
  const slot = mount("day/2026-09-10"); const row = within(await slot.findByRole("article", { name: "Day entry: Work meeting" }));
  fireEvent.change(row.getByLabelText("Planned: Work meeting"), { target: { value: "45m" } });
  fireEvent.change(row.getByLabelText("Reported: Work meeting"), { target: { value: "20m" } });
  fireEvent.click(row.getByRole("button", { name: "Details" }));
  fireEvent.click(row.getByRole("button", { name: "Did not attend" }));
  await waitFor(() => expect(days.get(id)).toMatchObject({ plannedMinutes: 45, reportedMinutes: 0, reportedMode: "manual" }));
  await waitFor(() => expect(row.queryByText("Unsaved edit")).toBeNull());
  days.mergeCalendar([{ ...event, endAt: "2026-09-10T09:00:00Z" }]); await slot.behavior.emitRealtime("desk-changed", {});
  await waitFor(() => expect((row.getByLabelText("Reported: Work meeting") as HTMLInputElement).value).toBe("0m"));
  fireEvent.click(row.getByRole("button", { name: "Planned from calendar" }));
  await waitFor(() => expect(days.get(id)).toMatchObject({ plannedMinutes: 60, reportedMinutes: 0 }));
  await waitFor(() => expect((row.getByRole("button", { name: "Automatic reported time" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(row.getByRole("button", { name: "Automatic reported time" }));
  await waitFor(() => expect(days.get(id)).toMatchObject({ reportedMinutes: 60, reportedMode: "calendar" }));
});

it("opens report task titles with the report return route and day entries for corrections", async () => {
  const { days, task, item, mount } = await setup(); days.edit({ id: item.id, revision: item.revision, plannedMinutes: 10, reportedMinutes: 180, requestId: randomUUID() });
  const report = mount("report/week/2026-09-10");
  fireEvent.click(await report.findByRole("button", { name: task.title }));
  await waitFor(() => expect(JSON.stringify(report.inspection.navigateCalls)).toContain(`${task.id}/from/report/week/2026-09-10`));
  fireEvent.click(report.getByRole("button", { name: /10 Sept.*reported 3h/ }));
  await waitFor(() => expect(JSON.stringify(report.inspection.navigateCalls)).toContain('"day/2026-09-10"'));
});
