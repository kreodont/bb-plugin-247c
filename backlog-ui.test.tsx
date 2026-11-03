// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixture } from "./test-support.js";
import { rpcContract } from "./contracts.js";
import { backlogRpcContract } from "./backlog-contracts.js";
import { sourceData } from "./source-sync-test-support.js";
import type { SyncRun } from "./contracts.js";

let app: CapturedPluginApp;
const mounts: RenderedSlot[] = [], hosts: Awaited<ReturnType<typeof fixture>>[] = [];
beforeAll(async () => { app = await loadPluginApp(() => import("./app.js")); }, 60000);
afterEach(async () => { for (const m of mounts.splice(0)) m.lifecycle.unmount(); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() {
  const f = await fixture({ settings: { backlogProvider: "claude-work", backlogModel: "claude-opus-5[1m]", threadProjectId: "proj_tasks" } }); hosts.push(f);
  f.harness.inspection.sdk.stub("projects.get", ({ projectId }) => ({ id: projectId, kind: "standard", sources: [{ id: "source", type: "local_path", hostId: "host_test", path: "/work", isDefault: true }] }));
  const a = await f.harness.behavior.callRpc("create", { title: "Alpha task", description: "First task", requestId: crypto.randomUUID() });
  const b = await f.harness.behavior.callRpc("create", { title: "Beta task", description: "Second task", requestId: crypto.randomUUID() });
  const rpc = Object.fromEntries(Object.keys(rpcContract).map(name => [name, (input: unknown) => f.harness.behavior.callRpc(name, input)]));
  const slot = renderSlot(app.navPanels[0], { subPath: "backlog" }, { rpc }); mounts.push(slot);
  await slot.findByRole("button", { name: "Review selected · 2" });
  return { f, slot, a, b };
}

it("selects every task initially and keeps hidden selection when filtering", async () => {
  const { slot, f } = await setup();
  expect((slot.getByRole("checkbox", { name: "Select Alpha task" }) as HTMLInputElement).checked).toBe(true);
  expect((slot.getByRole("checkbox", { name: "Select Beta task" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.change(slot.getByRole("textbox", { name: "Filter backlog tasks" }), { target: { value: "Alpha" } });
  expect(slot.queryByRole("checkbox", { name: "Select Beta task" })).toBeNull();
  expect(slot.getByText("2 of 2 selected · 1 shown")).toBeTruthy();
  fireEvent.click(slot.getByRole("checkbox", { name: "Select Alpha task" }));
  expect(slot.getByRole("button", { name: "Review selected · 1" })).toBeTruthy();
  await slot.behavior.emitRealtime("desk-changed", {});
  expect((slot.getByRole("checkbox", { name: "Select Alpha task" }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(slot.getByRole("button", { name: "Clear selection" }));
  expect((slot.getByRole("button", { name: "Review selected · 0" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(slot.getByRole("button", { name: "Select all" }));
  expect(slot.getByText("2 of 2 selected · 1 shown")).toBeTruthy();
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it("starts once, shows durable progress, navigates to the review and stops it", async () => {
  const { slot, f } = await setup();
  fireEvent.click(slot.getByRole("checkbox", { name: "Select Beta task" }));
  const start = slot.getByRole("button", { name: "Review selected · 1" });
  fireEvent.click(start); fireEvent.click(start);
  await slot.findByText("Reviewing · 0/1");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(slot.getAllByRole("button", { name: "Open task" })).toHaveLength(1);
  fireEvent.click(slot.getByRole("button", { name: "Open review chat" }));
  expect(slot.inspection.navigateCalls[0]).toMatchObject({ method: "toThread" });
  fireEvent.click(slot.getByRole("button", { name: "Stop review" }));
  await slot.findByText("Review stopped · 0/1");
  expect(slot.getAllByText("Not reviewed")).toHaveLength(2);
  await waitFor(() => expect((slot.getByRole("button", { name: "Review selected · 1" }) as HTMLButtonElement).disabled).toBe(false));
});

it("keeps the Backlog tab visible beside Search", async () => {
  const { slot } = await setup();
  const tab = slot.getByRole("button", { name: "Backlog" });
  fireEvent.click(tab);
  expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", path: "desk", options: { subPath: "backlog" } });
});

it("reviews and accepts a saved proposal inline without leaving Backlog", async () => {
  const { slot, f } = await setup();
  fireEvent.click(slot.getByRole("button", { name: "Review selected · 2" }));
  await slot.findByText("Reviewing · 0/2");
  const run = backlogRpcContract.backlogState.output.parse(await f.harness.behavior.callRpc("backlogState", {})).run!;
  const context = { threadId: run.threadId!, projectId: "proj_tasks", signal: new AbortController().signal };
  const task = f.repo.list().tasks[0];
  await f.harness.behavior.callAgentTool("c247_backlog_dossier", { taskId: task.id }, context);
  const { input } = await sourceData(f, { ...run, until: new Date().toISOString() } as unknown as SyncRun, task.id);
  const draft = input.suggestions[0];
  await f.harness.behavior.callAgentTool("c247_backlog_submit", { taskId: task.id, facts: draft.facts, changes: draft.changes,
    finding: { outcome: "ready", summary: "Report requested.", action: "Prepare report.", sourceStatus: "checked", sourceDetail: "Current source read." } }, context);
  await slot.behavior.emitRealtime("desk-changed", {});
  fireEvent.click(await slot.findByRole("button", { name: "Review proposal · pending" }));
  fireEvent.click(await slot.findByRole("button", { name: "Accept changes" }));
  await slot.findByRole("button", { name: "Review proposal · applied" });
  expect(f.repo.detail(task.id).projection.nextStep).toBe(draft.changes.nextStep!.value);
  expect(slot.inspection.navigateCalls).toEqual([]);
});
