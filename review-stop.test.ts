import { afterEach, expect, it } from "vitest";
import { fixture } from "./test-support.js";
import { sessionSchema } from "./contracts.js";
import { reviewFailures } from "./review-failures.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() {
  const f = await fixture(); hosts.push(f);
  const task = await f.create();
  const input = f.startInput(task.id, task.revision);
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...input, criteria: [], request: { ...input.request, providerId: "claude-work", model: "claude-opus-5[1m]" } }));
  await f.idle(session.workerThreadId!, "Work finished.");
  return { f, task, session };
}

it("recovers the idle-runtime shutdown race on the first Finish without another review round or a false failure", async () => {
  const { f, task, session } = await setup();
  let stops = 0;
  const dossier = f.repo.kernel.getDossier(task.id);
  f.harness.inspection.sdk.stub("threads.stop", async ({ threadId }) => {
    expect(threadId).toBe(session.workerThreadId);
    expect(f.repo.transcript(session.id)).toBeNull();
    expect(f.repo.session(session.id).status).toBe("collecting");
    if (++stops === 1) {
      // BB reports the idle runtime as shutting down while stop is in flight.
      f.threads.set(threadId, { ...f.threads.get(threadId)!, status: "stopping" });
      await f.harness.behavior.emitThreadEvent("thread.idle", { thread: f.threads.get(threadId)!, lastAssistantText: null });
      throw new Error("HTTP 502: Runtime shutting down");
    }
    f.message(threadId, "assistant", "The final result reached the timeline.");
    f.threads.set(threadId, { ...f.threads.get(threadId)!, status: "idle" });
    return { ok: true };
  });
  await Promise.all([f.harness.behavior.callRpc("finish", { sessionId: session.id }), f.harness.behavior.callRpc("finish", { sessionId: session.id })]);
  expect(stops).toBe(2);
  expect(f.repo.session(session.id)).toMatchObject({ status: "reviewing", round: 0, error: null });
  expect(f.repo.transcript(session.id)!.messages.at(-1)?.text).toBe("The final result reached the timeline.");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2); // Worker and one recorder.
  expect(reviewFailures(f.repo)).toEqual({ total: 0, failures: [] });
  expect(f.repo.db.prepare("SELECT count(*) AS n FROM session_events WHERE session_id=? AND kind='blocked'").get(session.id)).toEqual({ n: 0 });
  expect(f.repo.kernel.getDossier(task.id)).toEqual(dossier);
  f.harness.inspection.sdk.stub("threads.stop", () => ({ ok: true }));
});

it("stops a healthy conversation only once before snapshotting and launching its recorder", async () => {
  const { f, session } = await setup();
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: session.workerThreadId }]]);
  expect(f.repo.session(session.id).status).toBe("reviewing");
});

it.each(["active", "starting", "stopping", "pending"] as const)("does not freeze a transcript while the thread still reports %s after stop", async status => {
  const { f, session } = await setup();
  let stops = 0;
  f.harness.inspection.sdk.stub("threads.stop", ({ threadId }) => {
    f.threads.set(threadId, { ...f.threads.get(threadId)!, status: ++stops === 1 ? status : "idle" });
    return { ok: true };
  });
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  expect(f.repo.session(session.id).status).toBe("collecting");
  expect(f.repo.transcript(session.id)).toBeNull();
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  await f.idle(session.workerThreadId!, "Final response after stopping.");
  expect(f.repo.session(session.id).status).toBe("reviewing");
  expect(f.repo.transcript(session.id)!.messages.at(-1)?.text).toBe("Final response after stopping.");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
});

it.each(["HTTP 502: Host unavailable", "HTTP 403: Permission denied"])("preserves a real stop failure instead of treating it as shutdown: %s", async message => {
  const { f, session } = await setup();
  f.harness.inspection.sdk.stub("threads.stop", () => { throw new Error(message); });
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  expect(f.repo.session(session.id)).toMatchObject({ status: "blocked", error: message });
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(2); // Failed stop and blocked-session cleanup.
  expect(f.repo.transcript(session.id)).toBeNull();
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(reviewFailures(f.repo).total).toBe(1);
});

it("bounds persistent shutdown retries and keeps the failure notification", async () => {
  const { f, session } = await setup();
  f.harness.inspection.sdk.stub("threads.stop", () => { throw new Error("HTTP 502: Runtime shutting down"); });
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  expect(f.repo.session(session.id)).toMatchObject({ status: "blocked", error: "HTTP 502: Runtime shutting down" });
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(6); // Three attempts, plus bounded cleanup.
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(reviewFailures(f.repo).total).toBe(1);
});

it.each(["cancel", "reload"])("does not restart review when %s happens during shutdown recovery", async action => {
  const { f, session } = await setup();
  let entered!: () => void, release!: () => void, stops = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const original = f.harness;
  f.harness.inspection.sdk.stub("threads.stop", async () => {
    if (++stops === 1) { entered(); await pending; throw new Error("HTTP 502: Runtime shutting down"); }
    return { ok: true };
  });
  const finishing = f.harness.behavior.callRpc("finish", { sessionId: session.id });
  await started;
  if (action === "reload") await f.reload();
  else await f.harness.behavior.callRpc("cancel", { sessionId: session.id });
  release();
  if (action === "reload") await expect(finishing).rejects.toThrow(/database connection is not open/);
  else await finishing;
  expect(f.repo.session(session.id).status).toBe(action === "cancel" ? "cancelled" : "blocked");
  expect(f.repo.transcript(session.id)).toBeNull();
  expect(original.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(stops).toBe(2); // Initial stop and explicit cleanup; no retry after cancellation.
});

it("does not retry an uncertain recorder launch even when it reports the same shutdown error", async () => {
  const { f, session } = await setup();
  f.harness.inspection.sdk.stub("threads.spawn", () => { throw new Error("HTTP 502: Runtime shutting down"); });
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  expect(f.repo.session(session.id).status).toBe("blocked");
  expect(f.repo.transcript(session.id)).not.toBeNull();
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2); // Initial worker and one failed launch attempt.
});

async function emptyPendingChat() {
  const f = await fixture({ settings: { threadProjectId: "proj_tasks", composerDefaults: JSON.stringify({ providerId: "claude-work", model: "claude-opus-5[1m]" }) } }); hosts.push(f);
  f.harness.inspection.sdk.stub("projects.get", () => ({ id: "proj_tasks", kind: "standard", sources: [{ type: "local_path", hostId: "host_test", path: "/work", isDefault: true }] }));
  const task = await f.create();
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("openChat", { taskId: task.id, requestId: crypto.randomUUID() }));
  f.conversations.set(session.workerThreadId!, []);
  f.threads.set(session.workerThreadId!, { ...f.threads.get(session.workerThreadId!)!, environmentId: "env_test" });
  f.harness.inspection.sdk.stub("threads.stop", ({ threadId }) => {
    f.threads.set(threadId, { ...f.threads.get(threadId)!, status: "pending" });
    return { ok: true };
  });
  return { f, task, session };
}
it.each([false, true])("reviews an explicitly finished empty pending chat, archived=%s", async archived => {
  const { f, task, session } = await emptyPendingChat();
  if (archived) f.threads.set(session.workerThreadId!, { ...f.threads.get(session.workerThreadId!)!, archivedAt: Date.now() });
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const reviewing = f.repo.session(session.id);
  expect(reviewing).toMatchObject({ status: "reviewing", finishMode: "resolve" });
  expect(f.repo.transcript(session.id)?.messages).toEqual([]);
  await f.idle(reviewing.reviewerThreadId!, { rationale: "No work was done. Keep the task pending after Finish.", facts: [], knowledge: [], reportedTime: null,
    changes: { status: { value: "waiting", evidenceRefs: ["session:finish:pending"] } } });
  expect(f.repo.session(session.id).status).toBe("awaiting_approval");
  expect(f.repo.kernel.getTask(task.id).status).toBe("open");
});
it.each(["queued", "interaction", "background", "history", "missing-page"])("does not treat a pending chat with %s as empty", async reason => {
  const { f, session } = await emptyPendingChat(), threadId = session.workerThreadId!;
  if (reason === "queued") f.queued.set(threadId, [{ id: "queued" }] as never);
  if (reason === "interaction") f.harness.inspection.sdk.stub("threads.interactions.list", () => [{ id: "approval" }] as never);
  if (reason === "background") f.threads.set(threadId, { ...f.threads.get(threadId)!, activeBackgroundAgentCount: 1 });
  if (reason === "history") f.message(threadId, "user", "Please investigate.");
  if (reason === "missing-page") f.harness.inspection.sdk.stub("threads.timeline", () => ({ rows: [], maxSeq: 2, timelinePage: { hasOlderRows: true, olderCursor: { anchorId: "older", anchorSeq: 1 }, kind: "latest", returnedSegmentCount: 0, segmentLimi: 100 } }));
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  expect(f.repo.session(session.id).status).toBe("collecting");
  expect(f.repo.transcript(session.id)).toBeNull();
  expect(f.repo.session(session.id).reviewerThreadId).toBeNull();
});

it("retries an empty pending chat without replacing its frozen transcript", async () => {
  const { f, session } = await emptyPendingChat();
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const reviewing = f.repo.session(session.id), transcript = f.repo.transcript(session.id);
  f.repo.saveSession({ ...reviewing, status: "blocked", error: "Review runtime unavailable" });
  await f.harness.behavior.callRpc("retry", { sessionId: session.id });
  expect(f.repo.session(session.id).status).toBe("reviewing");
  expect(f.repo.session(session.id).reviewerThreadId).not.toBe(reviewing.reviewerThreadId);
  expect(f.repo.transcript(session.id)).toEqual(transcript);
});
