import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { sessionSchema, type Extraction, type PartDecision } from "./contracts.js";
import { SourceSyncStore } from "./source-sync.js";
import { sourceData, startSourceSync, submitSourceData } from "./source-sync-test-support.js";
import { mergeSyncDraft } from "./source-sync-merge.js";
import { extractionRefMap, pickExtraction, sourceParts } from "./proposal-parts.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() { const f = await fixture(); hosts.push(f); return f; }
function decision(id: string, revision: number | null, parts: string[], kind: PartDecision["kind"] = "proposal", action: PartDecision["decision"] = "accept"): PartDecision {
  return { kind, id, revision, parts, decision: action, requestId: randomUUID() };
}
async function proposal(f: Awaited<ReturnType<typeof fixture>>) {
  const task = await f.create("Context"), fact = f.repo.detail(task.id).facts[0];
  const p = f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: { rationale: "Review fields", confidence: 1,
    changes: { summary: { value: "Reviewed context", evidenceRefs: [fact.id] }, blockers: { value: [], evidenceRefs: [fact.id] } } } }, "test");
  return { task, p };
}
async function source(f: Awaited<ReturnType<typeof fixture>>, taskId: string | null = null) {
  const { run } = await startSourceSync(f), { input } = await sourceData(f, run, taskId);
  await submitSourceData(f, run, input);
  const store = new SourceSyncStore(f.repo);
  return { store, candidate: store.pendingCandidates()[0], input };
}

it("applies an exact field subset and rebases only its remaining parts; replay is idempotent", async () => {
  const f = await setup(), { task, p } = await proposal(f);
  const input = decision(p.id, task.revision, ["field:summary"]), result = f.repo.reviewParts(input);
  expect(f.repo.detail(task.id).projection.summary).toBe("Reviewed context");
  expect(f.repo.kernel.getProposal(result.remainingId!).changes).toEqual({ blockers: p.changes.blockers });
  expect(f.repo.kernel.getProposal(result.remainingId!).baseRevision).toBe(task.revision + 1);
  expect(f.repo.kernel.getProposal(p.id).changes).toEqual(p.changes);
  const review = f.repo.partReview("proposal", p.id)!;
  expect(f.repo.kernel.getApplicationReceipt(review.acceptedId!).fields).toEqual(["summary"]);
  expect(f.repo.reviewParts(input)).toEqual(result);
  await f.reload(); expect(f.repo.reviewParts(input)).toEqual(result);
  f.repo.accept(result.remainingId!, task.revision + 1);
  expect(f.repo.pendingTotal()).toBe(0);
  const undo = f.repo.kernel.proposeRevert(review.acceptedId!);
  expect(Object.keys(undo.changes)).toEqual(["summary"]);
});

it("rejects selected parts without changing the task and preserves the rest", async () => {
  const f = await setup(), { task, p } = await proposal(f);
  f.repo.markSeen(task.id, task.revision);
  const result = f.repo.reviewParts(decision(p.id, task.revision, ["field:summary"], "proposal", "reject"));
  expect(f.repo.kernel.getTask(task.id)).toEqual(task);
  expect(f.repo.list().tasks[0].unseen).toBeNull();
  expect(f.repo.kernel.getProposal(result.remainingId!).changes).toEqual({ blockers: p.changes.blockers });
  expect(f.repo.partReview("proposal", p.id)).toMatchObject({ accepted: [], rejected: ["field:summary"] });
});

it("rejects stale, duplicate or unknown selections atomically", async () => {
  const f = await setup(), { task, p } = await proposal(f);
  for (const parts of [[], ["field:summary", "field:summary"], ["field:missing"]]) {
    expect(() => f.repo.reviewParts(decision(p.id, task.revision, parts))).toThrow(/Select distinct/);
  }
  f.repo.note({ taskId: task.id, revision: task.revision, kind: "progress", text: "Concurrent edit", requestId: randomUUID() });
  expect(() => f.repo.reviewParts(decision(p.id, task.revision, ["field:summary"]))).toThrow(/changed/);
  expect(f.repo.kernel.getProposal(p.id).status).toBe("pending");
  expect(f.repo.db.prepare("SELECT count(*) AS n FROM application_receipts").get()).toEqual({ n: 0 });
});

it("creates a new task only once and keeps its unaccepted records and fields pending", async () => {
  const f = await setup(), { store, candidate } = await source(f);
  const input = decision(candidate.id, null, ["field:summary", "fact:0"], "source");
  const result = store.reviewParts(input), task = f.repo.detail(result.taskId!);
  expect(f.repo.list().total).toBe(1); expect(task.facts).toHaveLength(1);
  expect(task.projection.nextStep).toBeNull(); expect(f.repo.list().tasks[0].unseen).toBe("new");
  const remainder = store.candidate(result.remainingId!);
  expect(remainder.taskId).toBe(task.task.id); expect(remainder.baseRevision).toBe(task.task.revision);
  expect(sourceParts(remainder)).toEqual(["field:nextStep", "field:blockers", "fact:1"]);
  expect(store.reviewParts(input)).toEqual(result);
  await f.reload(); new SourceSyncStore(f.repo).accept(remainder.id);
  expect(f.repo.list().total).toBe(1); expect(f.repo.detail(task.task.id).facts).toHaveLength(2);
  expect(f.repo.detail(task.task.id).projection.nextStep).toBe(candidate.changes.nextStep!.value);
});

it("does not create a task when only rejecting parts of a new-task proposal", async () => {
  const f = await setup(), { store, candidate } = await source(f);
  const result = store.reviewParts(decision(candidate.id, null, ["field:summary"], "source", "reject"));
  expect(result.taskId).toBeNull(); expect(f.repo.list().total).toBe(0);
  expect(store.candidate(result.remainingId!).changes.summary).toBeUndefined();
});

it("saves records alone without silently accepting their proposed fields", async () => {
  const f = await setup(), task = await f.create("Original"), { store, candidate } = await source(f, task.id);
  const result = store.reviewParts(decision(candidate.id, task.revision, ["fact:0"], "source"));
  expect(f.repo.detail(task.id).projection.summary).toBeNull();
  expect(f.repo.detail(task.id).facts).toHaveLength(2);
  const remaining = store.candidate(result.remainingId!);
  const second = store.reviewParts(decision(remaining.id, remaining.baseRevision, ["fact:1"], "source", "reject"));
  store.accept(second.remainingId!);
  expect(f.repo.detail(task.id).facts).toHaveLength(2);
  expect(f.repo.detail(task.id).projection.nextStep).toBe(candidate.changes.nextStep!.value);
});

it("merges later findings with a partial remainder without reviving reviewed records", async () => {
  const f = await setup(), task = await f.create("Original"), { store, candidate, input } = await source(f, task.id);
  const result = store.reviewParts(decision(candidate.id, task.revision, ["fact:0"], "source", "reject"));
  const parent = store.candidate(result.remainingId!);
  const draft = { ...input.suggestions[0], facts: [...candidate.facts, { ...candidate.facts[0], text: "A later reply" }], changes: { summary: candidate.changes.summary } };
  const merged = mergeSyncDraft(draft, [parent], f.repo.kernel.getDossier(task.id));
  expect(merged.recordFactIndexes).toEqual([1, 2]);
  expect(merged.changes.nextStep).toEqual(parent.changes.nextStep);
  expect(merged.facts[0]).toEqual(candidate.facts[0]); // Preserved as evidence only.
});

it("rolls back source partitions that try to change status during an active session", async () => {
  const f = await setup(), task = await f.create("Original"), { store, candidate } = await source(f, task.id);
  const changed = { ...candidate, changes: { ...candidate.changes, status: { value: "done", evidenceRefs: ["fact:0"] } } };
  f.repo.db.prepare("UPDATE source_sync_candidates SET value_json=? WHERE id=?").run(JSON.stringify(changed), candidate.id);
  await f.start(task.id, task.revision);
  expect(() => store.reviewParts(decision(candidate.id, task.revision, ["field:status"], "source"))).toThrow(/work session/);
  expect(store.pendingCandidates().map(c => c.id)).toEqual([candidate.id]);
  expect(f.repo.partReview("source", candidate.id)).toBeUndefined();
});

it("selects conversation knowledge separately, preserves quotes and resolves the remaining session review", async () => {
  const f = await setup(), task = await f.create("Original");
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] }));
  const quote = "The approved configuration uses a single region.";
  f.message(session.workerThreadId!, "user", quote);
  await f.idle(session.workerThreadId!, "Configuration recorded.");
  await f.harness.behavior.callRpc("finish", { sessionId: session.id });
  const ref = f.repo.transcript(session.id)!.messages.find(m => m.text === quote)!.ref;
  const extraction: Extraction = { rationale: "Save configuration", facts: [{ kind: "description", text: quote, citations: [{ messageRef: ref, quote }] }],
    changes: { summary: { value: quote, evidenceRefs: ["fact:0"] } }, knowledge: [{ title: "Region rule", body: quote, tags: [], evidenceRefs: ["fact:0"] }] };
  await f.idle(f.repo.session(session.id).reviewerThreadId!, extraction);
  const proposalId = f.repo.session(session.id).proposalId!, transcript = f.repo.transcript(session.id);
  const result = await f.harness.behavior.callRpc("reviewParts", decision(proposalId, task.revision, ["knowledge:0"])) as { remainingId: string };
  expect(f.repo.knowledge().total).toBe(1); expect(f.repo.detail(task.id).projection.summary).toBeNull();
  expect(f.repo.detail(task.id).facts).toHaveLength(1);
  expect(f.repo.session(session.id)).toMatchObject({ status: "awaiting_approval", proposalId: result.remainingId });
  expect(f.repo.transcript(session.id)).toEqual(transcript);
  f.repo.reject(result.remainingId);
  expect(f.repo.session(session.id).status).toBe("applied");
  expect(f.repo.knowledge().total).toBe(1); expect(f.repo.pendingTotal()).toBe(0);
});


it("remaps conversation fact references after partitioning without losing unselected supporting evidence", () => {
  const extraction: Extraction = { rationale: "Review", facts: ["Old context", "Send the report"].map((text, i) => ({
    kind: i ? "explicit_next_step" : "description", text, citations: [{ messageRef: `message:${i}`, quote: text }],
  })), changes: { summary: { value: "Ready", evidenceRefs: ["fact:0", "fact:1"] }, nextStep: { value: "Send the report", evidenceRefs: ["fact:1"] } },
    knowledge: [{ title: "Context", body: "Old context", tags: [], evidenceRefs: ["fact:0"] }] };
  const parts = ["field:summary", "field:nextStep", "fact:1", "knowledge:0"];
  const subset = pickExtraction(extraction, parts, "parent");
  expect(subset.facts.map(f => f.text)).toEqual(["Send the report"]);
  expect(subset.changes?.nextStep?.evidenceRefs).toEqual(["fact:0"]);
  expect(subset.changes?.summary?.evidenceRefs).toEqual(["review:parent:fact:0", "fact:0"]);
  expect(subset.knowledge[0].evidenceRefs).toEqual(["review:parent:fact:0"]);
  expect(extractionRefMap(extraction, parts, "parent").get("fact:1")).toBe("fact:0");
  const again = pickExtraction(subset, ["field:summary", "knowledge:0"], "child");
  expect(again.changes?.summary?.evidenceRefs).toEqual(["review:parent:fact:0", "review:child:fact:0"]);
});
