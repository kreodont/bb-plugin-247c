// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { CapturedPluginApp, RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyUpdaterHealth } from "./updater-health.js";

let app: CapturedPluginApp;
const mounts: RenderedSlot[] = [];
beforeAll(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(() => { mounts.splice(0).forEach(m => m.lifecycle.unmount()); localStorage.clear(); });
const warning = { ...emptyUpdaterHealth(0), configured: true, status: "paused" as const, alert: true,
  title: "Source updater is paused", detail: "Paused after three failed runs", incidentId: "incident_one", lastSuccessAt: Date.parse("2026-09-23T09:06:00Z") };

it("shows a notification outside the 247C panel, dismisses only that incident and alerts again after recovery", async () => {
  let state = warning;
  const overlay = app.appOverlays.find(row => row.id === "updater-health-notification")!;
  const slot = renderSlot(overlay, {}, { rpc: { updaterHealth: () => state } }); mounts.push(slot);
  await slot.findByRole("alert", { name: "247C updater notification" });
  expect(slot.getByText(/An empty proposal list/)).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Dismiss notification" }));
  expect(slot.queryByRole("alert")).toBeNull();
  await slot.behavior.emitRealtime("updater-health-changed", {});
  expect(slot.queryByRole("alert")).toBeNull();
  state = { ...warning, alert: false };
  await slot.behavior.emitRealtime("updater-health-changed", {});
  await waitFor(() => expect(localStorage.getItem("247c:updater-dismissed-incident")).toBeNull());
  state = { ...warning, incidentId: "incident_two" };
  await slot.behavior.emitRealtime("updater-health-changed", {});
  fireEvent.click(await slot.findByRole("button", { name: "Open update status" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "desk", options: { subPath: "updates" } });
});

it("prioritizes the warning badge and opens update status without hiding the proposal counter", async () => {
  const component = app.navPanels[0].experimental_sidebarAccessory!;
  const slot = renderSlot({ component }, {}, { rpc: {
    updaterHealth: () => warning, list: () => ({ total: 3, pendingTotal: 2 }),
    day: () => ({ totals: { reportedMinutes: 0 }, date: "2026-09-24", timeZone: "UTC" }),
  } }); mounts.push(slot);
  const alert = await slot.findByRole("button", { name: "Source updater is paused" });
  expect(slot.getByRole("button", { name: "Proposals awaiting a decision: 2" })).toBeTruthy();
  fireEvent.click(alert);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "desk", options: { subPath: "updates" } });
});

it("keeps the panel warning visible after the popup was dismissed", async () => {
  localStorage.setItem("247c:updater-dismissed-incident", warning.incidentId!);
  const f = await import("./test-support.js").then(module => module.fixture());
  try {
    const { rpcContract } = await import("./contracts.js");
    const rpc = Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
    rpc.updaterHealth = async () => warning;
    const slot = renderSlot(app.navPanels[0], { subPath: "proposals" }, { rpc }); mounts.push(slot);
    const banner = await slot.findByRole("alert", { name: "Source updater status" });
    expect(banner.textContent).toContain("Source updater is paused");
    expect(banner.textContent).toContain("Last successful run:");
    expect(banner.textContent).toContain("Paused after three failed runs");
    await slot.findByRole("heading", { name: "No proposals are ready" });
    expect(slot.queryByText("Everything reviewed")).toBeNull();
  } finally { await f.harness.lifecycle.dispose(); }
});

it("shows collector coverage instead of stale analysis batch dates and counters", async () => {
  const f = await import("./test-support.js").then(module => module.fixture());
  try {
    const { rpcContract } = await import("./contracts.js");
    const rpc = Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
    const collectedAt = "2026-09-28T10:00:00Z", since = "2026-09-13T09:15:00Z";
    rpc.updaterHealth = async () => ({ ...warning, sourceCoverage: [
      { source: "outlook", collectedAt, since, fullyCheckedThrough: collectedAt, status: "complete", savedRecords: 29, gaps: [] },
      { source: "teams", collectedAt, since, fullyCheckedThrough: null, status: "partial", savedRecords: 217, gaps: ["Source response truncated"], scannedChats: 17, discoveredChats: 135 },
    ] });
    rpc.syncState = async () => ({ pending: 0, candidates: [], checkpoints: { outlook: "2026-09-14T09:30:00Z" }, nextSince: { outlook: since, teams: since }, runs: [{
      id: "old-batch", status: "partial", startedAt: "2026-09-28T09:00:00Z", until: "2026-09-28T09:00:00Z", suggestions: 0,
      ranges: { outlook: { since }, teams: { since } }, reports: [{ source: "outlook", status: "partial", detail: "Old batch report", scanned: 0, threadsRead: 0 }],
    }] });
    const slot = renderSlot(app.navPanels[0], { subPath: "updates" }, { rpc }); mounts.push(slot);
    const outlook = await slot.findByRole("region", { name: "Outlook collection coverage" });
    expect(outlook.textContent).toContain("Collection complete");
    expect(outlook.textContent).toContain("Saved records: 29");
    expect(outlook.textContent).not.toContain("14 Sept");
    const teams = await slot.findByRole("region", { name: "Teams collection coverage" });
    expect(teams.textContent).toContain("Full coverage not confirmed");
    expect(teams.textContent).toContain("13 Sept");
    expect(teams.textContent).toContain("28 Sept");
    expect(teams.textContent).toContain("Chats checked: 17 of 135");
    expect(teams.textContent).toContain("Source response truncated");
    expect(slot.queryByText("Old batch report")).toBeNull();
    expect(slot.queryByText(/Unchecked since/)).toBeNull();
  } finally { await f.harness.lifecycle.dispose(); }
});

it("runs the configured updater from Updates without opening the built-in source composer", async () => {
  const f = await import("./test-support.js").then(module => module.fixture());
  try {
    const { rpcContract } = await import("./contracts.js");
    const rpc = Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
    rpc.updaterHealth = async () => ({ ...warning, status: "attention", running: false });
    let started = 0;
    rpc.updaterStart = async () => { started++; return { runId: "manual-source-check", status: "running", alreadyRunning: false }; };
    rpc.syncStart = async () => { throw new Error("Built-in sources must not run"); };
    const slot = renderSlot(app.navPanels[0], { subPath: "updates" }, { rpc }); mounts.push(slot);
    const button = await slot.findByRole("button", { name: "Check for updates" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await slot.findByText("The configured source check has been started. Collection and analysis progress appear in updater status.");
    expect(started).toBe(1);
    expect(slot.queryByRole("heading", { name: "Start check" })).toBeNull();
  } finally { await f.harness.lifecycle.dispose(); }
});

it("keeps native quick/custom checks available while showing a native partial-check warning", async () => {
  const f = await import("./test-support.js").then(module => module.fixture());
  try {
    const { rpcContract } = await import("./contracts.js");
    const rpc = Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
    rpc.updaterHealth = async () => ({ ...warning, mode: "native", status: "attention", title: "Source check is incomplete", detail: "Slack: thread_not_found" });
    let started = 0;
    rpc.updaterStart = async () => { throw new Error("External automation must not run"); };
    rpc.syncQuickStart = async () => { started++; return { alreadyRunning: false, run: { status: "starting", error: null } }; };
    const slot = renderSlot(app.navPanels[0], { subPath: "updates" }, { rpc }); mounts.push(slot);
    expect((await slot.findByRole("alert", { name: "Source updater status" })).textContent).toContain("Slack: thread_not_found");
    expect(await slot.findByRole("button", { name: "Custom check…" })).toBeTruthy();
    const button = await slot.findByRole("button", { name: "Check for updates" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await slot.findByText("Check started. Progress is shown below.");
    expect(started).toBe(1);
  } finally { await f.harness.lifecycle.dispose(); }
});

it("links the latest analysis and history without taking focus when status changes", async () => {
  const { UpdaterHealthBanner } = await import("./updater-health-ui.js");
  const state = { ...warning, alert: false, analysisThreads: [
    { threadId: "thread_latest", title: "247C · Updates · 16 Oct 2026, 11:00:00", state: "analyzing", startedAt: 1, model: "test-model", reasoningLevel: "medium", error: null },
    { threadId: "thread_previous", title: "247C · Updates · 16 Oct 2026, 10:00:00", state: "imported", startedAt: 0, model: "test-model", reasoningLevel: "medium", error: null },
  ] };
  const slot = renderSlot({ component: () => <UpdaterHealthBanner showHealthy /> }, {}, { rpc: { updaterHealth: () => state } }); mounts.push(slot);
  const latest = await slot.findByRole("button", { name: "Analysis conversation" });
  await slot.behavior.emitRealtime("updater-health-changed", {});
  expect(slot.inspection.navigateCalls).toHaveLength(0);
  fireEvent.click(latest);
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thread_latest" }]);
  fireEvent.click(slot.getByText("Analysis history · 2"));
  fireEvent.click(slot.getByRole("button", { name: state.analysisThreads[1].title }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thread_previous" });
});

it("shows a queued analysis as a yellow status without the urgent badge or popup", async () => {
  const { UpdaterHealthBanner, UpdaterHealthBadge, UpdaterHealthNotification } = await import("./updater-health-ui.js");
  const state = { ...warning, status: "waiting" as const, title: "Source updates are waiting for analysis", pendingRecords: 15 };
  const slot = renderSlot({ component: () => <><UpdaterHealthBanner /><UpdaterHealthBadge /><UpdaterHealthNotification /></> }, {},
    { rpc: { updaterHealth: () => state } }); mounts.push(slot);
  const banner = await slot.findByRole("status", { name: "Source updater status" });
  expect(banner.className).toContain("border-amber-");
  expect(banner.className).not.toContain("destructive");
  expect(banner.textContent).toContain("Records awaiting analysis: 15");
  expect(slot.queryByRole("alert")).toBeNull();
  expect(slot.queryByRole("button", { name: state.title })).toBeNull();
});

it("keeps an import failure red even when records are also queued", async () => {
  const { UpdaterHealthBanner, UpdaterHealthBadge } = await import("./updater-health-ui.js");
  const state = { ...warning, status: "attention" as const, title: "Source updates need attention", pendingRecords: 15, attentionBatches: 1 };
  const slot = renderSlot({ component: () => <><UpdaterHealthBanner /><UpdaterHealthBadge /></> }, {},
    { rpc: { updaterHealth: () => state } }); mounts.push(slot);
  const banner = await slot.findByRole("alert", { name: "Source updater status" });
  expect(banner.className).toContain("border-destructive");
  expect(slot.getByRole("button", { name: state.title }).textContent).toBe("!");
});
