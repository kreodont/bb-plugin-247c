import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { connectorCall, reportsFor, sourceData, startSourceSync, submitSourceData } from "./source-sync-test-support.js";
import { SourceSyncStore, readSourceCalls, validateSyncReports } from "./source-sync.js";
import { syncAnalysisInstructions } from "./source-sync-prompt.js";
import { collectSources, type SourceExport } from "./source-collector.js";
import type { SyncCandidate, SyncRun, SyncSubmit } from "./contracts.js";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() { const f = await fixture(); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.harness.lifecycle.dispose(); });

async function finding(f: Awaited<ReturnType<typeof fixture>>, run: SyncRun, taskId: string | null, title = "Prepare report") {
  await sourceData(f, run, taskId);
  const messageId = randomUUID(), threadId = messageId.replaceAll("-", "").slice(0, 16);
  const step = "Send the report with the latest approved figures.";
  const quote = "The report is urgent. " + step;
  connectorCall(f, run.threadId!, "mcp__Gmail__get_thread", { threadId }, { messages: [{ id: messageId, text: quote }] });
  const calls = await readSourceCalls(f.bb, run.threadId!);
  const citation = { callRef: calls[calls.length - 1].ref, source: "gmail" as const, url: "https://mail.google.com/mail/u/0/#all/" + threadId,
    messageId, occurredAt: new Date(Date.parse(run.until) - 1000).toISOString(), quote };
  const input: SyncSubmit = { reports: reportsFor(calls), suggestions: [{ taskId, title, rationale: "The sender supplied the approved figures.", confidence: 0.9,
    facts: [{ kind: "progress", text: "Approved figures arrived.", citations: [citation] }, { kind: "explicit_next_step", text: step, citations: [citation] }],
    changes: { summary: { value: "The report now has approved figures.", evidenceRefs: ["fact:0"] }, nextStep: { value: step, evidenceRefs: ["fact:1"] } } }] };
  return { input, calls, citation };
}

function legacySnapshot(store: SourceSyncStore, runId: string) {
  const { pendingCandidates: _pending, ...request } = store.request(runId);
  store.repo.db.prepare("UPDATE source_sync_runs SET request_json=? WHERE id=?").run(JSON.stringify(request), runId);
}

it("merges a missed task update, preserving earlier facts and untouched fields until one human approval", async () => {
  const f = await setup(), task = await f.create("Report"), before = await f.detail(task.id);
  const store = new SourceSyncStore(f.repo);
  const first = (await startSourceSync(f)).run, older = await finding(f, first, task.id);
  older.input.suggestions[0].facts.push({ kind: "decision", text: "The report is urgent.", citations: [older.citation] });
  older.input.suggestions[0].changes.urgent = { value: true, evidenceRefs: ["fact:2"] };
  await submitSourceData(f, first, older.input);
  const parent = store.pendingCandidates()[0], oldRun = store.run(first.id);
  const next = (await startSourceSync(f)).run, fresh = await finding(f, next, task.id);
  expect(store.request(next.id).pendingCandidates).toEqual([parent]);
  const draft = fresh.input.suggestions[0];
  draft.mergeCandidateIds = [parent.id];
  delete draft.changes.nextStep;
  draft.changes.summary!.value = "Approved figures arrived; the urgent report is ready for preparation.";
  await submitSourceData(f, next, fresh.input);
  const combined = store.pendingCandidates()[0];
  expect(store.pendingCandidates()).toHaveLength(1);
  expect(combined).toMatchObject({ mergeCandidateIds: [parent.id], runId: next.id, changes: { urgent: { value: true }, nextStep: { value: parent.changes.nextStep!.value } } });
  expect(combined.id).not.toBe(parent.id);
  expect(combined.facts).toEqual(expect.arrayContaining(parent.facts));
  expect(store.candidate(parent.id)).toEqual({ ...parent, status: "superseded", resolvedAt: expect.any(String) });
  expect(store.run(first.id)).toEqual(oldRun);
  expect((await f.detail(task.id)).projection).toEqual(before.projection);
  expect((await f.detail(task.id)).facts).toEqual(before.facts);
  expect(() => store.accept(parent.id)).toThrow(/superseded/);
  store.accept(combined.id); store.accept(combined.id);
  expect(f.repo.db.prepare("SELECT count(*) AS n FROM application_receipts").get()).toEqual({ n: 1 });
  const after = await f.detail(task.id);
  expect(after.planning.urgent).toBe(true);
  expect(after.projection.nextStep).toBe(parent.changes.nextStep!.value);
  expect(after.projection.summary).toBe(draft.changes.summary!.value);
});

it("consolidates several previously missed checks and does not churn an unchanged combined proposal", async () => {
  const f = await setup(), task = await f.create("Report"), store = new SourceSyncStore(f.repo);
  for (let n = 0; n < 2; n++) {
    const run = (await startSourceSync(f)).run;
    legacySnapshot(store, run.id);
    const data = await finding(f, run, task.id);
    data.input.suggestions[0].changes.summary!.value += " Part " + n;
    await submitSourceData(f, run, data.input);
  }
  const parents = store.pendingCandidates();
  expect(parents).toHaveLength(2);
  const run = (await startSourceSync(f)).run, data = await finding(f, run, task.id);
  data.input.suggestions[0].mergeCandidateIds = parents.map(p => p.id);
  data.input.suggestions[0].changes.summary!.value = "Both earlier report parts and the latest figures are ready.";
  await submitSourceData(f, run, data.input);
  const combined = store.pendingCandidates()[0];
  expect(store.pendingCandidates()).toHaveLength(1);
  expect(combined.facts.flatMap(f => f.citations).map(c => c.messageId)).toEqual(expect.arrayContaining(parents.flatMap(p => p.facts.flatMap(f => f.citations.map(c => c.messageId)))));
  expect(parents.every(p => store.candidate(p.id).status === "superseded")).toBe(true);
  const unchanged = (await startSourceSync(f)).run;
  const replay = structuredClone(data.input);
  replay.suggestions[0].mergeCandidateIds = [combined.id];
  replay.reports = reportsFor([]).map(r => ({ ...r, status: "unavailable" }));
  store.submit(unchanged.id, replay, []);
  expect(store.pendingCandidates()).toEqual([combined]);
  expect(store.run(unchanged.id)).toMatchObject({ suggestions: 0, duplicates: 1 });
});

it("combines pending new-task proposals even after a title changes, and creates only one task on acceptance", async () => {
  const f = await setup(), store = new SourceSyncStore(f.repo);
  const first = (await startSourceSync(f)).run, older = await finding(f, first, null);
  await submitSourceData(f, first, older.input);
  const parent = store.pendingCandidates()[0];
  const next = (await startSourceSync(f)).run, data = await finding(f, next, null, "Prepare the final report");
  data.input.suggestions[0].mergeCandidateIds = [parent.id];
  await submitSourceData(f, next, data.input);
  expect(f.repo.list().total).toBe(0);
  expect(store.pendingCandidates()).toHaveLength(1);
  store.accept(store.pendingCandidates()[0].id);
  expect(f.repo.list().tasks.map(t => t.title)).toEqual(["Prepare the final report"]);
  expect(() => store.accept(parent.id)).toThrow(/superseded/);
});

it.each(["accept", "reject"] as const)("preserves a concurrent human %s and rolls back the entire replacement batch", async decision => {
  const f = await setup(), a = await f.create("A"), b = await f.create("B"), store = new SourceSyncStore(f.repo);
  const first = (await startSourceSync(f)).run, older = await finding(f, first, a.id);
  await submitSourceData(f, first, older.input);
  const parent = store.pendingCandidates()[0], checkpoints = store.checkpoints();
  const next = (await startSourceSync(f)).run, data = await finding(f, next, a.id);
  store[decision](parent.id);
  const resolved = store.candidate(parent.id);
  data.input.suggestions[0].mergeCandidateIds = [parent.id];
  const unrelated = structuredClone(data.input.suggestions[0]); unrelated.taskId = b.id; delete unrelated.mergeCandidateIds;
  data.input.suggestions.unshift(unrelated);
  await expect(submitSourceData(f, next, data.input)).rejects.toThrow(/reviewed or superseded/);
  expect(store.candidate(parent.id)).toEqual(resolved);
  expect(store.candidates()).toHaveLength(1);
  expect(store.checkpoints()).toEqual(checkpoints);
  expect(store.run(next.id)).toMatchObject({ status: "working", suggestions: 0 });
});

it("requires explicit matching parents, validates new quotes, and preserves unrelated requests", async () => {
  const f = await setup(), task = await f.create("Report"), store = new SourceSyncStore(f.repo);
  const first = (await startSourceSync(f)).run, older = await finding(f, first, task.id);
  await submitSourceData(f, first, older.input);
  const parent = store.pendingCandidates()[0];
  const next = (await startSourceSync(f)).run, data = await finding(f, next, task.id);
  await expect(submitSourceData(f, next, data.input)).rejects.toThrow(/mergeCandidateIds/);
  data.input.suggestions[0].mergeCandidateIds = [parent.id];
  const invented = structuredClone(data.input);
  invented.suggestions[0].facts[0] = { ...parent.facts[0], text: "An invented fact", citations: [{ ...parent.facts[0].citations[0], quote: "Not a saved source quote" }] };
  await expect(submitSourceData(f, next, invented)).rejects.toThrow(/quote/);
  expect(store.pendingCandidates()).toEqual([parent]);
  const unrelated = structuredClone(data.input); unrelated.suggestions[0].taskId = null; unrelated.suggestions[0].title = "A separate request"; delete unrelated.suggestions[0].mergeCandidateIds;
  await submitSourceData(f, next, unrelated);
  expect(store.pendingCandidates()).toHaveLength(2);
  expect(store.candidate(parent.id)).toEqual(parent);
});

it("keeps distinct new requests from the same message separate", async () => {
  const f = await setup(), store = new SourceSyncStore(f.repo);
  const run = (await startSourceSync(f)).run, data = await finding(f, run, null, "First request");
  const second = structuredClone(data.input.suggestions[0]); second.title = "Second independent request";
  data.input.suggestions.push(second);
  await submitSourceData(f, run, data.input);
  expect(store.pendingCandidates()).toHaveLength(2);
});

it("retries an explicit merge after reload and finalizes without replacing its new approval ID again", async () => {
  const f = await setup(), task = await f.create("Report"), store = new SourceSyncStore(f.repo);
  const first = (await startSourceSync(f)).run, older = await finding(f, first, task.id);
  await submitSourceData(f, first, older.input);
  const parent = store.pendingCandidates()[0];
  const next = (await startSourceSync(f)).run, data = await finding(f, next, task.id);
  data.input.suggestions[0].mergeCandidateIds = [parent.id];
  store.submit(next.id, data.input, data.calls, { finalize: false });
  const combined = store.pendingCandidates()[0];
  await f.reload();
  const reloaded = new SourceSyncStore(f.repo);
  reloaded.submit(next.id, data.input, data.calls, { finalize: true });
  expect(reloaded.pendingCandidates()).toEqual([combined]);
  expect(reloaded.candidate(parent.id).status).toBe("superseded");
  expect(reloaded.run(next.id).status).not.toBe("working");
});

it("requires explicit reconciliation of untouched fields when the previous dossier revision is stale", async () => {
  const f = await setup(), task = await f.create("Report"), store = new SourceSyncStore(f.repo);
  const first = (await startSourceSync(f)).run, older = await finding(f, first, task.id);
  await submitSourceData(f, first, older.input);
  const parent = store.pendingCandidates()[0];
  await f.harness.behavior.callRpc("note", { taskId: task.id, revision: task.revision, kind: "decision", text: "The scope changed.", requestId: randomUUID() });
  const next = (await startSourceSync(f)).run, data = await finding(f, next, task.id);
  data.input.suggestions[0].mergeCandidateIds = [parent.id];
  const incomplete = structuredClone(data.input); delete incomplete.suggestions[0].changes.nextStep;
  await expect(submitSourceData(f, next, incomplete)).rejects.toThrow(/Reconcile the previous nextStep/);
  expect(store.pendingCandidates()).toEqual([parent]);
  await submitSourceData(f, next, data.input);
  expect(store.pendingCandidates()[0].baseRevision).toBe(task.revision + 1);
});

it("includes pending proposals beyond the display limit in the run snapshot", async () => {
  const f = await setup(), store = new SourceSyncStore(f.repo);
  const first = (await startSourceSync(f)).run, data = await finding(f, first, null);
  await submitSourceData(f, first, data.input);
  const parent = store.pendingCandidates()[0];
  for (let n = 0; n < 300; n++) {
    const id = randomUUID(), copy = { ...parent, id, title: "Independent request " + n };
    f.repo.db.prepare("INSERT INTO source_sync_candidates VALUES (?,?,?,?,?,?)").run(id, first.id, null, "pending", id, JSON.stringify(copy));
  }
  expect(store.candidates().length).toBeLessThanOrEqual(300);
  const next = (await startSourceSync(f)).run;
  expect(store.request(next.id).pendingCandidates).toHaveLength(301);
});

it("rechecks pending proposal sources without counting their saved receipts as fresh coverage", async () => {
  const f = await setup(), store = new SourceSyncStore(f.repo);
  const first = (await startSourceSync(f)).run, data = await finding(f, first, null);
  await submitSourceData(f, first, data.input);
  const parent: SyncCandidate = { ...store.pendingCandidates()[0], title: "APP-123", facts: [], changes: {}, rationale: "Read https://example.atlassian.net/browse/APP-123" };
  const next = (await startSourceSync(f)).run;
  const issues: unknown[] = [];
  const bundle = await collectSources(next, [], { pendingCandidates: [parent], connect: async () => ({
    gmail: { error: "No access" }, slack: { error: "No access" },
    jira: { close: async () => {}, call: async (tool, args) => {
      if (tool === "searchJiraIssuesUsingJql") return { content: [{ type: "text", text: '{"issues":[],"isLast":true}' }] };
      issues.push(args.issueIdOrKey);
      return { content: [{ type: "text", text: '{"key":"APP-123","fields":{"comment":{"comments":[],"total":0}}}' }] };
    } },
  }) });
  expect(issues).toEqual(["APP-123"]);
  expect(validateSyncReports(bundle.reports, bundle.calls, [], [parent])[2].status).toBe("complete");
  const searches = bundle.calls.filter(c => !c.read);
  expect(validateSyncReports(reportsFor(searches), searches, [], [parent])[2].status).toBe("partial");
});

it("gives the analyst the complete unreviewed proposals and explicit merge rules", async () => {
  const f = await setup(), store = new SourceSyncStore(f.repo);
  const first = (await startSourceSync(f)).run, data = await finding(f, first, null);
  await submitSourceData(f, first, data.input);
  const next = (await startSourceSync(f)).run;
  const pending = store.request(next.id).pendingCandidates!;
  const bundle: SourceExport = { version: 1, runId: next.id, startedAt: next.startedAt, finishedAt: next.until, elapsedMs: 1, calls: [], reports: [], documents: [] };
  const prompt = syncAnalysisInstructions(next, [], pending, bundle);
  expect(prompt).toContain(JSON.stringify(pending));
  expect(prompt).toContain("mergeCandidateIds");
  expect(prompt).toContain("One unchanged pending proposal needs no resubmission");
  expect(prompt).toContain("Previous receipts never prove current source coverage");
});
