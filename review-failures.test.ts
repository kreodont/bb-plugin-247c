import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { sessionSchema } from "./contracts.js";
import { reviewFailures } from "./review-failures.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() { const f = await fixture(); hosts.push(f); const task = await f.create();
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  return { f, task, session };
}

it("reports a persistent 502 after bounded stop recovery and keeps the same incident across reload", async () => {
  const { f, task, session } = await setup();
  const before = f.repo.kernel.getDossier(task.id);
  f.harness.inspection.sdk.stub("threads.stop", async () => { throw new Error("HTTP 502: Runtime shutting down"); });
  const finished = sessionSchema.parse(await f.harness.behavior.callRpc("finish", { sessionId: session.id }));
  expect(finished).toMatchObject({ status: "blocked", reviewerThreadId: null, error: "HTTP 502: Runtime shutting down" });
  expect(f.repo.transcript(session.id)).toBeNull();
  const failures = reviewFailures(f.repo);
  expect(failures).toMatchObject({ total: 1, failures: [{ sessionId: session.id, taskId: task.id, taskTitle: task.title, error: "HTTP 502: Runtime shutting down" }] });
  expect(f.repo.list().tasks[0].failedReviewId).toBe(session.id);
  expect(f.repo.kernel.getDossier(task.id)).toEqual(before);
  expect(f.repo.pendingTotal()).toBe(0);
  await f.reload();
  expect(await f.harness.behavior.callRpc("reviewFailures", {})).toEqual(failures);
  expect(f.threads.size).toBe(1);
  expect(await f.harness.behavior.callRpc("threadSession", { threadId: session.workerThreadId! })).toMatchObject({ session: { status: "blocked", finishedAt: finished.finishedAt } });
});

it("clears on retry, creates a new incident on another failure and clears after successful review", async () => {
  const { f, task, session } = await setup();
  f.repo.saveSession({ ...session, status: "blocked", finishedAt: new Date().toISOString(), error: "HTTP 502: Runtime shutting down" });
  const first = reviewFailures(f.repo).failures[0];
  const retried = sessionSchema.parse(await f.harness.behavior.callRpc("retry", { sessionId: session.id }));
  expect(retried.status).toBe("reviewing");
  expect(reviewFailures(f.repo).total).toBe(0);
  const thread = { ...f.threads.get(retried.reviewerThreadId!)!, status: "error" as const };
  f.threads.set(thread.id, thread);
  await f.harness.behavior.emitThreadEvent("thread.failed", { thread, error: "Provider unavailable" });
  const next = reviewFailures(f.repo).failures[0];
  expect(next.sessionId).toBe(first.sessionId);
  expect(next.incidentId).not.toBe(first.incidentId);
  const last = sessionSchema.parse(await f.harness.behavior.callRpc("retry", { sessionId: session.id }));
  await f.idle(last.reviewerThreadId!, { rationale: "No new records", facts: [], changes: null, knowledge: [] });
  expect(f.repo.session(session.id).status).toBe("completed");
  expect(reviewFailures(f.repo)).toEqual({ total: 0, failures: [] });
  expect(f.repo.list().tasks[0].failedReviewId).toBeNull();
  expect(f.repo.kernel.getTask(task.id).status).toBe("open");
});

it("does not alert for worker startup failures, cancellations or historical closed work", async () => {
  const { f, task, session } = await setup();
  f.repo.saveSession({ ...session, status: "blocked", error: "Could not start chat" });
  expect(reviewFailures(f.repo).total).toBe(0);
  f.repo.saveSession({ ...session, status: "cancelled", finishedAt: new Date().toISOString(), error: "Stopped by user" });
  expect(reviewFailures(f.repo).total).toBe(0);
  f.repo.saveSession({ ...session, status: "blocked", finishedAt: new Date().toISOString(), error: "Review failed" });
  f.repo.status(task.id, "waiting", task.revision);
  expect(reviewFailures(f.repo).total).toBe(1);
  f.repo.status(task.id, "done", task.revision + 1);
  expect(reviewFailures(f.repo).total).toBe(0);
  f.repo.saveSession({ ...f.repo.session(session.id), continuedFrom: "previous-session" });
  expect(reviewFailures(f.repo).total).toBe(1);
});

it("replaces an ancestor alert with its failed discussion and leaves unrelated failed sessions visible", async () => {
  const { f, task, session } = await setup();
  const failed = f.repo.saveSession({ ...session, status: "blocked", finishedAt: new Date().toISOString(), error: "Parent review failed" });
  const childId = randomUUID();
  f.repo.insertSession({ ...failed, id: childId, continuedFrom: session.id, error: "Discussion review failed" }, {});
  expect(reviewFailures(f.repo).failures.map(failure => failure.sessionId)).toEqual([childId]);
  const unrelated = randomUUID();
  f.repo.insertSession({ ...failed, id: unrelated, error: "Another independent review failed" }, {});
  expect(reviewFailures(f.repo).total).toBe(2);
  f.repo.saveSession({ ...f.repo.session(childId), status: "completed" });
  expect(reviewFailures(f.repo).failures.map(failure => failure.sessionId)).toEqual([unrelated]);
  expect(f.repo.list().tasks[0].failedReviewId).toBe(unrelated);
  expect(f.repo.kernel.getTask(task.id).status).toBe("open");
});

it("exposes failures caused by plugin reload before a review can finish", async () => {
  const { f, session } = await setup();
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  expect(f.repo.session(session.id).status).toBe("reviewing");
  await f.reload();
  expect(reviewFailures(f.repo)).toMatchObject({ total: 1, failures: [{ sessionId: session.id, error: expect.stringMatching(/plugin reload/) }] });
});
