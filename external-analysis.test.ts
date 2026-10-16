import { afterEach, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { fixture } from "./test-support.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() {
  const f = await fixture(); hosts.push(f);
  await f.harness.behavior.setSettings({ threadProjectId: "proj_tasks" });
  f.harness.inspection.sdk.stub("projects.get", ({ projectId }) => ({ id: projectId, kind: "standard", sources: [{ id: "s", type: "local_path", hostId: "host_local", path: "/work/tasks", isDefault: true }] }));
  return f;
}
const input = { key: "a".repeat(64), providerId: "codex", model: "gpt-6-sol", reasoningLevel: "medium", instructions: "Analyze saved records.", context: '{"sourceDocuments":[{"eventId":"e"}]}' };
const result = { suggestions: [], skipped: [{ eventId: "e", reason: "No new work." }] };
it("launches once in the configured project, visible without navigation, retaining execution and replaying after reload", async () => {
  const f = await setup();
  const [a, b] = await Promise.all([f.harness.behavior.callRpc("scriptAnalysisStart", input), f.harness.behavior.callRpc("scriptAnalysisStart", input)]) as any[];
  expect(a.threadId).toBe(b.threadId);
  const calls = f.harness.inspection.sdk.callsTo("threads.spawn") as any[][];
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toMatchObject({ projectId: "proj_tasks", environment: { type: "host", hostId: "host_local" }, visibility: "visible", providerId: input.providerId, model: input.model, reasoningLevel: "medium" });
  expect(calls[0][0].title).toMatch(/^247C · Updates · /);
  expect(f.harness.inspection.sdk.callsTo("threads.open")).toHaveLength(0);
  await expect(f.harness.behavior.callRpc("scriptAnalysisStart", { ...input, context: "different" })).rejects.toThrow(/different input/);
  await expect(f.harness.behavior.callRpc("scriptAnalysisStart", { ...input, key: "b".repeat(64) })).rejects.toThrow(/already running/);
  await f.reload();
  expect(await f.harness.behavior.callRpc("scriptAnalysisStart", input)).toMatchObject({ threadId: a.threadId, reused: true });
});
it("freezes submitted output, allows discussion without resubmission and lists the Updates link", async () => {
  const f = await setup();
  const job = await f.harness.behavior.callRpc("scriptAnalysisStart", input) as any;
  const spawn = f.harness.inspection.sdk.callsTo("threads.spawn")[0][0] as any;
  const context = makePluginAgentConfigurationContext({ thread: { id: job.threadId }, origin: { pluginId: "247c" }, pluginMetadata: spawn.pluginMetadata });
  expect(await f.harness.behavior.resolveAgentConfiguration(context)).toMatchObject({ tools: [{ name: "c247_script_analysis_result" }] });
  await f.harness.behavior.callAgentTool("c247_script_analysis_result", result, { threadId: job.threadId });
  await f.idle(job.threadId, "Analysis ready.");
  expect(await f.harness.behavior.callRpc("scriptAnalysisStatus", { key: input.key })).toMatchObject({ state: "ready", result });
  await f.harness.behavior.callRpc("scriptAnalysisFinish", { key: input.key, error: null });
  expect(await f.harness.behavior.resolveAgentConfiguration(context)).toMatchObject({ tools: [] });
  await expect(f.harness.behavior.callAgentTool("c247_script_analysis_result", result, { threadId: job.threadId })).rejects.toThrow(/finished/);
  await f.idle(job.threadId, "Later discussion.");
  expect(await f.harness.behavior.callRpc("scriptAnalysisStatus", { key: input.key })).toMatchObject({ state: "imported", result });
  expect(await f.harness.behavior.callRpc("updaterHealth", {})).toMatchObject({ analysisThreads: [{ threadId: job.threadId, state: "imported", model: input.model }] });
});
it("does not auto-respawn an ambiguous launch or a failed analysis", async () => {
  const f = await setup();
  f.harness.inspection.sdk.stub("threads.spawn", () => { throw new Error("response lost"); });
  await expect(f.harness.behavior.callRpc("scriptAnalysisStart", input)).rejects.toThrow("response lost");
  await expect(f.harness.behavior.callRpc("scriptAnalysisStart", input)).rejects.toThrow(/No duplicate/);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

it("recovers import failures from the frozen result without spending another model run", async () => {
  const f = await setup();
  const job = await f.harness.behavior.callRpc("scriptAnalysisStart", input) as any;
  const submissions = await Promise.allSettled([
    f.harness.behavior.callAgentTool("c247_script_analysis_result", result, { threadId: job.threadId }),
    f.harness.behavior.callAgentTool("c247_script_analysis_result", { suggestions: [], skipped: [] }, { threadId: job.threadId }),
  ]);
  expect(submissions.map(s => s.status)).toEqual(["fulfilled", "rejected"]);
  await f.harness.behavior.callRpc("scriptAnalysisFinish", { key: input.key, error: "Importer unavailable" });
  await f.reload();
  expect(await f.harness.behavior.callRpc("scriptAnalysisStart", input)).toMatchObject({ reused: true, state: "failed" });
  expect(await f.harness.behavior.callRpc("scriptAnalysisStatus", { key: input.key })).toMatchObject({ result });
  await f.harness.behavior.callRpc("scriptAnalysisFinish", { key: input.key, error: null });
  expect(await f.harness.behavior.callRpc("scriptAnalysisStatus", { key: input.key })).toMatchObject({ state: "imported", error: null, result });
});
it("records missing output and timeout failures without respawning", async () => {
  const f = await setup();
  const job = await f.harness.behavior.callRpc("scriptAnalysisStart", input) as any;
  await f.idle(job.threadId, "No result submitted.");
  expect(await f.harness.behavior.callRpc("scriptAnalysisStatus", { key: input.key })).toMatchObject({ state: "failed", result: null });
  expect(await f.harness.behavior.callRpc("scriptAnalysisStart", input)).toMatchObject({ reused: true, state: "failed" });
  const next = await f.harness.behavior.callRpc("scriptAnalysisStart", { ...input, key: "b".repeat(64) }) as any;
  await f.harness.behavior.callRpc("scriptAnalysisFinish", { key: "b".repeat(64), error: "Timed out" });
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: next.threadId }]]);
});
