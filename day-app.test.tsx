// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { rpcContract } from "./contracts.js";
import { DayPlanning } from "./day-planning.js";
import { localDay, shiftDay } from "./day-contracts.js";
import { normalizeCalendarEvent } from "./calendar-reader.js";
const DAY_SORT_KEY = "247c:day-sort";

let app: CapturedPluginApp;
const mounts: RenderedSlot[] = [], hosts: Awaited<ReturnType<typeof fixture>>[] = [];
beforeAll(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(async () => { for (const slot of mounts.splice(0)) slot.lifecycle.unmount(); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.removeItem(DAY_SORT_KEY); });
async function setup() {
  const f = await fixture(); hosts.push(f); const task = await f.create(), days = new DayPlanning(f.repo);
  const item = days.add({ date: "2026-09-10", taskId: task.id, requestId: randomUUID() });
  function mount(subPath: string, overrides: Record<string, (input: any) => unknown> = {}) {
    const rpc = { ...Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)])), ...overrides };
    const slot = renderSlot(app.navPanels[0], { subPath }, { rpc }); mounts.push(slot); return slot;
  }
  return { f, task, days, item, mount };
}

const plannerRun = { id: "run_plan", status: "running" as const, startedAt: Date.now(), finishedAt: null, error: null, skipReason: null };
const plannerState = { configured: true, today: localDay(), name: "Work planner", scheduled: true, nextRunAt: Date.now() + 60000, run: null };

it.each(["updates", "day/2026-09-10"])("checks the calendar from %s with a JSON-safe date input", async path => {
  const { days, mount } = await setup();
  const expected = path === "updates" ? {} : { date: "2026-09-10" };
  const sync = vi.fn((input: unknown) => {
    expect(input).toStrictEqual(expected);
    expect(input).toStrictEqual(JSON.parse(JSON.stringify(input)));
    return days.calendarState();
  });
  const slot = mount(path, { calendarSync: sync });
  fireEvent.click(await slot.findByRole("button", { name: "Check calendar" }));
  await waitFor(() => expect(sync).toHaveBeenCalledOnce());
  expect(sync.mock.calls[0][0]).toStrictEqual(expected);
  await waitFor(() => expect(slot.queryByRole("alert")).toBeNull());
});

it("always sorts tasks and meetings by reported, ignoring old browser preferences", async () => {
  const { f, task, days, item, mount } = await setup();
  const other = await f.harness.behavior.callRpc("create", { title: "Long task", requestId: randomUUID() }) as { id: string };
  days.edit({ id: item.id, revision: item.revision, plannedMinutes: 120, reportedMinutes: 5, requestId: randomUUID() });
  days.add({ date: item.date, taskId: other.id, plannedMinutes: 9, reportedMinutes: 60, requestId: randomUUID() });
  days.mergeCalendar([normalizeCalendarEvent({ id: "meeting", summary: "Work meeting", start: { dateTime: "2026-09-10T08:00:00Z" }, end: { dateTime: "2026-09-10T08:30:00Z" } })!]);
  const before = days.day(item.date);
  window.localStorage.setItem(DAY_SORT_KEY, "planned-desc");
  const slot = mount(`day/${item.date}`);
  await slot.findByText("Reported: longest first");
  const expected = ["Day entry: Long task", "Day entry: Work meeting", `Day entry: ${task.title}`];
  expect(slot.getAllByRole("article").map(row => row.getAttribute("aria-label"))).toEqual(expected);
  expect(slot.queryByRole("combobox", { name: "Sort day tasks" })).toBeNull();
  fireEvent.click(within(slot.getAllByRole("article")[0]).getByRole("button", { name: "Details" }));
  expect(slot.queryByRole("button", { name: "Move up" })).toBeNull();
  expect(days.day(item.date)).toEqual(before);
  expect(slot.inspection.rpcCalls.some(call => ["dayReorder", "dayEdit"].includes(call.method))).toBe(false);
  slot.lifecycle.unmount();
  const reopened = mount(`day/${item.date}`);
  await reopened.findByText("Reported: longest first");
  expect(reopened.getAllByRole("article").map(row => row.getAttribute("aria-label"))).toEqual(expected);
});

it("keeps the same editor and pending save when duration sorting moves its row", async () => {
  const { f, task, days, item, mount } = await setup();
  const other = await f.harness.behavior.callRpc("create", { title: "Short task", requestId: randomUUID() }) as { id: string };
  days.edit({ id: item.id, revision: item.revision, reportedMinutes: 5, requestId: randomUUID() });
  days.add({ date: item.date, taskId: other.id, reportedMinutes: 30, requestId: randomUUID() });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const edit = vi.fn(async input => { await gate; return days.edit(input); });
  const slot = mount(`day/${item.date}`, { dayEdit: edit });
  const input = await slot.findByLabelText(`Reported: ${task.title}`) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "45m" } });
  fireEvent.blur(input);
  await waitFor(() => expect(edit).toHaveBeenCalledOnce());
  expect(slot.getAllByRole("article")[1].getAttribute("aria-label")).toBe(`Day entry: ${task.title}`);
  expect(slot.getByLabelText(`Reported: ${task.title}`)).toBe(input);
  expect(input.value).toBe("45m");
  await act(async () => release());
  await waitFor(() => expect(days.get(item.id).reportedMinutes).toBe(45));
  await waitFor(() => expect(slot.queryByText("Saving…")).toBeNull());
  expect(edit).toHaveBeenCalledOnce();
  expect(slot.getAllByRole("article")[0].getAttribute("aria-label")).toBe(`Day entry: ${task.title}`);
  expect(slot.getByLabelText(`Reported: ${task.title}`)).toBe(input);
  expect(input.value).toBe("45m");
});

it.each([false, true])("saves day edits before opening a task chat (existing session: %s)", async existing => {
  const { f, task, days, item, mount } = await setup();
  await f.harness.behavior.setSettings({ workProvider: "claude-work", workModel: "claude-opus-5[1m]" });
  const session = existing ? await f.start(task.id, task.revision) : null;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const edit = vi.fn(async input => { if (edit.mock.calls.length === 1) await gate; return days.edit(input); });
  const slot = mount(`day/${item.date}/thread/thr_origin`, { dayEdit: edit });
  const input = await slot.findByLabelText(`Reported: ${task.title}`);
  fireEvent.change(input, { target: { value: "10m" } });
  const chat = slot.getByRole("button", { name: existing ? "Open chat" : "New chat" });
  fireEvent.click(chat); fireEvent.click(chat);
  await waitFor(() => expect(edit).toHaveBeenCalledOnce());
  expect(slot.inspection.navigateCalls).toHaveLength(0);
  fireEvent.change(input, { target: { value: "35m" } });
  await act(async () => { release(); });
  await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(1));
  expect(days.get(item.id).reportedMinutes).toBe(35);
  expect(slot.inspection.rpcCalls.filter(c => c.method === "openChat")).toHaveLength(1);
  expect(JSON.stringify(slot.inspection.navigateCalls)).toContain(session?.workerThreadId ?? f.repo.sessions(task.id)[0].workerThreadId);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

it("keeps conflicting time visible instead of leaving Day for a new chat", async () => {
  const { task, days, item, mount } = await setup();
  const slot = mount(`day/${item.date}`);
  const input = await slot.findByLabelText(`Reported: ${task.title}`) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "1h" } });
  days.edit({ id: item.id, revision: item.revision, reportedMinutes: 10, requestId: randomUUID() });
  fireEvent.click(slot.getByRole("button", { name: "New chat" }));
  await slot.findByRole("alert");
  expect(slot.inspection.navigateCalls).toHaveLength(0);
  expect(slot.inspection.rpcCalls.some(c => c.method === "openChat")).toBe(false);
  expect(input.value).toBe("1h");
  expect(days.get(item.id).reportedMinutes).toBe(10);
});

it("opens a chat created in another window after the day was loaded", async () => {
  const { f, task, item, mount } = await setup();
  const slot = mount(`day/${item.date}`);
  const button = await slot.findByRole("button", { name: "New chat" });
  const session = await f.start(task.id, task.revision);
  fireEvent.click(button);
  await waitFor(() => expect(JSON.stringify(slot.inspection.navigateCalls)).toContain(session.workerThreadId));
  expect(f.repo.sessions(task.id)).toHaveLength(1);
  await slot.behavior.emitRealtime("desk-changed", {});
  expect(await slot.findByRole("button", { name: "Open chat" })).toBeTruthy();
});

it("saves day edits before one launch and refreshes saved entries when the run finishes", async () => {
  const { task, days, mount } = await setup(); const date = localDay();
  const item = days.add({ date, taskId: task.id, requestId: randomUUID() });
  let state: { run: typeof plannerRun | (Omit<typeof plannerRun, "status" | "finishedAt"> & { status: "succeeded"; finishedAt: number }) | null } & Omit<typeof plannerState, "run"> = { ...plannerState };
  let finishLaunch!: (value: typeof plannerRun) => void;
  const start = vi.fn(async () => {
    expect(days.get(item.id).plannedMinutes).toBe(15);
    expect(days.config(date).capacityMinutes).toBe(240);
    return new Promise<typeof plannerRun>(resolve => { finishLaunch = resolve; });
  });
  const slot = mount(`day/${date}`, { dayPlannerState: () => state, dayPlannerStart: start });
  fireEvent.change(await slot.findByLabelText(`Planned: ${task.title}`), { target: { value: "15m" } });
  fireEvent.click(slot.getByText("Day settings"));
  fireEvent.change(slot.getByLabelText("Available time"), { target: { value: "4h" } });
  const button = await slot.findByRole("button", { name: "Create day plan" });
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(start).toHaveBeenCalledOnce());
  await act(async () => { state = { ...state, run: plannerRun }; finishLaunch(plannerRun); });
  expect((await slot.findByRole("button", { name: "Creating plan…" }) as HTMLButtonElement).disabled).toBe(true);
  days.edit({ id: item.id, revision: days.get(item.id).revision, plannedMinutes: 45, requestId: randomUUID() });
  state = { ...state, run: { ...plannerRun, status: "succeeded", finishedAt: Date.now() } };
  await slot.behavior.emitRealtime("desk-changed", {});
  await slot.findByText(/Day planning finished/);
  await waitFor(() => expect((slot.getByLabelText(`Planned: ${task.title}`) as HTMLInputElement).value).toBe("45m"));
  expect(start).toHaveBeenCalledOnce();
});

it("keeps the same launch key after an uncertain network failure and shows failure details", async () => {
  const { mount } = await setup();
  const start = vi.fn().mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce({ ...plannerRun, status: "failed", error: "Work account needs sign-in" });
  const slot = mount(`day/${localDay()}`, { dayPlannerState: () => plannerState, dayPlannerStart: start });
  fireEvent.click(await slot.findByRole("button", { name: "Create day plan" }));
  await slot.findByText("Connection lost");
  fireEvent.click(slot.getByRole("button", { name: "Create day plan" }));
  await slot.findByText("Work account needs sign-in");
  expect(start.mock.calls[0][0]).toEqual(start.mock.calls[1][0]);
});

it("blocks planner launch on a conflicting day edit", async () => {
  const { days, mount } = await setup(); const date = localDay(), start = vi.fn();
  const slot = mount(`day/${date}`, { dayPlannerState: () => plannerState, dayPlannerStart: start });
  fireEvent.click(await slot.findByText("Day settings"));
  fireEvent.change(slot.getByLabelText("Available time"), { target: { value: "4h" } });
  days.setConfig({ date, revision: 0, capacityMinutes: 180, note: "Another edit", requestId: randomUUID() });
  fireEvent.click(await slot.findByRole("button", { name: "Create day plan" }));
  await slot.findByRole("alert");
  expect(start).not.toHaveBeenCalled();
  expect((slot.getByLabelText("Available time") as HTMLInputElement).value).toBe("4h");
});

it("disables launch for other dates and hides it when unconfigured or viewing a report", async () => {
  const { mount } = await setup();
  const slot = mount(`day/${shiftDay(localDay(), 1)}`, { dayPlannerState: () => plannerState });
  expect((await slot.findByRole("button", { name: "Create day plan" }) as HTMLButtonElement).disabled).toBe(true);
  expect(slot.getByText("Open Today to create a day plan.")).toBeTruthy(); slot.lifecycle.unmount();
  const plain = mount(`day/${localDay()}`); await plain.findByText("Day settings");
  expect(plain.queryByRole("button", { name: "Create day plan" })).toBeNull(); plain.lifecycle.unmount();
  const report = mount(`report/day/${localDay()}`, { dayPlannerState: () => plannerState }); await report.findByRole("heading", { name: "Time report" });
  expect(report.queryByRole("button", { name: "Create day plan" })).toBeNull();
});

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
  fireEvent.change(reported, { target: { value: "31m" } }); fireEvent.blur(reported);
  await waitFor(() => expect(days.get(item.id)).toMatchObject({ reportedMinutes: 31, reportedMode: "manual", reportedLocked: true }));
  await waitFor(() => expect(slot.queryByText("Saving…")).toBeNull());
  expect((reported as HTMLInputElement).value).toBe("31m");
  expect(slot.queryByText(/Saved manual time exceeds|Reported time cannot exceed/)).toBeNull();
  slot.lifecycle.unmount();
  days.reconcileActual([{ taskId: task.id, date: item.date, minutes: 5 }]);
  const reopened = mount(`day/${item.date}`);
  expect((await reopened.findByLabelText(`Reported: ${task.title}`) as HTMLInputElement).value).toBe("31m");
  expect(reopened.queryByText(/Saved manual time exceeds|Reported time cannot exceed/)).toBeNull();
});

it("opens the task's selected day, focuses reported time and saves before returning to the originating thread", async () => {
  const { f, task, days, item, mount } = await setup();
  const original = f.repo.detail(task.id), threadId = "thr_original";
  days.edit({ id: item.id, revision: item.revision, plannedMinutes: 45, reportedMinutes: 20, requestId: randomUUID() });
  const dossier = mount(`${task.id}/thread/${threadId}`);
  const dateInput = await dossier.findByLabelText("Schedule task for a date");
  fireEvent.change(dateInput, { target: { value: item.date } });
  fireEvent.click(dossier.getByRole("button", { name: "Log time" }));
  const path = `day/${item.date}/task/${task.id}/thread/${threadId}`;
  await waitFor(() => expect(JSON.stringify(dossier.inspection.navigateCalls)).toContain(path));
  expect(dossier.inspection.rpcCalls.some(call => call.method === "dayAdd")).toBe(false);
  dossier.lifecycle.unmount();
  const day = mount(path), reported = await day.findByLabelText(`Reported: ${task.title}`);
  await waitFor(() => expect(document.activeElement).toBe(reported));
  expect((reported as HTMLInputElement).value).toBe("20m");
  fireEvent.change(reported, { target: { value: "1h" } });
  fireEvent.click(day.getByRole("button", { name: "Return to thread" }));
  await waitFor(() => expect(JSON.stringify(day.inspection.navigateCalls)).toContain(threadId));
  expect(days.get(item.id)).toMatchObject({ reportedMinutes: 60, plannedMinutes: 45 });
  expect(day.inspection.rpcCalls.some(call => call.method === "dayEdit")).toBe(true);
  expect(f.repo.detail(task.id)).toEqual(original);
});

it("adds an unplanned task only on Log time and preserves the origin when browsing dates and the dossier", async () => {
  const { task, days, mount } = await setup(), date = "2026-09-11", threadId = "thr_time";
  const dossier = mount(`${task.id}/thread/${threadId}`);
  fireEvent.change(await dossier.findByLabelText("Schedule task for a date"), { target: { value: date } });
  expect(days.taskItem(task.id, date)).toBeNull();
  fireEvent.click(dossier.getByRole("button", { name: "Log time" }));
  const path = `day/${date}/task/${task.id}/thread/${threadId}`;
  await waitFor(() => expect(JSON.stringify(dossier.inspection.navigateCalls)).toContain(path));
  expect(days.taskItem(task.id, date)).toMatchObject({ plannedMinutes: 0, reportedMinutes: null });
  dossier.lifecycle.unmount();
  const day = mount(path); await day.findByLabelText(`Reported: ${task.title}`);
  fireEvent.click(day.getByRole("button", { name: "Next day" }));
  await waitFor(() => expect(JSON.stringify(day.inspection.navigateCalls)).toContain(`day/2026-09-12/task/${task.id}/thread/${threadId}`));
  expect(days.taskItem(task.id, "2026-09-12")).toBeNull();
  fireEvent.click(day.getByRole("button", { name: task.title }));
  const taskPath = `${task.id}/from/day/${date}/task/${task.id}/thread/${threadId}`;
  await waitFor(() => expect(JSON.stringify(day.inspection.navigateCalls)).toContain(taskPath));
  day.lifecycle.unmount();
  const returned = mount(taskPath);
  expect((await returned.findByLabelText("Schedule task for a date") as HTMLInputElement).value).toBe(date);
  fireEvent.click(returned.getByRole("button", { name: "Back to day plan" }));
  expect(JSON.stringify(returned.inspection.navigateCalls)).toContain(path);
  fireEvent.click(returned.getByRole("button", { name: "Return to thread" }));
  await waitFor(() => expect(JSON.stringify(returned.inspection.navigateCalls)).toContain(threadId));
});

it("keeps an unsaved conflicting edit visible instead of returning to the thread", async () => {
  const { task, days, item, mount } = await setup();
  const slot = mount(`day/${item.date}/task/${task.id}/thread/thr_original`);
  fireEvent.change(await slot.findByLabelText(`Reported: ${task.title}`), { target: { value: "1h" } });
  days.edit({ id: item.id, revision: item.revision, reportedMinutes: 10, requestId: randomUUID() });
  await slot.behavior.emitRealtime("desk-changed", {});
  fireEvent.click(slot.getByRole("button", { name: "Return to thread" }));
  await slot.findByRole("alert");
  expect(slot.inspection.navigateCalls).toHaveLength(0);
  expect((slot.getByLabelText(`Reported: ${task.title}`) as HTMLInputElement).value).toBe("1h");
  expect(days.get(item.id).reportedMinutes).toBe(10);
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
  await waitFor(() => expect(slot.queryByText("Saving…")).toBeNull());
});

it("lets a validation error be corrected and flushes day parameters when the date changes", async () => {
  const { days, mount } = await setup(); const slot = mount("day/2026-09-10");
  fireEvent.click(await slot.findByText("Day settings"));
  fireEvent.change(slot.getByLabelText("Available time"), { target: { value: "-2" } });
  fireEvent.blur(slot.getByLabelText("Available time")); await slot.findByRole("alert");
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
  expect(row.queryByRole("button", { name: /^(New|Open) chat$/ })).toBeNull();
  fireEvent.change(row.getByLabelText("Planned: Work meeting"), { target: { value: "45m" } });
  fireEvent.change(row.getByLabelText("Reported: Work meeting"), { target: { value: "20m" } });
  fireEvent.click(row.getByRole("button", { name: "Details" }));
  fireEvent.click(row.getByRole("button", { name: "Did not attend" }));
  await waitFor(() => expect(days.get(id)).toMatchObject({ plannedMinutes: 45, reportedMinutes: 0, reportedMode: "manual" }));
  await waitFor(() => expect(row.queryByText("Saving…")).toBeNull());
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

it("preserves a time draft when refreshing installation settings temporarily fails", async () => {
  const { f, task, item, mount } = await setup();
  let unavailable = false;
  const slot = mount(`day/${item.date}`, { threadProject: async () => {
    if (unavailable) throw new Error("Settings temporarily unavailable");
    return f.harness.behavior.callRpc("threadProject", {});
  } });
  fireEvent.change(await slot.findByLabelText(`Reported: ${task.title}`), { target: { value: "1h" } });
  unavailable = true;
  await slot.behavior.emitRealtime("desk-changed", {});
  await slot.findByText("Settings temporarily unavailable");
  expect((slot.getByLabelText(`Reported: ${task.title}`) as HTMLInputElement).value).toBe("1h");
});

it("autosaves time after a pause without losing focus and keeps blank distinct from zero", async () => {
  const { task, days, item, mount } = await setup();
  const slot = mount(`day/${item.date}`), input = await slot.findByLabelText(`Reported: ${task.title}`) as HTMLInputElement;
  input.focus();
  fireEvent.change(input, { target: { value: "60" } });
  expect(slot.queryByRole("button", { name: "Save time" })).toBeNull();
  expect(days.get(item.id).reportedMinutes).toBeNull();
  await waitFor(() => expect(days.get(item.id).reportedMinutes).toBe(60), { timeout: 3000 });
  await slot.findByText("Saved");
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("60");
  expect(input.disabled).toBe(false);
  fireEvent.change(input, { target: { value: "0" } }); fireEvent.blur(input);
  await waitFor(() => expect(days.get(item.id).reportedMinutes).toBe(0));
  await slot.findByText("Saved");
  fireEvent.change(input, { target: { value: "" } }); fireEvent.blur(input);
  await waitFor(() => expect(days.get(item.id)).toMatchObject({ reportedMinutes: null, reportedLocked: true }));
});

it("saves edits typed during a request before allowing navigation", async () => {
  const { task, days, item, mount } = await setup();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const edit = vi.fn(async input => { if (edit.mock.calls.length === 1) await gate; return days.edit(input); });
  const slot = mount(`day/${item.date}`, { dayEdit: edit });
  const input = await slot.findByLabelText(`Reported: ${task.title}`) as HTMLInputElement;
  input.focus(); fireEvent.change(input, { target: { value: "10m" } });
  await waitFor(() => expect(edit).toHaveBeenCalledOnce(), { timeout: 3000 });
  expect(input.disabled).toBe(false); expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "35m" } });
  fireEvent.change(slot.getByLabelText(`Planned: ${task.title}`), { target: { value: "1h" } });
  fireEvent.click(slot.getByRole("button", { name: "Next day" }));
  expect(slot.inspection.navigateCalls).toHaveLength(0);
  await act(async () => { release(); });
  await waitFor(() => expect(slot.inspection.navigateCalls.length).toBeGreaterThan(0));
  expect(days.get(item.id)).toMatchObject({ reportedMinutes: 35, plannedMinutes: 60 });
  expect(edit).toHaveBeenCalledTimes(2);
  expect(edit.mock.calls[1][0].revision).toBe(item.revision + 1);
});

it("retains a failed autosave and retries an uncertain result with the same request ID", async () => {
  const { task, days, item, mount } = await setup();
  const edit = vi.fn(async input => {
    const result = days.edit(input);
    if (edit.mock.calls.length === 1) throw new Error("Connection lost after save");
    return result;
  });
  const slot = mount(`day/${item.date}`, { dayEdit: edit });
  const input = await slot.findByLabelText(`Reported: ${task.title}`) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "25m" } }); fireEvent.blur(input);
  await slot.findByText("Connection lost after save");
  expect(input.value).toBe("25m"); expect(slot.getByText("Not saved")).toBeTruthy();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 750)); });
  expect(edit).toHaveBeenCalledOnce();
  fireEvent.click(slot.getByRole("button", { name: "Retry save" }));
  await slot.findByText("Saved");
  expect(edit.mock.calls[0][0]).toEqual(edit.mock.calls[1][0]);
  expect(days.get(item.id)).toMatchObject({ reportedMinutes: 25, revision: item.revision + 1 });
});

it("keeps invalid time visible and autosaves its correction", async () => {
  const { task, days, item, mount } = await setup();
  const slot = mount(`day/${item.date}`), input = await slot.findByLabelText(`Planned: ${task.title}`) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "-5" } }); fireEvent.blur(input);
  await slot.findByRole("alert"); expect(input.value).toBe("-5");
  expect(days.get(item.id).plannedMinutes).toBeNull();
  fireEvent.change(input, { target: { value: "45m" } });
  await waitFor(() => expect(days.get(item.id).plannedMinutes).toBe(45), { timeout: 3000 });
  await slot.findByText("Saved"); expect(slot.queryByRole("alert")).toBeNull();
});

it("autosaves available time and preserves day notes typed while saving", async () => {
  const { days, item, mount } = await setup();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const saveConfig = vi.fn(async input => { if (saveConfig.mock.calls.length === 1) await gate; return days.setConfig(input); });
  const slot = mount(`day/${item.date}`, { dayConfig: saveConfig });
  fireEvent.click(await slot.findByText("Day settings"));
  fireEvent.change(slot.getByLabelText("Available time"), { target: { value: "4h" } });
  await waitFor(() => expect(saveConfig).toHaveBeenCalledOnce(), { timeout: 3000 });
  fireEvent.change(slot.getByLabelText("Day note"), { target: { value: "Focus on review" } });
  await act(async () => { release(); });
  await slot.findByText("Saved");
  expect(days.config(item.date)).toMatchObject({ capacityMinutes: 240, note: "Focus on review" });
  expect(saveConfig).toHaveBeenCalledTimes(2);
});

it("refreshes a focused clean field when its saved value changes elsewhere", async () => {
  const { task, days, item, mount } = await setup();
  const slot = mount(`day/${item.date}`), input = await slot.findByLabelText(`Reported: ${task.title}`) as HTMLInputElement;
  input.focus(); fireEvent.change(input, { target: { value: "60" } });
  await slot.findByText("Saved", {}, { timeout: 3000 });
  expect(input.value).toBe("60");
  days.edit({ id: item.id, revision: days.get(item.id).revision, reportedMinutes: 90, requestId: randomUUID() });
  await slot.behavior.emitRealtime("desk-changed", {});
  await waitFor(() => expect(input.value).toBe("1h 30m"));
});

it("queues a completion click while the time field is saving", async () => {
  const { task, days, item, mount } = await setup();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const edit = vi.fn(async input => { if (edit.mock.calls.length === 1) await gate; return days.edit(input); });
  const slot = mount(`day/${item.date}`, { dayEdit: edit });
  const input = await slot.findByLabelText(`Reported: ${task.title}`);
  fireEvent.change(input, { target: { value: "30m" } }); fireEvent.blur(input);
  await waitFor(() => expect(edit).toHaveBeenCalledOnce());
  const checkbox = slot.getByLabelText(`Step completed: ${task.title}`) as HTMLInputElement;
  expect(checkbox.disabled).toBe(false); fireEvent.click(checkbox);
  await act(async () => { release(); });
  await waitFor(() => expect(days.get(item.id)).toMatchObject({ reportedMinutes: 30, state: "done" }));
});

it("hides removed entries immediately and after reopening, with optional restoration and preserved reported time", async () => {
  const { task, days, item, mount } = await setup();
  days.edit({ id: item.id, revision: item.revision, plannedMinutes: 60, reportedMinutes: 30, requestId: randomUUID() });
  const slot = mount(`day/${item.date}`);
  fireEvent.click(await slot.findByRole("button", { name: "Remove from day" }));
  await waitFor(() => expect(slot.queryByRole("article", { name: `Day entry: ${task.title}` })).toBeNull());
  expect(slot.queryByRole("button", { name: "Restore to day" })).toBeNull();
  expect(slot.getByText("The plan is empty. Add tasks or check the calendar.")).toBeTruthy();
  expect(days.get(item.id)).toMatchObject({ removed: true, reportedMinutes: 30 });
  expect(days.day(item.date).totals).toMatchObject({ plannedMinutes: 0, reportedMinutes: 0 });
  expect(slot.getByText("Reported time").parentElement?.textContent).toBe("Reported time0m");
  slot.lifecycle.unmount();
  const reopened = mount(`day/${item.date}`);
  const toggle = await reopened.findByRole("checkbox", { name: "Show removed (1)" });
  expect(reopened.queryByRole("article", { name: `Day entry: ${task.title}` })).toBeNull();
  fireEvent.click(toggle);
  fireEvent.click(await reopened.findByRole("button", { name: "Restore to day" }));
  await waitFor(() => expect(days.get(item.id).removed).toBe(false));
  expect(await reopened.findByRole("article", { name: `Day entry: ${task.title}` })).toBeTruthy();
  expect(days.day(item.date).totals).toMatchObject({ plannedMinutes: 60, reportedMinutes: 30 });
  await waitFor(() => expect(reopened.getByText("Reported time").parentElement?.textContent).toBe("Reported time30m"));
});

it("shows waiting status in Day and saves time before opening its chat", async () => {
  const { f, task, days, item, mount } = await setup();
  await f.harness.behavior.setSettings({ workProvider: "claude-work", workModel: "claude-opus-5[1m]" });
  f.repo.status(task.id, "waiting", task.revision);
  const slot = mount(`day/${item.date}`);
  await slot.findByText("Waiting for response");
  const input = await slot.findByLabelText(`Reported: ${task.title}`);
  fireEvent.change(input, { target: { value: "40m" } });
  fireEvent.click(slot.getByRole("button", { name: "New chat" }));
  await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(1));
  expect(days.get(item.id).reportedMinutes).toBe(40);
  expect(f.repo.kernel.getTask(task.id).status).toBe("waiting");
});
