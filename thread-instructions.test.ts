import { afterEach, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { fixture } from "./test-support.js";
import { startSourceSync } from "./source-sync-test-support.js";
import { SourceSyncStore } from "./source-sync.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
const guidance = "Write the deliverable as concise paragraphs. Preserve required JSON and exact quotations.";
async function setup() {
  const f = await fixture(); hosts.push(f);
  await f.harness.behavior.setSettings({ threadProjectId: "proj_work", threadInstructions: guidance });
  return f;
}
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });

it.each(["codex", "claude-code", "claude-work"])("scopes local instructions to 247C and its project for %s", async providerId => {
  const f = await setup();
  for (const [pluginId, projectId, included] of [
    ["247c", "proj_older", true], [null, "proj_work", true],
    ["side-chat", "proj_work", true], [null, "proj_other", false],
  ] as const) {
    const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
      origin: { pluginId }, project: { id: projectId }, provider: { id: providerId },
    }));
    expect((config.instructions ?? "").includes(guidance)).toBe(included);
  }
  await f.harness.behavior.setSettings({ threadInstructions: "" });
  const empty = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ origin: { pluginId: "247c" } }));
  expect(empty.instructions ?? "").toBe("");
});

it("preserves worker permissions and the recorder JSON contract when adding local guidance", async () => {
  const f = await setup();
  await f.harness.behavior.setSettings({ threadProjectId: "" });
  const task = await f.create(), session = await f.start(task.id, task.revision);
  const worker = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    origin: { pluginId: "247c" }, thread: { id: session.workerThreadId! },
  }));
  expect(worker.instructions).toBe(guidance);
  expect(worker.tools.map(tool => tool.name)).toContain("c247_read");
  expect(worker.tools.map(tool => tool.name)).not.toContain("c247_create");
  const reviewer = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    origin: { pluginId: "247c" }, thread: { title: `247C · verification 0 · ${session.id}` },
  }));
  expect(reviewer.tools).toEqual([]);
  expect(reviewer.instructions).toContain("Return the requested JSON.");
  expect(reviewer.instructions).toContain(guidance);
  await f.reload();
  const reloaded = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ origin: { pluginId: "247c" } }));
  expect(reloaded.instructions).toBe(guidance);
});

it("keeps full analyst restrictions and maximum-length local instructions within BB's limit", async () => {
  const f = await setup(), text = "x".repeat(1500);
  await f.harness.behavior.setSettings({ threadInstructions: text });
  const { run } = await startSourceSync(f);
  new SourceSyncStore(f.repo).save({ ...run, collection: { phase: "analyzing", calls: 1, reads: 1, elapsedMs: 1 } });
  const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    origin: { pluginId: "247c" }, thread: { id: run.threadId!, title: `247C · updates · ${run.id}` },
  }));
  expect(config.instructions).toContain("Do not call external connectors, shell, web or agents");
  expect(config.instructions).toContain("c247_sync_submit");
  expect(config.instructions).toContain(text);
  expect(config.instructions!.length).toBeLessThanOrEqual(4096);
});
