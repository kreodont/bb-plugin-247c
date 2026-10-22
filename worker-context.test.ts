import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { makeMessageDispatchHookContext, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { fixture } from "./test-support.js";
import { sessionSchema, type Session } from "./contracts.js";
import { acceptedWorkerContext } from "./worker-context.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const hosts: Fixture[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup(mode: "conversation" | "result" = "conversation") {
  const f = await fixture(); hosts.push(f);
  const task = await f.create("Read the accepted report.");
  const input = f.startInput(task.id, task.revision);
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...input, criteria: mode === "conversation" ? [] : input.criteria }));
  return { f, task, session };
}
function changed(f: Fixture, session: Session, text = "Проверен новый отчёт, предыдущие цифры устарели.") {
  f.repo.note({ taskId: session.taskId, revision: f.repo.kernel.getTask(session.taskId).revision, kind: "progress", text, requestId: randomUUID() });
}
function dispatch(f: Fixture, session: Session, attempt: "start-turn" | "join-turn" = "start-turn") {
  return f.harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({
    thread: f.threads.get(session.workerThreadId!)!, attempt,
    input: { blocks: [{ type: "text", text: "Продолжаем", mentions: [] }] },
  }));
}
async function configured(f: Fixture, threadId: string) {
  return f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ origin: { pluginId: "247c" }, thread: { id: threadId, title: "Renamed chat" } }));
}
async function refreshed(f: Fixture, session: Session) {
  await vi.waitFor(() => expect(f.repo.session(session.id).workerContext).toEqual(acceptedWorkerContext(f.repo, session.taskId)));
  await vi.waitFor(async () => expect(await dispatch(f, session)).toEqual({ action: "proceed" }));
}

it("refreshes accepted updates once before continuing the same conversation, without sending a model request", async () => {
  const { f, task, session } = await setup();
  await f.idle(session.workerThreadId!, "The original report was read.");
  const history = structuredClone(f.conversations.get(session.workerThreadId!));
  const configBefore = await configured(f, session.workerThreadId!);
  expect(configBefore.instructions).toContain(`revision=${task.revision}, sourceRevision=0`);
  const fact = f.repo.detail(task.id).facts[0];
  const proposal = f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: {
    rationale: "Correct the summary", confidence: 1, changes: { summary: { value: "Accepted revised summary", evidenceRefs: [fact.id] } },
  } }, "test");
  await f.harness.behavior.callRpc("accept", { proposalId: proposal.id, revision: task.revision });
  changed(f, session);
  expect(await dispatch(f, session)).toMatchObject({ action: "wait", sendAt: expect.any(Number) });
  await refreshed(f, session);
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: session.workerThreadId }]]);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  expect(f.conversations.get(session.workerThreadId!)).toEqual(history);
  expect(f.repo.session(session.id)).toMatchObject({ baseRevision: task.revision, status: "working", workerThreadId: session.workerThreadId, workerProvider: session.workerProvider });
  const config = await configured(f, session.workerThreadId!);
  expect(config.instructions).toContain(`revision=${f.repo.kernel.getTask(task.id).revision}`);
  expect(config.instructions).toContain("If missing or different, call c247_read now");
  const read = JSON.parse(String(await f.harness.behavior.callAgentTool("c247_read", { taskId: task.id }, { threadId: session.workerThreadId!, projectId: "proj_personal" })));
  expect(read.data.projection.summary).toBe("Accepted revised summary");
  expect(read.data.facts.some((fact: { text: string }) => fact.text.includes("предыдущие цифры устарели"))).toBe(true);
  expect(await dispatch(f, session)).toEqual({ action: "proceed" });
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
});

it("leaves pending/rejected proposals and view markers out of refreshes", async () => {
  const { f, task, session } = await setup();
  await f.idle(session.workerThreadId!, "Ready.");
  const fact = f.repo.detail(task.id).facts[0];
  const proposal = f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: {
    rationale: "Not approved", confidence: 1, changes: { summary: { value: "UNACCEPTED_SECRET_CONTEXT", evidenceRefs: [fact.id] } },
  } }, "test");
  f.repo.markSeen(task.id, task.revision);
  expect(await dispatch(f, session)).toEqual({ action: "proceed" });
  expect((await configured(f, session.workerThreadId!)).instructions).not.toContain("UNACCEPTED_SECRET_CONTEXT");
  await f.harness.behavior.callRpc("reject", { proposalId: proposal.id });
  expect(await dispatch(f, session)).toEqual({ action: "proceed" });
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
});

it("does not interrupt active work or steering, and refreshes when the turn becomes idle", async () => {
  const { f, session } = await setup();
  changed(f, session);
  expect(await dispatch(f, session, "join-turn")).toMatchObject({ action: "wait" });
  expect(await dispatch(f, session)).toMatchObject({ action: "wait" });
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  await f.idle(session.workerThreadId!, "Finished this part.");
  expect(await dispatch(f, session)).toMatchObject({ action: "wait" });
  await refreshed(f, session);
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
});

it("rechecks live status before release if a turn started since the dispatch snapshot", async () => {
  const { f, session } = await setup();
  await f.idle(session.workerThreadId!, "Ready.");
  changed(f, session);
  f.harness.inspection.sdk.stub("threads.get", () => ({ ...f.threads.get(session.workerThreadId!)!, status: "active" }));
  expect(await dispatch(f, session)).toMatchObject({ action: "wait" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  expect(f.repo.session(session.id).workerContext).toEqual(session.workerContext);
});

it("coalesces simultaneous dispatches and updates that arrive during a slow release", async () => {
  const { f, session } = await setup();
  await f.idle(session.workerThreadId!, "Ready.");
  changed(f, session);
  let release!: () => void;
  f.harness.inspection.sdk.stub("threads.stop", async () => { await new Promise<void>(resolve => { release = resolve; }); return { ok: true }; });
  const decisions = await Promise.all([dispatch(f, session), dispatch(f, session)]);
  expect(decisions.every(decision => decision.action === "wait")).toBe(true);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  changed(f, session, "One more accepted update while the runtime was releasing.");
  expect(await dispatch(f, session)).toMatchObject({ action: "wait" });
  release();
  await refreshed(f, session);
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
});

it("retrofits existing chats once and preserves the version marker through a plugin reload", async () => {
  const { f, session } = await setup();
  await f.idle(session.workerThreadId!, "Saved conversation.");
  f.repo.saveSession({ ...f.repo.session(session.id), workerContext: undefined });
  await f.reload();
  expect(await dispatch(f, session)).toMatchObject({ action: "wait" });
  await refreshed(f, session);
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
  await f.reload();
  expect(await dispatch(f, session)).toEqual({ action: "proceed" });
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
});

it("retries a failed release without marking stale instructions current or losing the conversation", async () => {
  const { f, session } = await setup();
  await f.idle(session.workerThreadId!, "Saved conversation.");
  changed(f, session);
  f.harness.inspection.sdk.stub("threads.stop", () => { throw new Error("Host unavailable"); });
  expect(await dispatch(f, session)).toMatchObject({ action: "wait" });
  await vi.waitFor(async () => expect(await dispatch(f, session)).toMatchObject({ action: "wait", reason: expect.stringContaining("Retrying automatically") }));
  expect(f.repo.session(session.id).workerContext).toEqual(session.workerContext);
  f.harness.inspection.sdk.stub("threads.stop", () => ({ ok: true }));
  const future = Date.now() + 31000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(future);
  expect(await dispatch(f, session)).toMatchObject({ action: "wait" });
  await refreshed(f, session);
  clock.mockRestore();
  expect(f.repo.session(session.id).status).toBe("working");
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
});

it("refreshes a primary-source change independently of the task revision", async () => {
  const { f, task, session } = await setup();
  await f.idle(session.workerThreadId!, "Ready.");
  for (const sourceRef of ["https://example.com/first", "https://example.com/second"]) {
    f.repo.kernel.appendFact({ taskId: task.id, kind: "description", text: "Accepted context", source: "imported", sourceRef });
  }
  f.repo.saveSession({ ...f.repo.session(session.id), workerContext: acceptedWorkerContext(f.repo, task.id) });
  const revision = f.repo.kernel.getTask(task.id).revision;
  f.repo.setPrimarySource({ taskId: task.id, url: "https://example.com/second", revision: 0, requestId: randomUUID() });
  expect(f.repo.kernel.getTask(task.id).revision).toBe(revision);
  expect(await dispatch(f, session)).toMatchObject({ action: "wait" });
  await refreshed(f, session);
  expect((await configured(f, session.workerThreadId!)).instructions).toContain(`revision=${revision}, sourceRevision=1`);
});

it("refreshes an empty pending chat without stopping its first start", async () => {
  const f = await fixture({ settings: { composerDefaults: JSON.stringify({ providerId: "codex", model: "gpt-5.6-sol" }) } }); hosts.push(f);
  const task = await f.create();
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("openChat", { taskId: task.id, requestId: randomUUID() }));
  changed(f, session);
  expect(f.threads.get(session.workerThreadId!)!.status).toBe("pending");
  expect(await dispatch(f, session)).toMatchObject({ action: "wait" });
  await refreshed(f, session);
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  expect(f.conversations.get(session.workerThreadId!) ?? []).toEqual([]);
});

it("preserves fixed result contracts and keeps fresh context out of recorder instructions", async () => {
  const result = await setup("result");
  changed(result.f, result.session);
  expect(await dispatch(result.f, result.session)).toMatchObject({ action: "reject" });
  expect((await configured(result.f, result.session.workerThreadId!)).instructions).not.toContain("Current accepted 247C task");
  expect(result.f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  const { f, session } = await setup();
  await f.idle(session.workerThreadId!, "Finished the explanation.");
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const reviewer = f.repo.session(session.id).reviewerThreadId!;
  const config = await configured(f, reviewer);
  expect(config.instructions).toContain("Use only the supplied snapshots");
  expect(config.instructions).not.toContain("Current accepted 247C task");
  expect(config.tools).toHaveLength(0);
  expect(await dispatch(f, session)).toMatchObject({ action: "reject" });
});
