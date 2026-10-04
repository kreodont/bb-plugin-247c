// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyUpdaterHealth } from "./updater-health.js";
import { fixture } from "./test-support.js";
import { rpcContract, sessionSchema } from "./contracts.js";
import { taskReviewPath } from "./desk-routes.js";
import { randomUUID } from "node:crypto";

let app: CapturedPluginApp;
const mounts: RenderedSlot[] = [], hosts: Awaited<ReturnType<typeof fixture>>[] = [];
beforeAll(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(async () => { mounts.splice(0).forEach(m => m.lifecycle.unmount()); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); localStorage.clear(); });
const failure = { incidentId: "incident-one", sessionId: "session-old", taskId: "task-one", taskTitle: "Correct deployment dates", failedAt: "2026-10-02T16:36:49Z", error: "HTTP 502: Runtime shutting down" };
const state = { total: 1, failures: [failure] };
const overlay = () => app.appOverlays.find(row => row.id === "review-failure-notification")!;

it("notifies outside the plugin, remembers dismissal across remounts and alerts for a new failed attempt", async () => {
  let current = state;
  const options = { rpc: { reviewFailures: () => current } };
  let slot = renderSlot(overlay(), {}, options); mounts.push(slot);
  await slot.findByRole("alert", { name: "247C review failure notification" });
  expect(slot.getByText(failure.taskTitle)).toBeTruthy();
  expect(slot.getByText(failure.error)).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Dismiss notification" }));
  expect(slot.queryByRole("alert")).toBeNull();
  slot.lifecycle.unmount(); mounts.pop();
  slot = renderSlot(overlay(), {}, options); mounts.push(slot);
  await slot.behavior.emitRealtime("desk-changed", {});
  await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
  expect(slot.queryByRole("alert")).toBeNull();
  current = { total: 1, failures: [{ ...failure, incidentId: "incident-two" }] };
  await slot.behavior.emitRealtime("desk-changed", {});
  fireEvent.click(await slot.findByRole("button", { name: "Open failed review" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "desk", options: { subPath: "task-one/session/session-old" } });
  expect(slot.queryByRole("alert")).toBeNull();
});

it("recovers a missed failure on reconnect and removes the notification after recovery", async () => {
  let current = { total: 0, failures: [] as typeof state.failures };
  const slot = renderSlot(overlay(), {}, { rpc: { reviewFailures: () => current } }); mounts.push(slot);
  await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  current = state;
  await slot.behavior.setRealtimeConnectionState("connected");
  await slot.findByRole("alert");
  current = { total: 0, failures: [] };
  await slot.behavior.emitRealtime("desk-changed", {});
  await waitFor(() => expect(slot.queryByRole("alert")).toBeNull());
});

it("keeps review failure, updater warning, proposal count and reported time visible together", async () => {
  const slot = renderSlot({ component: app.navPanels[0].experimental_sidebarAccessory! }, {}, { rpc: {
    reviewFailures: () => state,
    updaterHealth: () => ({ ...emptyUpdaterHealth(0), configured: true, alert: true, title: "Source updater failed" }),
    list: () => ({ total: 34, pendingTotal: 2 }),
    day: () => ({ totals: { reportedMinutes: 355 }, date: "2026-10-02", timeZone: "UTC" }),
  } }); mounts.push(slot);
  fireEvent.click(await slot.findByRole("button", { name: "Failed conversation reviews: 1" }));
  expect(slot.getByRole("button", { name: "Source updater failed" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Proposals awaiting a decision: 2" })).toBeTruthy();
  expect(slot.getByLabelText("Reported today: 5:55")).toBeTruthy();
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "desk", options: { subPath: "reviews" } });
});

async function failedFixture() {
  const f = await fixture(); hosts.push(f); const task = await f.create();
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  const failed = f.repo.saveSession({ ...session, status: "blocked", finishedAt: failure.failedAt, error: failure.error });
  const rpc = Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
  const mount = (subPath: string) => { const slot = renderSlot(app.navPanels[0], { subPath }, { rpc }); mounts.push(slot); return slot; };
  return { f, task, failed, rpc, mount };
}

it("opens the exact failed session in Work, even when a newer session exists, and retries that session", async () => {
  const { f, task, failed, mount } = await failedFixture();
  for (let i = 0; i < 101; i++) f.repo.insertSession({ ...failed, id: randomUUID(), status: "cancelled", error: "Newer cancelled work" }, {});
  const slot = mount(taskReviewPath(task.id, failed.id));
  await slot.findByText(failure.error);
  expect(slot.getByRole("tab", { name: "Work" }).getAttribute("aria-selected")).toBe("true");
  expect(slot.queryByText("Newer cancelled work")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Retry review" }));
  await waitFor(() => expect(f.repo.session(failed.id).status).toBe("reviewing"));
  expect(slot.inspection.rpcCalls.filter(call => call.method === "retry").map(call => call.input)).toEqual([{ sessionId: failed.id }]);
});

it.each(["list", "cards"])("shows a persistent failure shortcut in %s and the failures page after popup dismissal", async layout => {
  localStorage.setItem("247c-task-layout", layout);
  const { task, failed, mount } = await failedFixture();
  const list = mount("");
  fireEvent.click(await list.findByRole("button", { name: "Review failed" }));
  expect(list.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "desk", options: { subPath: taskReviewPath(task.id, failed.id) } });
  list.lifecycle.unmount(); mounts.pop();
  const page = mount("reviews");
  await page.findByRole("heading", { name: "Failed reviews · 1" });
  expect(page.getByRole("heading", { name: task.title })).toBeTruthy();
  expect(page.getByText(failure.error)).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Open failed review" }));
  expect(page.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "desk", options: { subPath: taskReviewPath(task.id, failed.id) } });
});

it("keeps a Review failed action in the original thread after Finish session failed", async () => {
  const { task, failed, rpc } = await failedFixture();
  const action = app.threadHeaderActions.find(row => row.id === "session")!;
  const slot = renderSlot(action, { threadId: failed.workerThreadId!, projectId: "proj_personal", isCompactViewport: false }, { rpc }); mounts.push(slot);
  fireEvent.click(await slot.findByRole("button", { name: "Review failed" }));
  expect(slot.queryByRole("button", { name: "Finish session" })).toBeNull();
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "desk", options: { subPath: taskReviewPath(task.id, failed.id, failed.workerThreadId!) } });
});
