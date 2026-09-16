import { afterEach, expect, it } from "vitest";
import { makeMessageDispatchHookContext, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { fixture } from "./test-support.js";
import { sourceData, startSourceSync, submitSourceData } from "./source-sync-test-support.js";
import { SourceSyncStore } from "./source-sync.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() { const f = await fixture(); hosts.push(f); return f; }
function dispatch(f: Awaited<ReturnType<typeof fixture>>, threadId: string) {
  return f.harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread: { id: threadId } }));
}

it.each(["completed", "partial", "blocked", "cancelled"] as const)("allows discussion after a %s check without reopening it, including after reload", async status => {
  const f = await setup(), { run } = await startSourceSync(f);
  await f.harness.behavior.setSettings({ threadInstructions: "Answer in the user's language." });
  new SourceSyncStore(f.repo).save({ ...run, status, finishedAt: run.until, collection: { phase: "analyzing", calls: 1, reads: 1, elapsedMs: 1 } });
  for (const reload of [false, true]) {
    if (reload) await f.reload();
    const store = new SourceSyncStore(f.repo), before = store.run(run.id), checkpoints = store.checkpoints();
    expect(await dispatch(f, run.threadId!)).toEqual({ action: "proceed" });
    const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
      origin: { pluginId: "247c" }, thread: { id: run.threadId! },
    }));
    expect(config.tools.map(t => t.name).sort()).toEqual(["c247_tasks", "c247_read", "c247_knowledge", "c247_sync_calls", "c247_sync_data", "c247_sync_context"].sort());
    expect(config.instructions).toContain(`status=${status}`);
    expect(config.instructions).toContain("Answer in the user's language.");
    expect(store.run(run.id)).toEqual(before);
    expect(store.checkpoints()).toEqual(checkpoints);
    await expect(f.harness.behavior.callAgentTool("c247_day_review", {}, { threadId: run.threadId! })).rejects.toThrow(/active source analyst/);
  }
});

it("keeps completed results and checkpoints protected while allowing follow-up messages", async () => {
  const f = await setup(), task = await f.create(), { run } = await startSourceSync(f);
  const { input } = await sourceData(f, run, task.id);
  await submitSourceData(f, run, input);
  const store = new SourceSyncStore(f.repo), completed = store.run(run.id), candidates = store.candidates(), checkpoints = store.checkpoints();
  expect(completed.status).toBe("completed");
  expect(await dispatch(f, run.threadId!)).toEqual({ action: "proceed" });
  const changed = structuredClone(input); changed.suggestions[0].changes.summary!.value += " Additional claim.";
  await expect(submitSourceData(f, run, changed)).rejects.toThrow(/already finished/);
  expect(store.run(run.id)).toEqual(completed);
  expect(store.candidates()).toEqual(candidates);
  expect(store.checkpoints()).toEqual(checkpoints);
});

it("retains submission tools for an active analyst", async () => {
  const f = await setup(), { run } = await startSourceSync(f);
  expect(await dispatch(f, run.threadId!)).toEqual({ action: "proceed" });
  const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    origin: { pluginId: "247c" }, thread: { id: run.threadId! },
  }));
  expect(config.tools.map(t => t.name)).toEqual(expect.arrayContaining(["c247_sync_submit", "c247_day_review", "c247_day_estimate"]));
});
