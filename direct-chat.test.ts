import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makeMessageDispatchHookContext, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { fixture } from "./test-support.js";
import { replyVerificationGuide } from "./prompts.js";
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
  expect(config.instructions).toContain(replyVerificationGuide);
  const another = await f.create();
  await expect(f.harness.behavior.callRpc("openChat", { taskId: another.id, requestId })).rejects.toThrow("different session");
});

it("fits reply verification, dossier guidance and maximum local instructions within BB's configuration limit", async () => {
  const { f } = await setup();
  await f.harness.behavior.setSettings({ threadInstructions: "x".repeat(1500) });
  const task = await f.harness.behavior.callRpc("create", { title: '"'.repeat(200), description: "Context ".repeat(1400), requestId: randomUUID() }) as { id: string };
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("openChat", { taskId: task.id, requestId: randomUUID() }));
  const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    origin: { pluginId: "247c" }, thread: { id: session.workerThreadId! },
  }));
  expect(config.instructions).toContain(replyVerificationGuide);
  expect(config.instructions).toContain("x".repeat(1500));
  expect(config.instructions).toContain("Follow nextCursor to null");
  expect(config.instructions!.length).toBeLessThanOrEqual(4096);
});

it.each(["done", "archived"] as const)("opens and reviews a fresh conversation on a %s task without reopening it", async status => {
  const { f, task, open } = await setup();
  f.repo.status(task.id, status, task.revision);
  const before = f.repo.kernel.getTask(task.id);
  await expect(f.harness.behavior.callRpc("start", { ...f.startInput(task.id, before.revision), criteria: [] })).rejects.toThrow("closed");
  let session = await open();
  expect(session).toMatchObject({ closedTaskConversation: true, continuedFrom: null, status: "working" });
  expect(f.repo.kernel.getTask(task.id)).toEqual(before);
  await f.reload();
  f.harness.inspection.sdk.stub("projects.get", () => ({ id: "proj_tasks", kind: "standard", sources: [{ type: "local_path", hostId: "host_test", path: "/work", isDefault: true }] }));
  expect((await open()).id).toBe(session.id);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  expect(f.threads.size).toBe(1);
  // BB prepares the pending empty thread's environment on the first user turn.
  const thread = { ...f.threads.get(session.workerThreadId!)!, environmentId: "env_test" };
  f.threads.set(thread.id, thread);
  expect(await f.harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread, input: { blocks: [{ type: "text", text: "Explain the result", mentions: [] }] } }))).toEqual({ action: "proceed" });
  f.message(thread.id, "user", "Explain the result without reopening the task.");
  await f.idle(thread.id, "The saved report has been explained.");
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  session = f.repo.session(session.id);
  expect(session.error).toBeNull();
  expect(session.status).toBe("reviewing");
  const source = f.repo.transcript(session.id)!.messages.find(m => m.text === "The saved report has been explained.")!;
  await f.idle(session.reviewerThreadId!, { rationale: "Record the explanation", facts: [{ kind: "progress", text: source.text, citations: [{ messageRef: source.ref, quote: source.text }] }], changes: null, knowledge: [] });
  session = f.repo.session(session.id);
  expect(session.error).toBeNull();
  expect(session.status).toBe("awaiting_approval");
  await f.harness.behavior.callRpc("accept", { proposalId: session.proposalId!, revision: session.baseRevision });
  expect(f.repo.kernel.getTask(task.id).status).toBe(status);
  expect(f.repo.session(session.id).status).toBe("applied");
});

it("uses remembered project execution choices when no local work model is configured", async () => {
  const { f, open } = await setup();
  await f.harness.behavior.setSettings({ composerDefaults: "{}" });
  f.harness.inspection.sdk.stub("projects.defaultExecutionOptions", () => ({ providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "high", permissionMode: "auto", serviceTier: "default" }));
  const session = await open();
  expect(session).toMatchObject({ workerProvider: "codex", workerModel: "gpt-5.6-sol" });
});

it.each(["claude-code", "claude-work"])("persists the exact catalogued model in an empty %s chat", async providerId => {
  const { f, open } = await setup();
  const model = "claude-opus-5-5[1m]";
  await f.harness.behavior.setSettings({ composerDefaults: "{}", workProvider: providerId, workModel: model });
  f.harness.inspection.sdk.stub("providers.models", () => ({ models: [{ id: model, model }], modelLoadError: null }));
  // Match BB's native default-update check, which is stricter than CLI startup.
  f.harness.inspection.sdk.stub("threads.update", ({ threadId, model: nextModel, title }) => {
    if (nextModel && nextModel !== model) throw new Error("Model is not in this thread's catalog");
    if (nextModel) f.models.set(threadId, nextModel);
    const thread = { ...f.threads.get(threadId)!, ...(title === undefined ? {} : { title }) };
    f.threads.set(threadId, thread); return thread;
  });
  const session = await open();
  expect(session).toMatchObject({ status: "working", mode: "conversation", workerProvider: providerId, workerModel: model });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ providerId, model });
  expect(f.models.get(session.workerThreadId!)).toBe(model);
  expect(f.harness.inspection.sdk.callsTo("providers.models")).toHaveLength(1);
  expect(f.harness.inspection.sdk.callsTo("providers.models")[0][0]).toMatchObject({ providerId });
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  expect(f.queued.get(session.workerThreadId!)).toEqual([]);
});

it.each([
  { models: [], modelLoadError: null },
  { models: [], modelLoadError: "Catalog refresh failed" },
  { models: [{ id: "claude-opus-5-5[1m]", model: "claude-opus-5-5" }], modelLoadError: null },
])("rejects an empty chat before spawning when native model defaults cannot be saved (%j)", async catalog => {
  const { f, task, open } = await setup();
  await f.harness.behavior.setSettings({ composerDefaults: "{}", workProvider: "claude-work", workModel: "claude-opus-5-5[1m]" });
  f.harness.inspection.sdk.stub("providers.models", () => catalog);
  await expect(open()).rejects.toThrow("Register the model with that provider");
  expect(f.repo.sessions(task.id)).toHaveLength(0);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it("still checks account availability before opening a chat with an unlisted model", async () => {
  const { f, task, open } = await setup();
  await f.harness.behavior.setSettings({ composerDefaults: "{}", workProvider: "claude-work", workModel: "claude-opus-5-5[1m]" });
  f.harness.inspection.sdk.stub("providers.list", () => [{ id: "claude-work", available: false }]);
  await expect(open()).rejects.toThrow("The selected account is unavailable");
  expect(f.repo.sessions(task.id)).toHaveLength(0);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it("surfaces a provider rejection of a catalogued model without falling back or respawning", async () => {
  const { f, task, open } = await setup();
  await f.harness.behavior.setSettings({ composerDefaults: "{}", workProvider: "claude-work", workModel: "claude-opus-5-5[1m]" });
  f.harness.inspection.sdk.stub("providers.models", () => ({ models: [{ id: "claude-opus-5-5[1m]", model: "claude-opus-5-5[1m]" }], modelLoadError: null }));
  f.harness.inspection.sdk.stub("threads.spawn", () => { throw new Error("Model unavailable for this account"); });
  await expect(open()).rejects.toThrow("Model unavailable for this account");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(f.repo.sessions(task.id)[0]).toMatchObject({ status: "blocked", workerModel: "claude-opus-5-5[1m]" });
});

it("does not substitute a model or create a session when a Codex model is absent from its catalog", async () => {
  const { f, task, open } = await setup();
  await f.harness.behavior.setSettings({ composerDefaults: JSON.stringify({ providerId: "codex", model: "unavailable-model" }) });
  await expect(open()).rejects.toThrow("worker model");
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
