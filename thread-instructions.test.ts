import { afterEach, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { fixture } from "./test-support.js";
import { startSourceSync } from "./source-sync-test-support.js";
import { replyVerificationGuide } from "./prompts.js";
import { SourceSyncStore } from "./source-sync.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
const guidance = "Write the deliverable as concise paragraphs. Preserve required JSON and exact quotations.";
async function setup() {
  const f = await fixture(); hosts.push(f);
  await f.harness.behavior.setSettings({ threadProjectId: "proj_work", threadInstructions: guidance, scopeAgentsToProject: true });
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
    if (included) expect(config.tools.map(tool => tool.name)).toContain("c247_read");
    else expect(config.tools).toEqual([]);
  }
  await f.harness.behavior.setSettings({ threadInstructions: "" });
  const empty = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ origin: { pluginId: "247c" } }));
  expect(empty.instructions ?? "").toBe("");
});

it("keeps global tool access by default and persists project scoping across reloads", async () => {
  const f = await fixture(); hosts.push(f);
  const other = makePluginAgentConfigurationContext({ origin: { pluginId: null }, project: { id: "proj_personal" } });
  expect((await f.harness.behavior.resolveAgentConfiguration(other)).tools.map(tool => tool.name)).toContain("c247_create");
  await f.harness.behavior.setSettings({ scopeAgentsToProject: true, threadProjectId: "proj_work" });
  for (const reload of [false, true]) {
    if (reload) await f.reload();
    const config = await f.harness.behavior.resolveAgentConfiguration(other);
    expect(config.tools).toEqual([]);
    expect(config.instructions ?? "").toBe("");
    expect(config.skills).toEqual([]);
  }
  await f.harness.behavior.setSettings({ scopeAgentsToProject: false });
  expect((await f.harness.behavior.resolveAgentConfiguration(other)).tools.map(tool => tool.name)).toContain("c247_create");
});

it("never exposes project-scoped tools to unrelated or side chats when the project is unset", async () => {
  const f = await setup();
  await f.harness.behavior.setSettings({ threadProjectId: "" });
  for (const pluginId of [null, "side-chat", "another-plugin"]) {
    const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
      origin: { pluginId }, project: { id: "proj_other" },
    }));
    expect(config.tools).toEqual([]);
    expect(config.instructions ?? "").toBe("");
  }
});

it("preserves worker permissions and the recorder JSON contract when adding local guidance", async () => {
  const f = await setup();
  await f.harness.behavior.setSettings({ threadProjectId: "" });
  const task = await f.create(), session = await f.start(task.id, task.revision);
  const worker = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    origin: { pluginId: "247c" }, thread: { id: session.workerThreadId! },
  }));
  expect(worker.instructions).toContain(guidance);
  expect(worker.instructions).toContain(replyVerificationGuide);
  const initial = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    origin: { pluginId: "247c" }, thread: { id: "before_binding", title: `247C · worker · ${session.id}` },
  }));
  expect(initial.instructions).toContain(replyVerificationGuide);
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
  expect(config.instructions).not.toContain(replyVerificationGuide);
  expect(config.instructions).toContain(text);
  expect(config.instructions!.length).toBeLessThanOrEqual(4096);
});

it.each(["codex", "claude-code", "claude-work"])("injects sent-reply verification into existing %s workers after reload, but not reviewers or unrelated threads", async providerId => {
  const f = await setup(), task = await f.create();
  const input = f.startInput(task.id, task.revision);
  await f.harness.behavior.setSettings({ threadProjectId: "" });
  input.request.providerId = providerId;
  input.request.model = providerId === "codex" ? "gpt-5.6-sol" : "claude-opus-5[1m]";
  await f.harness.behavior.callRpc("start", { ...input, criteria: [] });
  const session = f.repo.sessions(task.id)[0];
  await f.harness.behavior.setSettings({ threadProjectId: "proj_work" });
  for (const reload of [false, true]) {
    if (reload) await f.reload();
    const worker = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
      origin: { pluginId: "247c" }, provider: { id: providerId }, thread: { id: session.workerThreadId!, title: "Renamed work chat" },
    }));
    expect(worker.instructions).toContain(replyVerificationGuide);
    expect(worker.instructions).toContain(guidance);
    expect(worker.tools.map(t => t.name)).not.toContain("c247_propose");
    const reviewer = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
      origin: { pluginId: "247c" }, thread: { title: `247C · review 0 · ${session.id}` },
    }));
    expect(reviewer.instructions).not.toContain(replyVerificationGuide);
    expect(reviewer.tools).toEqual([]);
    const unrelated = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
      origin: { pluginId: null }, project: { id: "proj_work" },
    }));
    expect(unrelated.instructions).toBe(guidance);
  }
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
});
