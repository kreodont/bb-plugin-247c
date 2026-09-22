import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { reportsFor } from "./source-sync-test-support.js";
import { SourceSyncRuntime } from "./source-sync.js";
import { syncStartSchema, type SyncRun } from "./contracts.js";
import * as collector from "./source-collector.js";
import type { SourceExport } from "./source-collector.js";
import { type AnalysisWork, analysisExport, planSourceAnalysis, needsDayAnalysis, rekeyAnalysisDocuments } from "./source-analysis.js";
import { digest } from "./repository.js";
import { DayPlanning } from "./day-planning.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
const runtimes: SourceSyncRuntime[] = [];
afterEach(async () => { for (const r of runtimes.splice(0)) r.dispose(); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); vi.restoreAllMocks(); });
function bundleFor(run: SyncRun, bodies = ["First thread", "Second thread"]): SourceExport {
  const calls = [
    { source: "gmail" as const, tool: "gmail.search_threads", args: { query: "is:unread in:inbox" }, output: '{"threads":[]}', read: false },
    { source: "gmail" as const, tool: "gmail.search_threads", args: { query: "after:1234" }, output: '{"threads":[]}', read: false },
    { source: "slack" as const, tool: "slack.slack_search_public_and_private", args: { query: "is:dm" }, output: '{"results":"","has_more":false}', read: false },
    { source: "jira" as const, tool: "jira.searchJiraIssuesUsingJql", args: { jql: "updated >= -1d" }, output: '{"issues":[],"isLast":true}', read: false },
    ...bodies.map((output, i) => ({ source: "gmail" as const, tool: "gmail.get_thread", args: { threadId: `thread${i}` }, output, read: true })),
  ].map((call, i) => ({ ...call, ref: `export:${run.id}:${i}`, completed: true, truncated: false }));
  const reports = reportsFor(calls); reports[0].scanned = bodies.length;
  return { version: 1, runId: run.id, startedAt: run.startedAt, finishedAt: run.until, elapsedMs: 1, calls, reports,
    documents: calls.filter(c => c.read).map(c => ({ ref: c.ref, source: c.source, tool: c.tool, args: c.args, content: c.output })) };
}
async function setup() {
  const f = await fixture(); hosts.push(f);
  let bodies = ["First thread", "Second thread"], partial = false;
  const work: AnalysisWork = { dayWork: {}, dayComplete: true, policy: "" };
  const collect = vi.spyOn(collector, "collectSources").mockImplementation(async run => {
    const b = bundleFor(run, bodies);
    if (partial) b.reports[2] = { ...b.reports[2], status: "partial", paginationComplete: false, detail: "A source page is unavailable." };
    return b;
  });
  const companion = vi.fn(async () => {});
  let runtime = new SourceSyncRuntime(f.bb, f.repo, companion, undefined, undefined, undefined, async () => structuredClone(work)); runtimes.push(runtime);
  async function start(incremental = true) {
    const input = syncStartSchema.parse({ requestId: randomUUID(), since: null, request: f.startInput("unused", 0).request });
    const run = await runtime.start(input, { incremental });
    await vi.waitFor(() => expect(["working", "completed", "partial"]).toContain(runtime.store.run(run.id).status));
    return runtime.store.run(run.id);
  }
  async function finish(run: SyncRun) {
    const bundle = runtime.store.analysisExport(run.id, runtime.store.export(run.id)!);
    const pages = collector.sourceExportPage(bundle, 0).totalPages;
    for (let page = 1; page < pages; page++) runtime.data(run.threadId!, page);
    await runtime.submit(run.threadId!, { suggestions: [], finalize: true });
  }
  async function reload() { runtime.dispose(); await f.reload(); runtime = new SourceSyncRuntime(f.bb, f.repo, companion, undefined, undefined, undefined, async () => structuredClone(work)); runtimes.push(runtime); }
  return { f, get runtime() { return runtime; }, work, collect, companion, start, finish, reload, setBodies: (v: string[]) => { bodies = v; }, setPartial: () => { partial = true; } };
}

it("collects fresh receipts but skips the model for unchanged documents after a successful run and reload", async () => {
  const f = await setup(), first = await f.start(); await f.finish(first); await f.reload();
  const next = await f.start();
  expect(next).toMatchObject({ status: "completed", threadId: null, analysis: { documents: 0, reusedDocuments: 2, modelSkipped: true } });
  expect(f.collect).toHaveBeenCalledTimes(2); expect(f.companion).toHaveBeenCalledTimes(2);
  expect(f.f.threads.size).toBe(1);
  expect(f.runtime.store.checkpoints().gmail).toBe(next.until);
  expect(f.runtime.store.export(next.id)?.documents).toHaveLength(2);
});

it("revisits only completed-task sources once when adopting the follow-up policy", async () => {
  const f = await setup();
  const task = await f.f.create("CASE-42: completed report");
  f.f.repo.kernel.setTaskStatus(task.id, "done", task.revision);
  f.setBodies(["CASE-42: a new reviewer question", "Unrelated unchanged thread"]);
  const first = await f.start(); await f.finish(first);
  const legacy = f.runtime.store.request(first.id).analysis!;
  delete legacy.doneFollowUpPolicy;
  f.runtime.store.saveAnalysis(first.id, legacy);
  await f.reload();
  const next = await f.start();
  expect(next.analysis).toMatchObject({ documents: 1, reusedDocuments: 1, modelSkipped: false });
  expect(f.runtime.data(next.threadId!, 0).documents.map(d => d.content)).toEqual(["CASE-42: a new reviewer question"]);
  await f.finish(next);
  expect((await f.start()).analysis?.modelSkipped).toBe(true);
});

it("pages only changed documents while retaining unchanged context and full receipts on demand", async () => {
  const f = await setup(), first = await f.start(); await f.finish(first);
  f.setBodies(["First thread", "Changed content ".repeat(8000)]);
  const next = await f.start();
  expect(next.analysis).toMatchObject({ documents: 1, reusedDocuments: 1, modelSkipped: false });
  const page = f.runtime.data(next.threadId!, 0);
  expect(page.documents.every(doc => doc.args.threadId === "thread1")).toBe(true);
  expect(page.totalPages).toBeGreaterThan(1);
  await expect(f.runtime.submit(next.threadId!, { suggestions: [], finalize: true })).rejects.toThrow(/export pages/);
  const old = f.runtime.store.export(next.id)!.documents[0];
  expect(f.runtime.context(next.threadId!, 0, old.ref)).toMatchObject({ documents: [{ content: "First thread" }] });
  expect(f.runtime.context(next.threadId!, 0, undefined, "thread0")).toMatchObject({ documents: [{ ref: old.ref }] });
  await f.finish(next);
});

it("does not learn from cancelled or blocked analysis and keeps manual focused checks out of the hourly baseline", async () => {
  const f = await setup(), first = await f.start(); await f.finish(first);
  f.setBodies(["Changed", "Second thread"]);
  const cancelled = await f.start(); await f.runtime.cancel(cancelled.id);
  const retry = await f.start(); expect(retry.analysis?.documents).toBe(1);
  f.runtime.store.save({ ...retry, status: "blocked" });
  const manual = await f.start(false); expect(manual.analysis?.documents).toBe(2); await f.finish(manual);
  const next = await f.start(); expect(next.analysis?.documents).toBe(1);
});

it("rechecks after accepted task or policy changes but preserves partial checkpoints on an unchanged pass", async () => {
  const f = await setup(), first = await f.start(); await f.finish(first);
  await f.f.create(); const changedTask = await f.start(); expect(changedTask.analysis?.documents).toBe(2); await f.finish(changedTask);
  f.work.policy = "New local analysis rule";
  const changedPolicy = await f.start(); expect(changedPolicy.analysis?.documents).toBe(2); await f.finish(changedPolicy);
  const checkpoint = f.runtime.store.checkpoints().jira;
  f.setPartial(); const partial = await f.start();
  expect(partial).toMatchObject({ status: "partial", threadId: null, analysis: { modelSkipped: true } });
  expect(f.runtime.store.checkpoints().jira).toBe(checkpoint);
  expect(f.runtime.store.checkpoints().gmail).toBe(partial.until);
});

it("launches for new day-plan work or incomplete measurements even without changed source documents", async () => {
  const f = await setup(), first = await f.start(); await f.finish(first);
  f.work.dayWork = { task: "new-work" }; const work = await f.start();
  expect(work.analysis).toMatchObject({ documents: 0, modelSkipped: false }); f.runtime.store.recordDayReview(work.id, ["task"]); await f.finish(work);
  expect((await f.start()).analysis?.modelSkipped).toBe(true);
  f.work.dayComplete = false;
  expect((await f.start()).analysis?.modelSkipped).toBe(false);
});

it("keeps work fingerprints stable across AI estimates, but changes them for new work and explicit re-estimation", async () => {
  const f = await fixture(); hosts.push(f); const task = await f.create();
  const days = new DayPlanning(f.repo, () => new Date("2026-09-16T12:00:00Z"));
  days.reconcileActual([{ taskId: task.id, date: "2026-09-16", minutes: 5 }]);
  const item = days.taskItem(task.id, "2026-09-16")!, before = days.analysisWork();
  const estimated = days.estimate({ requestId: randomUUID(), id: item.id, revision: item.revision, reportedMinutes: 30, reason: "Reviewed the implementation and checked the result." }, "analyst");
  expect(days.analysisWork()).toEqual(before);
  days.edit({ requestId: randomUUID(), id: item.id, revision: estimated.revision, restoreAuto: "reported" });
  const requested = days.analysisWork(); expect(requested).not.toEqual(before);
  days.reconcileActual([{ taskId: task.id, date: "2026-09-16", minutes: 7 }]);
  expect(days.analysisWork()).not.toEqual(requested);
});

it("treats changed identities as new documents and never skips incomplete work reconciliation", () => {
  const bundle: SourceExport = { version: 1, runId: "run", startedAt: "", finishedAt: "", elapsedMs: 0, calls: [], reports: [], documents: [{ ref: "old", source: "gmail", tool: "get_thread", args: { threadId: "a" }, content: "same" }] };
  const work: AnalysisWork = { dayWork: {}, dayComplete: true, policy: "" };
  const baseline = planSourceAnalysis(bundle, "context", work, true);
  const moved = { ...bundle, documents: [{ ...bundle.documents[0], ref: "new", args: { threadId: "b" } }] };
  const plan = planSourceAnalysis(moved, "context", work, true, baseline);
  expect(analysisExport(moved, plan).documents).toHaveLength(1);
  expect(needsDayAnalysis({ ...plan, dayComplete: false }, baseline)).toBe(true);
});

it("revisits only the linked source context when one accepted task changes", async () => {
  const f = await fixture(); hosts.push(f);
  const task = await f.create("Investigate https://example.atlassian.net/browse/APP-42");
  const dossier = f.repo.kernel.getDossier(task.id);
  const bundle: SourceExport = { version: 1, runId: "run", startedAt: "", finishedAt: "", elapsedMs: 0, calls: [], reports: [], documents: [
    { ref: "related", source: "jira", tool: "getJiraIssue", args: { issueIdOrKey: "APP-42" }, content: "Unchanged issue" },
    { ref: "unrelated", source: "jira", tool: "getJiraIssue", args: { issueIdOrKey: "APP-99" }, content: "Another issue" },
  ] };
  const work: AnalysisWork = { dayWork: {}, dayComplete: true, policy: "" };
  const baseline = planSourceAnalysis(bundle, "policy", work, true, undefined, [dossier]);
  const changed = structuredClone(dossier); changed.planning.important = true;
  expect(planSourceAnalysis(bundle, "policy", work, true, baseline, [changed]).selectedRefs).toEqual(["related"]);
  expect(planSourceAnalysis(bundle, "policy", work, true, baseline, []).selectedRefs).toEqual(["related"]);
});

it("does not cache day-work review that the analyst never read", async () => {
  const f = await setup(); f.work.dayWork = { item: "new-work" };
  const first = await f.start(); await f.finish(first);
  const retry = await f.start();
  expect(retry.analysis).toMatchObject({ documents: 0, modelSkipped: false });
  expect(f.runtime.store.request(retry.id).analysis?.reviewItemIds).toEqual(["item"]);
});

it("ignores a moving Slack read cutoff while detecting edits, replies, changed threads and read scopes", () => {
  const doc: SourceExport["documents"][number] = { source: "slack", tool: "slack_read_thread", ref: "first", args: { channel_id: "channel-a", message_ts: "123.456", latest: "1000", limit: 1000 }, content: "Original message" };
  const bundle: SourceExport = { version: 1, runId: "run", startedAt: "", finishedAt: "", elapsedMs: 0, calls: [], reports: [], documents: [doc] };
  const work: AnalysisWork = { dayWork: {}, dayComplete: true, policy: "" };
  const baseline = planSourceAnalysis(bundle, "policy", work, true);
  const next = { ...doc, ref: "next", args: { ...doc.args, latest: "2000" } };
  expect(planSourceAnalysis({ ...bundle, documents: [next] }, "policy", work, true, baseline).selectedRefs).toEqual([]);
  for (const changed of [
    { ...next, content: "Edited message" }, { ...next, content: "Original message\nNew reply" },
    { ...next, args: { ...next.args, channel_id: "channel-b" } }, { ...next, args: { ...next.args, message_ts: "789.123" } },
    { ...next, args: { ...next.args, oldest: "500" } }, { ...next, args: { ...next.args, limit: 20 } },
  ]) expect(planSourceAnalysis({ ...bundle, documents: [changed] }, "policy", work, true, baseline).selectedRefs).toEqual(["next"]);
});

it("rekeys legacy completed analysis only from matching saved contents without changing history", () => {
  const doc: SourceExport["documents"][number] = { source: "slack", tool: "slack.slack_read_thread", ref: "first", args: { channel_id: "channel-a", message_ts: "123.456", latest: "1000" }, content: "Original" };
  const bundle: SourceExport = { version: 1, runId: "run", startedAt: "", finishedAt: "", elapsedMs: 0, calls: [], reports: [], documents: [doc] };
  const work: AnalysisWork = { dayWork: {}, dayComplete: true, policy: "" };
  const legacy = planSourceAnalysis(bundle, "policy", work, true);
  legacy.documents = { [digest({ source: doc.source, tool: doc.tool, args: doc.args })]: digest(doc.content) };
  const saved = structuredClone(legacy), migrated = rekeyAnalysisDocuments(legacy, bundle);
  const next = { ...bundle, documents: [{ ...doc, ref: "next", args: { ...doc.args, latest: "2000" } }] };
  expect(planSourceAnalysis(next, "policy", work, true, migrated).selectedRefs).toEqual([]);
  expect(legacy).toEqual(saved);
  expect(rekeyAnalysisDocuments(migrated, bundle)).toEqual(migrated);
  const changed = rekeyAnalysisDocuments(legacy, { ...bundle, documents: [{ ...doc, content: "Unanalyzed change" }] });
  expect(changed).toEqual(legacy);
});

it("reuses legacy Slack analysis across an hourly runtime restart without another model run", async () => {
  const f = await setup();
  f.collect.mockImplementation(async run => {
    const bundle = bundleFor(run);
    const args = { channel_id: "channel-a", message_ts: "123.456", latest: run.until, limit: 1000 };
    const doc = { ref: `slack:${run.id}`, source: "slack" as const, tool: "slack_read_thread", args, content: "Unchanged conversation" };
    bundle.documents = [doc];
    bundle.calls.push({ ...doc, output: doc.content, read: true, completed: true, truncated: false });
    bundle.reports = reportsFor(bundle.calls);
    return bundle;
  });
  const first = await f.start(); await f.finish(first);
  const plan = f.runtime.store.request(first.id).analysis!, doc = f.runtime.store.export(first.id)!.documents[0];
  plan.documents = { [digest({ source: doc.source, tool: doc.tool, args: doc.args })]: digest(doc.content) };
  f.runtime.store.saveAnalysis(first.id, plan);
  await f.reload();
  const next = await f.start();
  expect(next.analysis).toEqual({ documents: 0, reusedDocuments: 1, modelSkipped: true });
  expect(f.f.threads.size).toBe(1);
});
