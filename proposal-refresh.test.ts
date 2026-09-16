import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { proposalRefreshPreviewSchema, proposalSchema, sessionSchema, type Extraction } from "./contracts.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() {
  const f = await fixture(); hosts.push(f);
  const task = await f.create("Original context"), fact = f.repo.detail(task.id).facts[0];
  const proposal = f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: { rationale: "Save the verified result", confidence: 0.9,
    changes: { summary: { value: "Verified result", evidenceRefs: [fact.id] } } } }, "test");
  const preview = () => f.harness.behavior.callRpc("proposalRefreshPreview", { proposalId: proposal.id }).then(value => proposalRefreshPreviewSchema.parse(value));
  const request = (reviewed = false, parts = ["field:summary"]) => ({ proposalId: proposal.id, revision: f.repo.kernel.getTask(task.id).revision, requestId: randomUUID(), reviewed, parts });
  return { f, task, proposal, preview, request };
}

it("refreshes a priority-only conflict without a model or approval, preserves history, and survives retries/reload", async () => {
  const { f, task, proposal, preview, request } = await setup();
  f.repo.classify({ taskId: task.id, revision: 0, urgent: false, important: null });
  f.repo.classify({ taskId: task.id, revision: 1, urgent: false, important: true });
  const before = f.repo.kernel.getDossier(task.id);
  expect((await preview()).safe).toBe(true);
  const input = request(), replacement = proposalSchema.parse(await f.harness.behavior.callRpc("refreshProposal", input));
  expect(replacement).toMatchObject({ baseRevision: before.task.revision, status: "pending", changes: proposal.changes });
  expect(f.repo.kernel.getDossier(task.id)).toEqual(before);
  expect(f.repo.kernel.getProposal(proposal.id)).toMatchObject({ status: "rejected", changes: proposal.changes });
  expect(f.repo.pendingTotal()).toBe(1);
  expect(f.repo.db.prepare("SELECT count(*) AS n FROM proposal_approvals").get()).toEqual({ n: 0 });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  await f.reload();
  expect(await f.harness.behavior.callRpc("refreshProposal", input)).toEqual(replacement);
  await f.harness.behavior.callRpc("accept", { proposalId: replacement.id, revision: replacement.baseRevision });
  expect(f.repo.detail(task.id).projection.summary).toBe("Verified result");
  expect(f.repo.planning(task.id)).toEqual(before.planning);
});

it.each(["context", "status", "missing event", "priority in proposal"])("requires human reconciliation after %s", async kind => {
  const { f, task, proposal, preview, request } = await setup();
  if (kind === "context") f.repo.note({ taskId: task.id, revision: task.revision, kind: "constraint", text: "The result must exclude production data.", requestId: randomUUID() });
  if (kind === "status") f.repo.status(task.id, "done", task.revision);
  if (kind === "missing event") f.repo.db.prepare("UPDATE tasks SET revision=revision+1 WHERE id=?").run(task.id);
  if (kind === "priority in proposal") {
    f.repo.db.prepare("UPDATE proposals SET changes_json=? WHERE id=?").run(JSON.stringify({ ...proposal.changes, urgent: { value: true, evidenceRefs: [f.repo.detail(task.id).facts[0].id] } }), proposal.id);
    f.repo.classify({ taskId: task.id, revision: 0, urgent: false, important: true });
  }
  expect((await preview()).safe).toBe(false);
  await expect(f.harness.behavior.callRpc("refreshProposal", request())).rejects.toThrow(/Review the current task/);
  expect(f.repo.kernel.getProposal(proposal.id).status).toBe("pending");
  const before = f.repo.kernel.getDossier(task.id);
  const next = proposalSchema.parse(await f.harness.behavior.callRpc("refreshProposal", request(true)));
  expect(next.changes).toEqual(proposal.changes);
  expect(f.repo.kernel.getDossier(task.id)).toEqual(before);
});

it("refuses concurrent edits, active work, and invalid selections without retiring the original", async () => {
  const { f, task, proposal, request } = await setup();
  f.repo.classify({ taskId: task.id, revision: 0, urgent: false, important: true });
  const oldInput = request();
  f.repo.note({ taskId: task.id, revision: oldInput.revision, kind: "progress", text: "A later result", requestId: randomUUID() });
  await expect(f.harness.behavior.callRpc("refreshProposal", oldInput)).rejects.toThrow(/changed again/);
  for (const parts of [[], ["field:summary", "field:summary"], ["field:missing"]]) await expect(f.harness.behavior.callRpc("refreshProposal", request(true, parts))).rejects.toThrow();
  await f.start(task.id, request().revision);
  await expect(f.harness.behavior.callRpc("refreshProposal", request(true))).rejects.toThrow(/active work/);
  expect(f.repo.kernel.getProposal(proposal.id).status).toBe("pending");
  expect(f.repo.pendingTotal()).toBe(1);
});

it("preserves a frozen conversation and supporting evidence when only selected knowledge is kept", async () => {
  const f = await fixture(); hosts.push(f); const task = await f.create("Original context");
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  const quote = "Use a single region for this deployment.";
  f.message(session.workerThreadId!, "user", quote); await f.idle(session.workerThreadId!, "Recorded.");
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const transcript = f.repo.transcript(session.id)!;
  const ref = transcript.messages.find(message => message.text === quote)!.ref;
  const extraction: Extraction = { rationale: "Record configuration", facts: [{ kind: "description", text: quote, citations: [{ messageRef: ref, quote }] }],
    changes: { summary: { value: quote, evidenceRefs: ["fact:0"] } }, knowledge: [{ title: "Deployment region", body: quote, tags: [], evidenceRefs: ["fact:0"] }] };
  await f.idle(f.repo.session(session.id).reviewerThreadId!, extraction);
  const old = f.repo.session(session.id).proposalId!;
  f.repo.note({ taskId: task.id, revision: task.revision, kind: "progress", text: "Implementation is pending.", requestId: randomUUID() });
  const revision = f.repo.kernel.getTask(task.id).revision;
  const next = proposalSchema.parse(await f.harness.behavior.callRpc("refreshProposal", { proposalId: old, revision, requestId: randomUUID(), reviewed: true, parts: ["knowledge:0"] }));
  expect(f.repo.session(session.id)).toMatchObject({ proposalId: next.id, status: "awaiting_approval", baseRevision: revision });
  expect(f.repo.transcript(session.id)).toEqual(transcript);
  expect(f.repo.knowledge().total).toBe(0);
  expect(f.repo.partReview("proposal", old)).toMatchObject({ rejected: ["field:summary", "fact:0"], remaining: ["knowledge:0"] });
  await f.harness.behavior.callRpc("accept", { proposalId: next.id, revision });
  expect(f.repo.knowledge().total).toBe(1);
  expect(f.repo.detail(task.id).projection.summary).toBeNull();
  expect(f.repo.detail(task.id).facts).toHaveLength(2);
  expect(f.repo.session(session.id).status).toBe("applied");
  expect(f.repo.transcript(session.id)).toEqual(transcript);
});

it("does not lose the original when replacement validation fails or another window refreshed it first", async () => {
  const { f, task, proposal, request } = await setup();
  f.repo.classify({ taskId: task.id, revision: 0, urgent: false, important: true });
  const original = f.repo.kernel.createProposal.bind(f.repo.kernel);
  // Exercise the production transaction directly, including a failure after insertion.
  const { refreshProposal } = await import("./proposal-refresh.js");
  f.repo.kernel.createProposal = input => { original(input); throw new Error("Replacement validation failed"); };
  expect(() => refreshProposal(f.repo, request())).toThrow("Replacement validation failed");
  expect(f.repo.pendingTotal()).toBe(1);
  expect(f.repo.kernel.getProposal(proposal.id).status).toBe("pending");
  f.repo.kernel.createProposal = original;
  refreshProposal(f.repo, request());
  expect(() => refreshProposal(f.repo, request())).toThrow(/already been reviewed/);
  expect(f.repo.pendingTotal()).toBe(1);
});
