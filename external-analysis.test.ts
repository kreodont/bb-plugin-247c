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
const input = { key: "a".repeat(64), providerId: "codex", model: "gpt-6-sol", reasoningLevel: "medium", instructions: "Analyze saved records.", context: JSON.stringify({ sourceDocuments: [
  { eventId: "e", newOrChanged: true, callRef: "read-1", id: "message-1" },
  { eventId: "history", newOrChanged: false, callRef: "read-2", id: "message-2" },
] }) };
const result = { suggestions: [], skipped: [{ eventId: "e", reason: "No new work." }] };
const referenceInput = { ...input, resultFormat: "references-v1", context: JSON.stringify({ sourceDocuments: [{
  eventId: "long-event-id", newOrChanged: true, callRef: "read", id: "message", source: "clickup",
  url: "https://example.com/message", eventAt: "2026-11-02T10:00:00Z", response: { content: "Okay. Okay. Review the invoice." },
}] }) };
it("retains rejected selections across reload and repair without another model or a false confirmation", async () => {
  const f = await setup();
  const job = await f.harness.behavior.callRpc("scriptAnalysisStart", referenceInput) as any;
  const bad = { suggestions: [], skipped: [{ record: "unknown", reason: "No new work." }] };
  const failed = await f.harness.behavior.callAgentTool("c247_script_analysis_select", bad, { threadId: job.threadId });
  expect(JSON.parse(failed as string)).toMatchObject({ saved: false, imported: false });
  await f.idle(job.threadId, "Everything saved!");
  await f.reload();
  expect(await f.harness.behavior.callRpc("scriptAnalysisStatus", { key: input.key })).toMatchObject({ state: "failed", result: null, error: expect.stringContaining("not a selected event") });
  const attempt = await f.harness.behavior.callRpc("scriptAnalysisAttempt", { threadId: job.threadId }) as any;
  expect(attempt).toMatchObject({ payload: bad, valid: false, error: expect.stringContaining("unknown") });
  await expect(f.harness.behavior.callRpc("scriptAnalysisRepair", { key: input.key, attemptId: "stale", payload: bad })).rejects.toThrow(/changed/);
  const good = { suggestions: [], skipped: [{ record: "r1", reason: "No new work." }] };
  expect(await f.harness.behavior.callRpc("scriptAnalysisRepair", { key: input.key, attemptId: attempt.id, payload: good })).toMatchObject({ saved: true, imported: false });
  expect(await f.harness.behavior.callRpc("scriptAnalysisStatus", { key: input.key })).toMatchObject({ state: "ready", error: null, result: { suggestions: [], skipped: [{ eventId: "long-event-id", reason: "No new work." }] } });
  await expect(f.harness.behavior.callRpc("scriptAnalysisFinish", { key: input.key, error: null })).rejects.toThrow(/Only a successful/);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  const history = await f.harness.behavior.callRpc("updaterHealth", {}) as any;
  expect(history.analysisThreads[0]).toMatchObject({ state: "ready", hasSavedAttempt: true, importRunId: null });
});
it("retains structurally invalid selection rows before reporting their errors", async () => {
  const f = await setup();
  const job = await f.harness.behavior.callRpc("scriptAnalysisStart", referenceInput) as any;
  const invalid = { suggestions: [{ unexpected: true }], skipped: [] };
  const output = await f.harness.behavior.callAgentTool("c247_script_analysis_select", invalid, { threadId: job.threadId });
  expect(JSON.parse(output as string)).toMatchObject({ saved: false, imported: false });
  expect(await f.harness.behavior.callRpc("scriptAnalysisAttempt", { threadId: job.threadId })).toMatchObject({ payload: invalid, valid: false });
});
it("keeps each reference catalog scoped to its analysis and available after compaction", async () => {
  const f = await setup();
  const job = await f.harness.behavior.callRpc("scriptAnalysisStart", referenceInput) as any;
  await expect(f.harness.behavior.callAgentTool("c247_script_analysis_sources", {}, { threadId: "unrelated" })).rejects.toThrow(/belongs to this thread/);
  const passages = await f.harness.behavior.callAgentTool("c247_script_analysis_sources", { record: "r1" }, { threadId: job.threadId });
  expect(JSON.stringify(passages)).toContain("Okay. Okay.");
  await f.reload();
  expect(await f.harness.behavior.callAgentTool("c247_script_analysis_sources", { record: "r1" }, { threadId: job.threadId })).toEqual(passages);
});
it("rejects a nonliteral quote before freezing and accepts correction in the same thread after reload", async () => {
  const f = await setup();
  const context = JSON.parse(input.context);
  context.sourceDocuments[0].response = { content: "Yeah, maybe. Maybe someone can review it." };
  const job = await f.harness.behavior.callRpc("scriptAnalysisStart", { ...input, context: JSON.stringify(context) }) as any;
  await f.reload();
  const output = { suggestions: [{ taskId: null, title: "Review", rationale: "Meeting request.", confidence: 1,
    changes: { summary: { value: "Review requested.", evidenceRefs: ["fact:0"] } },
    facts: [{ kind: "decision", text: "Review requested.", citations: [{ callRef: "read-1", messageId: "message-1", source: "clickup",
      url: "https://example.com/page", occurredAt: "2026-10-21T07:00:00Z", quote: "Yeah, maybe someone can review it." }] }],
  }], skipped: [] };
  await expect(f.harness.behavior.callAgentTool("c247_script_analysis_result", output, { threadId: job.threadId })).rejects.toThrow(/Quote is absent/);
  expect(await f.harness.behavior.callRpc("scriptAnalysisStatus", { key: input.key })).toMatchObject({ state: "analyzing", result: null });
  output.suggestions[0].facts[0].citations[0].quote = context.sourceDocuments[0].response.content;
  await f.harness.behavior.callAgentTool("c247_script_analysis_result", output, { threadId: job.threadId });
  expect(await f.harness.behavior.callRpc("scriptAnalysisStatus", { key: input.key })).toMatchObject({ state: "ready", result: output });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});
it("rejects invalid event coverage before freezing and accepts correction in the same thread after reload", async () => {
  const f = await setup();
  const job = await f.harness.behavior.callRpc("scriptAnalysisStart", input) as any;
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  await f.reload();
  for (const [skipped, error] of [
    [[{ eventId: "read-1", reason: "Greeting." }], /Unknown skipped event IDs: read-1.*Omitted selected event IDs: e/],
    [[{ eventId: "history", reason: "Old context." }], /Unknown skipped event IDs: history/],
    [[...result.skipped, ...result.skipped], /Duplicate skipped event IDs: e/],
    [[], /Omitted selected event IDs: e/],
  ] as const) {
    await expect(f.harness.behavior.callAgentTool("c247_script_analysis_result", { suggestions: [], skipped }, { threadId: job.threadId })).rejects.toThrow(error);
    expect(await f.harness.behavior.callRpc("scriptAnalysisStatus", { key: input.key })).toMatchObject({ state: "analyzing", result: null });
  }
  await f.harness.behavior.callAgentTool("c247_script_analysis_result", result, { threadId: job.threadId });
  expect(await f.harness.behavior.callRpc("scriptAnalysisStatus", { key: input.key })).toMatchObject({ state: "ready", result });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});
it("lets jobs launched before coverage validation complete after an upgrade", async () => {
  const f = await setup();
  const job = await f.harness.behavior.callRpc("scriptAnalysisStart", input) as any;
  const key = "script-analysis:" + input.key;
  const legacy = await f.bb.storage.kv.get<Record<string, unknown>>(key);
  delete legacy!.coverageVersion;
  await f.bb.storage.kv.set(key, legacy!);
  await f.reload();
  await f.harness.behavior.callAgentTool("c247_script_analysis_result", result, { threadId: job.threadId });
  expect(await f.harness.behavior.callRpc("scriptAnalysisStatus", { key: input.key })).toMatchObject({ state: "ready", result });
});
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
