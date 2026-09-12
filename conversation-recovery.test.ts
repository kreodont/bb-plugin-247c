import { afterEach, expect, it } from "vitest";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { fixture } from "./test-support.js";
import { sessionSchema } from "./contracts.js";
import { readConversation } from "./conversation.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() {
  const f = await fixture({ deferEnvironment: true }); hosts.push(f);
  const task = await f.create("Prepare a short project plan.");
  const input = { ...f.startInput(task.id, task.revision), criteria: [] };
  input.request.input[0].text = "Let's discuss the project plan.";
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", input));
  return { f, task, session };
}
function dispatch(f: Awaited<ReturnType<typeof fixture>>, threadId: string) {
  return f.harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread: { id: threadId } }));
}
function eventCount(f: Awaited<ReturnType<typeof fixture>>, sessionId: string, kind: string) {
  return f.repo.db.prepare("SELECT id FROM session_events WHERE session_id=? AND kind=?").all(sessionId, kind).length;
}

it("retries failed conversation reads without blocking dispatch, stopping an agent or losing context", async () => {
  const { f, task, session } = await setup();
  const before = f.repo.saveSession({ ...session, deadlineAt: 1 });
  f.harness.inspection.sdk.stub("threads.get", () => { throw new TypeError("fetch failed"); });
  await f.idle(session.workerThreadId!, "The first phase is ready for discussion.");
  await f.idle(session.workerThreadId!, "Here is a clarification.");
  expect(f.repo.session(session.id)).toEqual(before);
  expect(await dispatch(f, session.workerThreadId!)).toEqual({ action: "proceed" });
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(eventCount(f, session.id, "monitor-unavailable")).toBe(1);
  f.harness.inspection.sdk.stub("threads.get", ({ threadId }) => f.threads.get(threadId)!);
  await f.idle(session.workerThreadId!, "We can continue with the second phase.");
  expect(f.repo.session(session.id)).toEqual(before);
  expect(eventCount(f, session.id, "monitor-restored")).toBe(1);
  expect(f.repo.kernel.getTask(task.id)).toEqual(task);
  expect(f.repo.transcript(session.id)).toBeNull();
  // A confirmed archive is still a terminal condition, unlike a failed read.
  const thread = f.threads.get(session.workerThreadId!)!;
  f.threads.set(thread.id, { ...thread, archivedAt: Date.now() });
  await f.idle(thread.id, "Saved history");
  expect(f.repo.session(session.id)).toMatchObject({ status: "blocked", finishedAt: null });
  expect(await dispatch(f, thread.id)).toMatchObject({ action: "reject", message: expect.stringContaining("archived or deleted") });
});

it("explicitly resumes an old read-failure block in the same chat after reload, without sending anything", async () => {
  const { f, task, session } = await setup();
  f.message(session.workerThreadId!, "assistant", "The original project context.");
  const messages = structuredClone(f.conversations.get(session.workerThreadId!));
  const blocked = f.repo.saveSession({ ...session, status: "blocked", error: "fetch failed", deadlineAt: 1 });
  f.repo.sessionEvent(session.id, "blocked", "fetch failed");
  await f.reload();
  expect(await dispatch(f, session.workerThreadId!)).toMatchObject({ action: "reject", message: expect.stringMatching(/fetch failed.*Resume chat/) });
  f.harness.inspection.sdk.stub("threads.get", () => { throw new TypeError("fetch failed"); });
  await expect(f.harness.behavior.callRpc("resume", { sessionId: session.id })).rejects.toThrow("fetch failed");
  expect(f.repo.session(session.id)).toEqual(blocked);
  f.harness.inspection.sdk.stub("threads.get", ({ threadId }) => f.threads.get(threadId)!);
  const resumed = sessionSchema.parse(await f.harness.behavior.callRpc("resume", { sessionId: session.id }));
  expect(resumed).toEqual({ ...blocked, status: "working", error: null, updatedAt: resumed.updatedAt });
  expect(await f.harness.behavior.callRpc("resume", { sessionId: session.id })).toEqual(resumed);
  expect(await dispatch(f, session.workerThreadId!)).toEqual({ action: "proceed" });
  expect(f.conversations.get(session.workerThreadId!)).toEqual(messages);
  expect(f.repo.kernel.getTask(task.id)).toEqual(task);
  expect(f.repo.transcript(session.id)).toBeNull();
  expect(eventCount(f, session.id, "conversation-resumed")).toBe(1);
  expect(eventCount(f, session.id, "blocked")).toBe(1);
  for (const method of ["threads.spawn", "threads.send", "threads.stop", "threads.archive"] as const) expect(f.harness.inspection.sdk.callsTo(method)).toHaveLength(0);
});

it.each(["cancelled", "finished", "frozen", "closed", "other session", "archived", "deleted", "unrelated thread", "missing thread"])("does not resume a %s conversation", async reason => {
  const { f, task, session } = await setup();
  f.repo.saveSession({ ...session, status: "blocked", error: "fetch failed" });
  if (reason === "cancelled") f.repo.saveSession({ ...f.repo.session(session.id), status: "cancelled" });
  if (reason === "finished") f.repo.saveSession({ ...f.repo.session(session.id), finishedAt: new Date().toISOString() });
  if (reason === "frozen") f.repo.saveTranscript(session.id, await readConversation(f.bb, session));
  if (reason === "closed") f.repo.status(task.id, "done", task.revision);
  if (reason === "other session") await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const thread = f.threads.get(session.workerThreadId!)!;
  if (reason === "archived") f.threads.set(thread.id, { ...thread, archivedAt: Date.now() });
  if (reason === "deleted") f.threads.set(thread.id, { ...thread, deletedAt: Date.now() });
  if (reason === "unrelated thread") f.threads.set(thread.id, { ...thread, originPluginId: "another-plugin" });
  if (reason === "missing thread") f.threads.delete(thread.id);
  const before = await f.detail(task.id);
  await expect(f.harness.behavior.callRpc("resume", { sessionId: session.id })).rejects.toThrow();
  expect(await f.detail(task.id)).toEqual(before);
  expect((await dispatch(f, session.workerThreadId!))?.action).toBe("reject");
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
});

it.each(["session changed", "task closed", "another session started"])("rechecks recovery after BB responds: %s", async reason => {
  const { f, task, session } = await setup();
  f.repo.saveSession({ ...session, status: "blocked", error: "fetch failed" });
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  f.harness.inspection.sdk.stub("threads.get", async ({ threadId }) => { entered(); await waiting; return f.threads.get(threadId)!; });
  const recovery = f.harness.behavior.callRpc("resume", { sessionId: session.id });
  await reading;
  if (reason === "session changed") f.repo.saveSession({ ...f.repo.session(session.id), status: "cancelled" });
  if (reason === "task closed") f.repo.status(task.id, "done", task.revision);
  if (reason === "another session started") await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const before = await f.detail(task.id);
  release();
  await expect(recovery).rejects.toThrow();
  expect(await f.detail(task.id)).toEqual(before);
  expect((await dispatch(f, session.workerThreadId!))?.action).toBe("reject");
});
