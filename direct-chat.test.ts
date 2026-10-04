import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makeMessageDispatchHookContext, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { fixture } from "./test-support.js";
import { sessionSchema } from "./contracts.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() {
  const f = await fixture({ settings: { threadProjectId: "proj_tasks", composerDefaults: JSON.stringify({ providerId: "claude-work", model: "claude-opus-5[1m]" }) } }); hosts.push(f);
  f.harness.inspection.sdk.stub("projects.get", () => ({ id: "proj_tasks", kind: "standard", sources: [{ type: "local_path", hostId: "host_test", path: "/work", isDefault: true }] }));
  const task = await f.create();
  const open = async (requestId = randomUUID()) => sessionSchema.parse(await f.harness.behavior.callRpc("openChat", { taskId: task.id, requestId }));
  return { f, task, open };
}

it("creates one empty conversation for concurrent clicks, with no starter message or send", async () => {
  const { f, task, open } = await setup();
  const before = f.repo.detail(task.id).task;
  const [first, second] = await Promise.all([open(), open()]);
  expect(first.id).toBe(second.id);
  expect(first).toMatchObject({ status: "working", mode: "conversation", taskId: task.id, workerProvider: "claude-work" });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ projectId: "proj_tasks", input: [{ type: "text", visibility: "agent-only" }], visibility: "visible", providerId: "claude-work", model: "claude-opus-5[1m]", permissionMode: "accept-edits", environment: { type: "host", hostId: "host_test", workspace: { type: "unmanaged", path: null } } });
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  expect(f.conversations.get(first.workerThreadId!) ?? []).toHaveLength(0);
  expect(f.threads.get(first.workerThreadId!)?.status).toBe("pending");
  expect(f.queued.get(first.workerThreadId!)).toEqual([]);
  expect(f.harness.inspection.sdk.callsTo("threads.queuedMessages.delete")).toHaveLength(1);
  expect(f.harness.inspection.sdk.callsTo("threads.update").flat()).toContainEqual({ threadId: first.workerThreadId, model: first.workerModel, reasoningLevel: "medium" });
  expect(f.repo.detail(task.id).task).toEqual(before);
});

it("keeps the task instructions and idempotent launch through reload and settings changes", async () => {
  const { f, task, open } = await setup(), requestId = randomUUID();
  const first = await open(requestId);
  await f.harness.behavior.setSettings({ composerDefaults: JSON.stringify({ providerId: "codex", model: "gpt-6-astra" }), threadInstructions: "x".repeat(1470) + " LOCAL_INSTRUCTIONS_END" });
  await f.reload();
  const retry = await open(requestId);
  expect(retry.workerThreadId).toBe(first.workerThreadId);
  expect((await open()).workerThreadId).toBe(first.workerThreadId);
  const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ origin: { pluginId: "247c", kind: null }, thread: { id: first.workerThreadId!, title: "Renamed conversation" } }));
  expect(config.instructions).toContain(task.id);
  expect(config.instructions).toContain("call c247_read");
  expect(config.instructions).toContain("Wait for the user's message");
  expect(config.tools.some(t => t.name === "c247_read")).toBe(true);
  expect(config.instructions!.length).toBeLessThanOrEqual(4096);
  expect(config.instructions).toContain("LOCAL_INSTRUCTIONS_END");
  const another = await f.create();
  await expect(f.harness.behavior.callRpc("openChat", { taskId: another.id, requestId })).rejects.toThrow("different session");
});

it("uses remembered project execution choices when no local work model is configured", async () => {
  const { f, open } = await setup();
  await f.harness.behavior.setSettings({ composerDefaults: "{}" });
  f.harness.inspection.sdk.stub("projects.defaultExecutionOptions", () => ({ providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "high", permissionMode: "auto", serviceTier: "default" }));
  const session = await open();
  expect(session).toMatchObject({ workerProvider: "codex", workerModel: "gpt-5.6-sol" });
});

it("does not substitute a model or create a session when the configured model is unavailable", async () => {
  const { f, task, open } = await setup();
  await f.harness.behavior.setSettings({ composerDefaults: JSON.stringify({ providerId: "claude-work", model: "unavailable-model" }) });
  await expect(open()).rejects.toThrow("unavailable");
  expect(f.repo.sessions(task.id)).toHaveLength(0);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});


it("keeps a failed queue cleanup held, then recovers the same thread without deleting user input", async () => {
  const { f, open } = await setup(), requestId = randomUUID();
  f.harness.inspection.sdk.stub("threads.queuedMessages.delete", () => { throw new Error("Temporary queue failure"); });
  await expect(open(requestId)).rejects.toThrow("Temporary queue failure");
  const session = f.repo.session(requestId), thread = f.threads.get(session.workerThreadId!)!;
  expect(session.status).toBe("starting");
  const queue = f.queued.get(thread.id)!;
  expect(queue).toHaveLength(1);
  const dispatch = f.harness.inspection.registrations.hooks["message.dispatch"]!;
  const held = makeMessageDispatchHookContext({ thread, input: { blocks: queue[0].content } });
  expect(await dispatch(held)).toMatchObject({ action: "wait" });
  expect(await dispatch(makeMessageDispatchHookContext({ thread, input: { blocks: [{ type: "text", text: "Help me with this task", mentions: [] }] } }))).toEqual({ action: "proceed" });
  const userRow = { ...queue[0], id: "queued_user_message", content: [{ type: "text" as const, text: "My pending message", mentions: [] }] };
  queue.push(userRow);
  f.harness.inspection.sdk.stub("threads.queuedMessages.delete", ({ threadId, queuedMessageId }) => {
    f.queued.set(threadId, (f.queued.get(threadId) ?? []).filter(r => r.id !== queuedMessageId)); return { ok: true };
  });
  await f.reload();
  const recovered = await open(requestId);
  expect(recovered).toMatchObject({ workerThreadId: thread.id, status: "working", error: null });
  expect(f.queued.get(thread.id)).toEqual([userRow]);
  expect(f.threads.size).toBe(1);
});

it("marks an open conversation as waiting for the user, not as a running agent", async () => {
  const { f, task, open } = await setup();
  const session = await open();
  const card = f.repo.list().tasks.find(t => t.id === task.id)!;
  expect(card).toMatchObject({ activeSession: session.id, activeSessionBusy: false, activeSessionSince: session.createdAt });
  f.repo.db.prepare("UPDATE sessions SET status='reviewing' WHERE id=?").run(session.id);
  expect(f.repo.list().tasks.find(t => t.id === task.id)).toMatchObject({ activeSession: session.id, activeSessionBusy: true });
});
