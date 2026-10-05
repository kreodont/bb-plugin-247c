import { afterEach, expect, it } from "vitest";
import { fixture } from "./test-support.js";
import { sessionSchema, sessionStatusSchema } from "./contracts.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });

it("decorates only the main chat during collection, startup and review, without changing the session", async () => {
  const f = await fixture(); hosts.push(f);
  const task = await f.create();
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  for (const status of sessionStatusSchema.options) {
    const saved = f.repo.saveSession({ ...session, status, reviewerThreadId: "review-chat" });
    expect(await f.harness.behavior.callRpc("reviewActivity", {})).toEqual({ threads:
      ["collecting", "review_starting", "reviewing"].includes(status) ? [{ threadId: session.workerThreadId, status }] : [],
    });
    expect(f.repo.session(session.id)).toEqual(saved);
  }
  f.repo.saveSession({ ...session, status: "review_starting", workerThreadId: null });
  expect(await f.harness.behavior.callRpc("reviewActivity", {})).toEqual({ threads: [] });
});

it("follows a finished conversation through review to completion", async () => {
  const f = await fixture(); hosts.push(f);
  const task = await f.create();
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  expect(await f.harness.behavior.callRpc("reviewActivity", {})).toEqual({ threads: [] });
  const review = sessionSchema.parse(await f.harness.behavior.callRpc("finish", { sessionId: session.id }));
  expect(await f.harness.behavior.callRpc("reviewActivity", {})).toEqual({ threads: [{ threadId: session.workerThreadId, status: "reviewing" }] });
  await f.idle(review.reviewerThreadId!, { rationale: "No new records", facts: [], changes: null, knowledge: [] });
  expect(await f.harness.behavior.callRpc("reviewActivity", {})).toEqual({ threads: [] });
});
