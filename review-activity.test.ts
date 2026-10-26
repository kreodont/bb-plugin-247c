import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { sessionSchema, sessionStatusSchema, type Extraction } from "./contracts.js";

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

it.each(["accept", "reject"] as const)("keeps the main chat marked across reads, restart and partial approval, until %s resolves the remainder", async decision => {
  const f = await fixture(); hosts.push(f);
  const task = await f.create();
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  const quote = "The configuration is ready.";
  f.message(session.workerThreadId!, "user", quote);
  await f.idle(session.workerThreadId!, "Verified the configuration.");
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const ref = f.repo.transcript(session.id)!.messages.find(m => m.text === quote)!.ref;
  const extraction: Extraction = { rationale: "Save completed work", facts: [{ kind: "progress", text: quote, citations: [{ messageRef: ref, quote }] }],
    changes: { summary: { value: quote, evidenceRefs: ["fact:0"] } }, knowledge: [] };
  await f.idle(f.repo.session(session.id).reviewerThreadId!, extraction);
  const ready = { threads: [{ threadId: session.workerThreadId, status: "awaiting_approval" }] };
  const activity = () => f.harness.behavior.callRpc("reviewActivity", {});
  expect(await activity()).toEqual(ready);
  await f.harness.behavior.callRpc("threadSession", { threadId: session.workerThreadId });
  await f.reload();
  expect(await activity()).toEqual(ready);
  const original = f.repo.session(session.id).proposalId!;
  await f.harness.behavior.callRpc("reviewParts", { kind: "proposal", id: original, revision: task.revision,
    decision: "accept", parts: ["field:summary"], requestId: randomUUID() });
  const remaining = f.repo.session(session.id).proposalId!;
  expect(remaining).not.toBe(original);
  expect(await activity()).toEqual(ready);
  await f.harness.behavior.callRpc(decision, { proposalId: remaining, ...(decision === "accept" ? { revision: f.repo.kernel.getTask(task.id).revision } : {}) });
  expect(await activity()).toEqual({ threads: [] });
  // Even a stale session flag cannot recreate a resolved proposal's badge.
  f.repo.saveSession({ ...f.repo.session(session.id), status: "awaiting_approval" });
  expect(await activity()).toEqual({ threads: [] });
});
