// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { loadPluginApp, mountPluginContentScripts, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";

let app: CapturedPluginApp;
const slots: RenderedSlot[] = [], scripts: Awaited<ReturnType<typeof mountPluginContentScripts>>[] = [];
beforeEach(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(async () => { slots.splice(0).forEach(slot => slot.lifecycle.unmount()); for (const script of scripts.splice(0)) await script.lifecycle.dispose(); });
const active = { threads: [{ threadId: "main-chat", status: "reviewing" }] };
const idle = { threads: [] };
async function mount(omitExperimentalThreadRowStatus = false) {
  const script = await mountPluginContentScripts(app, { pluginId: "247c", omitExperimentalThreadRowStatus }); scripts.push(script); return script;
}
function render(handler: () => unknown) {
  const slot = renderSlot(app.appOverlays.find(row => row.id === "review-activity")!, {}, { rpc: { reviewActivity: handler } }); slots.push(slot); return slot;
}

it("updates all reviewing main chats and clears finished ones on realtime events", async () => {
  let data = active;
  const script = await mount(), slot = render(() => data);
  await waitFor(() => expect(script.inspection.getThreadRowStatus("main-chat")).toMatchObject({ tone: "running", label: "Reviewing conversation" }));
  expect(script.inspection.getThreadRowStatus("review-chat")).toBeNull();
  data = { threads: [{ threadId: "other-chat", status: "review_starting" }] };
  await slot.behavior.emitRealtime("desk-changed", {});
  await waitFor(() => expect(script.inspection.getThreadRowStatus("main-chat")).toBeNull());
  expect(script.inspection.getThreadRowStatus("other-chat")?.label).toBe("Starting conversation review");
  data = idle;
  await slot.behavior.emitRealtime("desk-changed", {});
  await waitFor(() => expect(script.inspection.getThreadRowStatus("other-chat")).toBeNull());
});

it("handles either mount order and removes indicators on overlay or script disposal", async () => {
  const slot = render(() => active);
  await waitFor(() => expect(slot.inspection.rpcCalls.length).toBe(1));
  const script = await mount();
  await waitFor(() => expect(script.inspection.getThreadRowStatus("main-chat")).not.toBeNull());
  await script.lifecycle.dispose();
  expect(script.inspection.getThreadRowStatus("main-chat")).toBeNull();
  const replacement = await mount();
  expect(replacement.inspection.getThreadRowStatus("main-chat")).not.toBeNull();
  slot.lifecycle.unmount();
  expect(replacement.inspection.getThreadRowStatus("main-chat")).toBeNull();
});

it("clears unavailable status and restores it after reconnect without running an agent", async () => {
  let fail = false;
  const script = await mount(), slot = render(() => { if (fail) throw new Error("Offline"); return active; });
  await waitFor(() => expect(script.inspection.getThreadRowStatus("main-chat")).not.toBeNull());
  fail = true;
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  await waitFor(() => expect(script.inspection.getThreadRowStatus("main-chat")).toBeNull());
  fail = false;
  await slot.behavior.setRealtimeConnectionState("connected");
  await waitFor(() => expect(script.inspection.getThreadRowStatus("main-chat")).not.toBeNull());
  expect(slot.inspection.rpcCalls.every(call => call.method === "reviewActivity")).toBe(true);
});

it("ignores a stale response after a newer refresh and after unmount", async () => {
  let resolve!: (value: unknown) => void;
  const delayed = new Promise(done => { resolve = done; });
  let first = true;
  const script = await mount(), slot = render(() => { if (first) { first = false; return delayed; } return idle; });
  await waitFor(() => expect(slot.inspection.rpcCalls.length).toBe(1));
  await slot.behavior.emitRealtime("desk-changed", {});
  await waitFor(() => expect(slot.inspection.rpcCalls.length).toBe(2));
  await act(async () => { resolve(active); await delayed; });
  expect(script.inspection.getThreadRowStatus("main-chat")).toBeNull();
  slot.lifecycle.unmount();
  expect(script.inspection.getThreadRowStatus("main-chat")).toBeNull();
});

it("tolerates hosts without the optional thread row API", async () => {
  const script = await mount(true), slot = render(() => active);
  await waitFor(() => expect(slot.inspection.rpcCalls.length).toBe(1));
  expect(script.inspection.threadRowStatusCalls).toEqual([]);
});
