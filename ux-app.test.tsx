// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { UX_BUILD, type UxState, type UxReport } from "./ux-contracts.js";
let app: CapturedPluginApp;
const slots: RenderedSlot[] = [];
beforeAll(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); document.body.innerHTML = ""; sessionStorage.clear(); vi.useRealTimers(); });
const state = (override: Partial<UxState> = {}): UxState => ({ enabled: true, recordingId: crypto.randomUUID(), endsAt: null, bytes: 0, storageAvailable: true, retentionDays: 7, build: UX_BUILD, controls: [{ at: Date.now(), reason: "start" }], status: "recording", ...override });
const report = (s: UxState): UxReport => ({ state: s, events: 0, clients: 0, builds: [], actions: [], transitions: [], results: [], rapidRepeatClicks: 0, timeline: [], daily: [] });

it("requires an explicit pause confirmation and keeps continuous recording after cancellation", async () => {
  let current = state(); const control = vi.fn((input: unknown) => { const { action } = input as { action: string }; if (action === "pause") current = state({ enabled: false, recordingId: null, status: "paused" }); return current; });
  const slot = renderSlot(app.settingsSections.find(s => s.id === "ux-recording")!, {}, { rpc: { uxReport: () => report(current), uxControl: control } }); slots.push(slot);
  fireEvent.click(await slot.findByRole("button", { name: "Pause recording" }));
  expect(control).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Keep recording" })); expect(control).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Pause recording" }));
  fireEvent.click(slot.getByRole("button", { name: "Confirm pause" }));
  await slot.findByRole("button", { name: "Start continuous recording" });
  expect(control).toHaveBeenCalledExactlyOnceWith({ action: "pause" });
});

it.each(["paused", "unavailable"] as const)("keeps the %s recorder mounted without a floating banner", async status => {
  document.body.innerHTML = '<div data-c247-ux-page="tasks"></div>';
  const s = state({ status, enabled: false, recordingId: status === "paused" ? null : crypto.randomUUID(), storageAvailable: status !== "unavailable" });
  const read = vi.fn(() => s);
  const slot = renderSlot(app.appOverlays.find(s => s.id === "ux-recording")!, {}, { rpc: { uxState: read, uxRecord: () => ({ accepted: 0, reason: "unavailable" }) } }); slots.push(slot);
  await waitFor(() => expect(read).toHaveBeenCalled());
  expect(slot.container.textContent).toBe("");
  expect(slot.queryByRole("complementary")).toBeNull();
  expect(slot.inspection.rpcCalls.some(c => c.method === "uxControl")).toBe(false);
});

it("records and resumes after remount without rendering a floating banner or changing recording settings", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div data-c247-ux-page="tasks"></div>';
  const s = state(), send = vi.fn((_input: unknown) => ({ accepted: 1, reason: "saved" }));
  for (let i = 0; i < 2; i++) {
    const slot = renderSlot(app.appOverlays.find(s => s.id === "ux-recording")!, {}, { rpc: { uxState: () => s, uxRecord: send } }); slots.push(slot);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(send).toHaveBeenCalledTimes(i + 1);
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ recordingId: s.recordingId, events: expect.arrayContaining([expect.objectContaining({ page: "tasks", kind: "view" })]) });
    expect(slot.container.textContent).toBe("");
    expect(slot.inspection.rpcCalls.some(c => c.method === "uxControl")).toBe(false);
    slot.lifecycle.unmount();
  }
});
