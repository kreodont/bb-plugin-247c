import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { fixture } from "./test-support.js";
const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
const target = { projectId: "proj_sources", automationId: "auto_sources" };
const automation = { id: target.automationId, projectId: target.projectId, enabled: true, createdAt: 1, nextRunAt: 100, lastError: null,
  trigger: { triggerType: "schedule", cron: "0 * * * *", timezone: "UTC" } };
const run = { id: "run_sources", status: "running", startedAt: 1, finishedAt: null, error: null };
async function setup(configured = true) {
  const f = await fixture({ settings: configured ? { sourceUpdaterProjectId: target.projectId, sourceUpdaterAutomationId: target.automationId } : {} }); hosts.push(f); return f;
}
it("starts only the configured automation with an idempotent key and no source conversation", async () => {
  const f = await setup(), requestId = randomUUID();
  f.harness.inspection.sdk.stub("plugins.callRpc", async ({ method, input, outputSchema }: Parameters<BbPluginApi["sdk"]["plugins"]["callRpc"]>[0]) => {
    expect(input).toMatchObject(target);
    if (method === "automations_run") expect(input).toEqual({ ...target, idempotencyKey: `247c-updater:${requestId}` });
    return outputSchema.parse(method === "automations_get" ? automation : method === "automations_runs" ? { runs: [] } : { run });
  });
  for (let i = 0; i < 2; i++) expect(await f.harness.behavior.callRpc("updaterStart", { requestId })).toEqual({ runId: run.id, status: "running", alreadyRunning: false });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  expect((await f.harness.behavior.callRpc("syncState", {}) as { runs: unknown[] }).runs).toEqual([]);
  await expect(f.harness.behavior.callRpc("syncStart", { requestId: randomUUID(), request: f.startInput("unused", 0).request, since: null })).rejects.toThrow("A source updater automation is configured");
});
it("reuses an active automation and refuses missing configuration or caller-selected targets", async () => {
  const f = await setup();
  f.harness.inspection.sdk.stub("plugins.callRpc", async ({ method, outputSchema }: Parameters<BbPluginApi["sdk"]["plugins"]["callRpc"]>[0]) => {
    expect(method).not.toBe("automations_run");
    return outputSchema.parse(method === "automations_get" ? automation : { runs: [run] });
  });
  expect(await f.harness.behavior.callRpc("updaterStart", { requestId: randomUUID() })).toMatchObject({ alreadyRunning: true });
  await expect(f.harness.behavior.callRpc("updaterStart", { requestId: randomUUID(), automationId: "other" })).rejects.toThrow();
  const empty = await setup(false);
  await expect(empty.harness.behavior.callRpc("updaterStart", { requestId: randomUUID() })).rejects.toThrow("Configure the source updater");
  expect(empty.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
});
it("keeps automation launch failures visible and never falls back to built-in sources", async () => {
  const f = await setup();
  f.harness.inspection.sdk.stub("plugins.callRpc", async () => { throw new Error("Source automation unavailable"); });
  await expect(f.harness.behavior.callRpc("updaterStart", { requestId: randomUUID() })).rejects.toThrow("Source automation unavailable");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});
