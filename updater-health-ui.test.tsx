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
