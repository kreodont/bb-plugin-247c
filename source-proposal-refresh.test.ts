import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { proposalRefreshPreviewSchema, syncCandidateSchema } from "./contracts.js";
import { SourceSyncStore } from "./source-sync.js";
import { refreshSourceProposal } from "./source-proposal-refresh.js";
import { sourceParts } from "./proposal-parts.js";
import { sourceData, startSourceSync, submitSourceData } from "./source-sync-test-support.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() {
  const f = await fixture(); hosts.push(f);
  const task = await f.create("Original context");
  const { run } = await startSourceSync(f), { input } = await sourceData(f, run, task.id);
  await submitSourceData(f, run, input);
  const store = new SourceSyncStore(f.repo), old = store.pendingCandidates()[0];
  f.repo.note({ taskId: task.id, revision: task.revision, kind: "constraint", text: "Keep the approved scope.", requestId: randomUUID() });
  const request = (parts = sourceParts(old)) => ({ proposalId: old.id, revision: f.repo.kernel.getTask(task.id).revision, requestId: randomUUID(), reviewed: true, parts });
  return { f, task, store, old, request };
}

it("replaces a reviewed stale source proposal without applying it, keeps receipts and survives retries", async () => {
  const { f, task, store, old, request } = await setup();
  const preview = proposalRefreshPreviewSchema.parse(await f.harness.behavior.callRpc("sourceProposalRefreshPreview", { proposalId: old.id }));
  expect(preview).toMatchObject({ safe: false, blockedReason: null, revision: request().revision });
  await expect(f.harness.behavior.callRpc("refreshSourceProposal", { ...request(), reviewed: false })).rejects.toThrow(/Review the current task/);
  const before = f.repo.kernel.getDossier(task.id), input = request();
  const replacement = syncCandidateSchema.parse(await f.harness.behavior.callRpc("refreshSourceProposal", input));
  expect(replacement).toMatchObject({ status: "pending", baseRevision: before.task.revision, changes: old.changes, facts: old.facts, runId: old.runId });
  expect(f.repo.kernel.getDossier(task.id)).toEqual(before);
  expect(store.candidate(old.id)).toMatchObject({ status: "superseded", facts: old.facts, partReview: { remainingId: replacement.id, accepted: [] } });
  expect(store.pendingCandidates()).toHaveLength(1);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  await f.reload();
  expect(await f.harness.behavior.callRpc("refreshSourceProposal", input)).toEqual(replacement);
  await f.harness.behavior.callRpc("syncAccept", { candidateId: replacement.id });
  expect(f.repo.detail(task.id).projection.summary).toBe(old.changes.summary!.value);
});

it("keeps only selected parts pending while retaining all supporting quotes", async () => {
  const { f, task, store, old, request } = await setup();
  const replacement = refreshSourceProposal(store, request(["field:summary", "fact:0"]));
  expect(Object.keys(replacement.changes)).toEqual(["summary"]);
  expect(replacement.facts).toEqual(old.facts);
  expect(replacement.recordFactIndexes).toEqual([0]);
  expect(f.repo.partReview("source", old.id)?.rejected).toEqual(["field:nextStep", "field:blockers", "fact:1"]);
  store.accept(replacement.id);
  const detail = f.repo.detail(task.id);
  expect(detail.projection.nextStep).toBeNull();
  expect(detail.facts.some(fact => fact.text === old.facts[1].text)).toBe(false);
  expect(detail.facts.some(fact => fact.text === old.facts[0].text)).toBe(true);
});

it("rejects concurrent edits, invalid parts, already resolved proposals and active work", async () => {
  const { f, task, store, old, request } = await setup();
  const stale = request();
  f.repo.note({ taskId: task.id, revision: stale.revision, kind: "progress", text: "Later context", requestId: randomUUID() });
  expect(() => refreshSourceProposal(store, stale)).toThrow(/changed again/);
  for (const parts of [[], ["field:summary", "field:summary"], ["field:missing"]]) expect(() => refreshSourceProposal(store, request(parts))).toThrow(/distinct parts/);
  const next = refreshSourceProposal(store, request());
  expect(() => refreshSourceProposal(store, request())).toThrow(/already been reviewed/);
  f.repo.note({ taskId: task.id, revision: request().revision, kind: "progress", text: "Another result", requestId: randomUUID() });
  await f.start(task.id, request().revision);
  expect(() => refreshSourceProposal(store, { ...request(), proposalId: next.id })).toThrow(/active work/);
  expect(store.candidate(old.id).status).toBe("superseded");
  expect(store.candidate(next.id).status).toBe("pending");
});

it("preserves the original and rolls back the replacement if saving review history fails", async () => {
  const { f, store, old, request } = await setup();
  vi.spyOn(f.repo, "savePartReview").mockImplementation(() => { throw new Error("history unavailable"); });
  expect(() => refreshSourceProposal(store, request())).toThrow(/history unavailable/);
  expect(store.candidate(old.id).status).toBe("pending");
  expect(store.pendingCandidates().map(item => item.id)).toEqual([old.id]);
});

it.each(["done", "archived"] as const)("does not revive a task closed as %s using old findings", async status => {
  const { f, task, store, old, request } = await setup();
  f.repo.status(task.id, status, request().revision);
  expect(() => refreshSourceProposal(store, request())).toThrow(/requires a proposal to reopen/);
  expect(store.candidate(old.id).status).toBe("pending");
  expect(f.repo.kernel.getTask(task.id).status).toBe(status);
});

it("does not reinterpret positional accepted evidence after the task changes", async () => {
  const { f, task, store, old, request } = await setup();
  const seeded = { ...old, changes: { ...old.changes, summary: { ...old.changes.summary!, evidenceRefs: ["fact:0", "accepted:summary:0"] } } };
  f.repo.db.prepare("UPDATE source_sync_candidates SET value_json=? WHERE id=?").run(JSON.stringify(seeded), old.id);
  const proposal = f.repo.propose({ taskId: task.id, revision: request().revision, requestId: randomUUID(), draft: {
    rationale: "New result", confidence: 1, changes: { summary: { value: "Changed accepted summary", evidenceRefs: [f.repo.detail(task.id).facts[0].id] } },
  } }, "test");
  f.repo.accept(proposal.id, request().revision);
  expect(() => refreshSourceProposal(store, request())).toThrow(/accepted evidence for summary changed/);
  expect(store.candidate(old.id).status).toBe("pending");
});
