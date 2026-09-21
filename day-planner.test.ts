import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { fixture } from "./test-support.js";
import { dayPlannerStateSchema, localDay, shiftDay } from "./day-contracts.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
const target = { projectId: "proj_planner", automationId: "auto_planner" };
const run = { id: "run_plan", status: "running", startedAt: Date.now(), finishedAt: null, error: null, skipReason: null };
type RpcArgs = Parameters<BbPluginApi["sdk"]["plugins"]["callRpc"]>[0];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() { const f = await fixture(); hosts.push(f); return f; }
async function configure(f: Awaited<ReturnType<typeof fixture>>) {
  await f.harness.behavior.setSettings({ dayPlannerProjectId: target.projectId, dayPlannerAutomationId: target.automationId });
}

it("reads an unconfigured planner without contacting Automations and refuses a launch", async () => {
  const f = await setup();
  expect(await f.harness.behavior.callRpc("dayPlannerState", {})).toMatchObject({ configured: false, run: null });
  await expect(f.harness.behavior.callRpc("dayPlannerStart", { date: localDay(), requestId: randomUUID() })).rejects.toThrow(/Configure the day planner/);
  expect(f.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
});

it("shows an active run ahead of later skipped clicks and omits scripts and run output", async () => {
  const f = await setup(); await configure(f);
  f.harness.inspection.sdk.stub("plugins.callRpc", async ({ pluginId, method, input, outputSchema }: RpcArgs) => {
    expect(pluginId).toBe("automations"); expect(input).toMatchObject(target);
    return outputSchema.parse(method === "automations_get"
      ? { id: target.automationId, projectId: target.projectId, name: "Work planner", enabled: true, nextRunAt: Date.now() + 60000, execution: { script: "private implementation" } }
      : { runs: [{ ...run, id: "run_skipped", status: "skipped", startedAt: run.startedAt + 1 }, { ...run, output: "private contents" }] });
  });
  const state = dayPlannerStateSchema.parse(await f.harness.behavior.callRpc("dayPlannerState", {}));
  expect(state).toMatchObject({ configured: true, name: "Work planner", run });
  expect(JSON.stringify(state)).not.toContain("private");
});

it("forwards only the configured automation and a stable retry key without changing the day or dossier", async () => {
  const f = await setup(); await configure(f);
  const task = await f.create(), beforeTask = await f.detail(task.id);
  const beforeDay = await f.harness.behavior.callRpc("day", { date: localDay() });
  f.harness.inspection.sdk.stub("plugins.callRpc", async ({ pluginId, method, input, outputSchema }: RpcArgs) => {
    expect(pluginId).toBe("automations"); expect(method).toBe("automations_run");
    expect(input).toEqual({ ...target, idempotencyKey: `247c-day:${request.date}:${request.requestId}` });
    return outputSchema.parse({ run });
  });
  const request = { date: localDay(), requestId: randomUUID() };
  expect(await f.harness.behavior.callRpc("dayPlannerStart", request)).toEqual(run);
  expect(await f.harness.behavior.callRpc("dayPlannerStart", request)).toEqual(run);
  expect(await f.harness.behavior.callRpc("day", { date: request.date })).toEqual(beforeDay);
  expect(await f.detail(task.id)).toEqual(beforeTask);
  const calls = f.harness.inspection.sdk.callsTo("plugins.callRpc");
  expect(calls).toHaveLength(2);
  for (const call of calls) expect(call[0]).toMatchObject({ input: { ...target, idempotencyKey: `247c-day:${request.date}:${request.requestId}` } });
});

it("rejects another date and caller-supplied targets before dispatch", async () => {
  const f = await setup(); await configure(f);
  await expect(f.harness.behavior.callRpc("dayPlannerStart", { date: shiftDay(localDay(), 1), requestId: randomUUID() })).rejects.toThrow(/Open Today/);
  await expect(f.harness.behavior.callRpc("dayPlannerStart", { date: localDay(), requestId: randomUUID(), automationId: "auto_other" })).rejects.toThrow();
  expect(f.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
});

it("propagates launch errors without reporting a started run", async () => {
  const f = await setup(); await configure(f);
  f.harness.inspection.sdk.stub("plugins.callRpc", async () => { throw new Error("Planner is unavailable"); });
  await expect(f.harness.behavior.callRpc("dayPlannerStart", { date: localDay(), requestId: randomUUID() })).rejects.toThrow("Planner is unavailable");
});

it.each([
  ["already-planned", "The plan for 2026-09-21 already exists. No duplicate tasks were added."],
  ["already-running", "Day planning is already running. Wait for it to finish."],
])("explains the %s outcome without exposing raw output", async (outcome, message) => {
  const f = await setup(); await configure(f);
  f.harness.inspection.sdk.stub("plugins.callRpc", async ({ method, outputSchema }: RpcArgs) => outputSchema.parse(method === "automations_get"
    ? { ...target, id: target.automationId, name: "Work planner", enabled: true, nextRunAt: null }
    : { runs: [{ ...run, status: "succeeded", output: JSON.stringify({ kind: "247c-day-planner", date: "2026-09-21", outcome, private: "hidden" }) }] }));
  const state = dayPlannerStateSchema.parse(await f.harness.behavior.callRpc("dayPlannerState", {}));
  expect(state.run?.message).toBe(message);
  expect(JSON.stringify(state)).not.toContain("hidden");
  expect(state.run).not.toHaveProperty("output");
});

it("explains legacy wakeAgent skips without claiming why they happened", async () => {
  const f = await setup(); await configure(f);
  f.harness.inspection.sdk.stub("plugins.callRpc", async ({ method, outputSchema }: RpcArgs) => outputSchema.parse(method === "automations_get"
    ? { ...target, id: target.automationId, name: "Work planner", enabled: true, nextRunAt: null }
    : { runs: [{ ...run, status: "skipped", skipReason: "wakeAgent false" }] }));
  const state = dayPlannerStateSchema.parse(await f.harness.behavior.callRpc("dayPlannerState", {}));
  expect(state.run?.message).toBe("No new plan was created during this run. See the saved day plan below.");
});
