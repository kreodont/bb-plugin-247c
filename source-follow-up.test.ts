import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./test-support.js";
import { sourceData, startSourceSync } from "./source-sync-test-support.js";
import { SourceSyncStore, validateSyncDraft } from "./source-sync.js";
import { syncAnalysisInstructions, syncInstructions } from "./source-sync-prompt.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); vi.useRealTimers(); });

async function setup(status: "done" | "archived" = "done") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-20T10:00:00Z"));
  const f = await fixture(); hosts.push(f);
  const task = await f.create("CASE-42: prepare the sample report");
  f.repo.kernel.setTaskStatus(task.id, status, task.revision);
  const before = await f.detail(task.id);
  vi.setSystemTime(new Date("2026-09-22T08:00:00Z"));
  const { run } = await startSourceSync(f);
  const { input, calls } = await sourceData(f, run, task.id);
  const draft = input.suggestions[0];
  draft.changes.status = { value: "open", evidenceRefs: ["fact:0"] };
  const store = new SourceSyncStore(f.repo);
  return { f, task, before, run, input, calls, draft, store, snapshots: store.request(run.id).snapshots };
}

it("keeps a fresh follow-up pending and reopens the same task only after human acceptance", async () => {
  const { f, task, before, run, input, calls, store } = await setup();
  store.submit(run.id, input, calls);
  const candidate = store.candidates()[0];
  expect(candidate).toMatchObject({ taskId: task.id, status: "pending", baseRevision: before.task.revision });
  expect(await f.detail(task.id)).toMatchObject({ task: before.task, projection: before.projection, facts: before.facts });
  await f.reload();
  await f.harness.behavior.callRpc("syncAccept", { candidateId: candidate.id });
  const accepted = await f.detail(task.id);
  expect(accepted.task).toMatchObject({ id: task.id, status: "open" });
  expect(accepted.projection.nextStep).toBe(input.suggestions[0].changes.nextStep!.value);
  expect(accepted.planning).toEqual(before.planning);
  expect(accepted.facts).toEqual(expect.arrayContaining(before.facts));
  expect(f.repo.list(true).total).toBe(1);
});

it("preserves the completed task when the user rejects a follow-up", async () => {
  const { f, task, before, run, input, calls, store } = await setup();
  store.submit(run.id, input, calls);
  store.reject(store.candidates()[0].id);
  expect(await f.detail(task.id)).toMatchObject({ task: before.task, projection: before.projection, facts: before.facts });
});

it("merges later findings with a still-pending reopening without losing the original request", async () => {
  const { f, task, before, run, input, calls, store } = await setup();
  store.submit(run.id, input, calls);
  const parent = store.pendingCandidates()[0];
  vi.setSystemTime(new Date("2026-09-23T08:00:00Z"));
  const next = (await startSourceSync(f)).run;
  const fresh = await sourceData(f, next, task.id), draft = fresh.input.suggestions[0];
  draft.mergeCandidateIds = [parent.id];
  draft.facts = [draft.facts[0]];
  draft.changes.summary = { value: "The sender supplied another clarification for the report.", evidenceRefs: ["fact:0"] };
  delete draft.changes.nextStep;
  store.submit(next.id, fresh.input, fresh.calls);
  const combined = store.pendingCandidates();
  expect(combined).toHaveLength(1);
  expect(combined[0].changes.status?.value).toBe("open");
  expect(combined[0].changes.nextStep?.value).toBe(parent.changes.nextStep?.value);
  expect(combined[0].facts).toEqual(expect.arrayContaining(parent.facts));
  expect(store.candidate(parent.id).status).toBe("superseded");
  expect((await f.detail(task.id)).task).toEqual(before.task);
});

it("recovers a missed follow-up from a finished export without applying it or moving checkpoints", async () => {
  const { f, task, before, run, input, calls, store } = await setup();
  store.submit(run.id, { ...input, suggestions: [] }, calls);
  const checkpoints = store.checkpoints(), finishedAt = store.run(run.id).finishedAt;
  store.submit(run.id, input, calls, { supplement: true, finalize: false });
  store.submit(run.id, input, calls, { supplement: true, finalize: false });
  expect(store.candidates()).toHaveLength(1);
  expect(store.checkpoints()).toEqual(checkpoints);
  expect(store.run(run.id).finishedAt).toBe(finishedAt);
  expect((await f.detail(task.id)).task).toEqual(before.task);
});

it.each(["before completion", "outside interval", "old next step", "old status"])("rejects reopening with evidence %s", async reason => {
  const { draft, run, snapshots, calls } = await setup();
  const old = reason === "outside interval" ? "2026-09-20T18:00:00Z" : "2026-09-20T09:00:00Z";
  draft.facts = draft.facts.map((fact, index) => ({ ...fact, citations: fact.citations.map(citation => ({ ...citation,
    occurredAt: reason === "old next step" && index === 0 || reason === "old status" && index === 1 ? citation.occurredAt : old,
  })) }));
  expect(() => validateSyncDraft(draft, run, snapshots, calls)).toThrow(/fresh source request/);
});

it.each(["status", "nextStep"] as const)("requires an explicit %s change for a completed task", async field => {
  const { draft, run, snapshots, calls } = await setup();
  delete draft.changes[field];
  expect(() => validateSyncDraft(draft, run, snapshots, calls)).toThrow(/status=done/);
});

it("keeps archived tasks excluded even when fresh evidence exists", async () => {
  const { draft, run, snapshots, calls } = await setup("archived");
  expect(() => validateSyncDraft(draft, run, snapshots, calls)).toThrow(/status=archived/);
});

it("rejects a follow-up when a human changes the task after the snapshot", async () => {
  const { f, task, before, run, input, calls, store } = await setup();
  f.repo.kernel.setTaskStatus(task.id, "archived", before.task.revision);
  expect(() => store.submit(run.id, input, calls)).toThrow(/dossier changed/);
  expect(store.candidates()).toHaveLength(0);
});

it("supplies the follow-up rule and cutoff in both analyst prompts", async () => {
  const { run, snapshots, calls, input } = await setup();
  const bundle = { version: 1 as const, runId: run.id, startedAt: run.startedAt, finishedAt: run.until, elapsedMs: 1, calls, reports: input.reports, documents: [] };
  for (const prompt of [syncInstructions(run, snapshots, []), syncAnalysisInstructions(run, snapshots, [], bundle)]) {
    expect(prompt).toContain("COMPLETED-TASK FOLLOW-UPS");
    expect(prompt).toContain('"updatedAt":"2026-09-20T10:00:00.000Z"');
    expect(prompt).not.toContain("Update ONLY tasks with status=open");
  }
});
