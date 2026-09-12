import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { fixture } from "./test-support.js";
import { syncCandidateSchema, syncRunSchema, syncSubmitSchema } from "./contracts.js";
import { SourceSyncStore, callSource, readSourceCalls, requiredSourceReads, syncRanges, validateSyncReports } from "./source-sync.js";
import { connectorCall, reportsFor, sourceData, startSourceSync, submitSourceData } from "./source-sync-test-support.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() { const f = await fixture(); hosts.push(f); return f; }
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });

it("retains a legacy collector's chosen account, idempotency and read-only task tools", async () => {
  const f = await setup();
  const { run, input } = await startSourceSync(f);
  expect(run).toMatchObject({ status: "working", provider: "claude-work", model: "claude-opus-5[1m]" });
  expect(Date.parse(run.until) - Date.parse(run.ranges.gmail.since)).toBe(86400000);
  expect(await f.harness.behavior.callRpc("syncStart", input)).toEqual(run);
  await expect(f.harness.behavior.callRpc("syncStart", { ...input, since: "2026-01-01T00:00:00Z" })).rejects.toThrow(/launch key/);
  await expect(startSourceSync(f)).rejects.toThrow(/already running/);
  const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ origin: { pluginId: "247c", kind: null }, thread: { id: run.threadId!, title: `247C · updates · ${run.id}` } }));
  expect(config.tools.map((t) => t.name)).toEqual(["c247_day_review", "c247_day_estimate", "c247_sync_calls", "c247_sync_submit", "c247_knowledge", "c247_tasks", "c247_read"]);
  const ctx = { threadId: run.threadId!, projectId: "proj_personal", signal: new AbortController().signal };
  await expect(f.harness.behavior.callAgentTool("c247_create", { title: "Новая", description: "", requestId: randomUUID() }, ctx)).rejects.toThrow(/A worker/);
  expect(f.repo.list().total).toBe(0);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

it("keeps found changes outside the dossier until human acceptance, with one application receipt", async () => {
  const f = await setup(); const task = await f.create(); const before = await f.detail(task.id);
  const { run } = await startSourceSync(f); const { input } = await sourceData(f, run, task.id);
  await submitSourceData(f, run, input);
  const store = new SourceSyncStore(f.repo), candidate = store.candidates()[0];
  expect(store.run(run.id).status).toBe("completed");
  expect(store.checkpoints()).toEqual({ gmail: run.until, slack: run.until, jira: run.until });
  expect((await f.detail(task.id)).projection).toEqual(before.projection);
  expect((await f.detail(task.id)).facts).toEqual(before.facts);
  expect((await f.detail(task.id)).sourceLinks).toEqual([]);
  expect(f.repo.list().tasks[0].pendingCount).toBe(1);
  expect(f.repo.sessions(task.id)).toHaveLength(0);
  await f.harness.behavior.callRpc("syncAccept", { candidateId: candidate.id });
  await f.harness.behavior.callRpc("syncAccept", { candidateId: candidate.id });
  const after = await f.detail(task.id);
  expect(after.task.revision).toBe(before.task.revision + 1);
  expect(after.projection.nextStep).toBe(input.suggestions[0].changes.nextStep!.value);
  expect(after.facts).toHaveLength(before.facts.length + 2);
  expect(after.facts.filter((fact) => fact.source.startsWith("approved-external-sync:"))).toHaveLength(2);
  expect(after.syncUpdates[0]).toMatchObject({ status: "applied", resultTaskId: task.id });
  expect(after.proposals[0].receipt).not.toBeNull();
  expect(after.sourceLinks).toMatchObject([{ url: input.suggestions[0].facts[0].citations[0].url, label: "Gmail message", origin: false }]);
  expect(f.repo.db.prepare("SELECT count(*) AS n FROM application_receipts").get()).toEqual({ n: 1 });
  expect(f.repo.list().tasks[0].pendingCount).toBe(0);
});

it("creates a new task only when its proposal is accepted and retains its citations in the dossier", async () => {
  const f = await setup(); const { run } = await startSourceSync(f); const { input } = await sourceData(f, run);
  await submitSourceData(f, run, input);
  const store = new SourceSyncStore(f.repo); const candidate = store.candidates()[0];
  expect(f.repo.list().total).toBe(0);
  await f.harness.behavior.callRpc("syncAccept", { candidateId: candidate.id });
  const first = f.repo.list().tasks[0];
  await f.harness.behavior.callRpc("syncAccept", { candidateId: candidate.id });
  expect(f.repo.list().total).toBe(1);
  expect(f.repo.list().tasks[0]).toEqual(first);
  const detail = await f.detail(first.id);
  expect(detail.syncUpdates[0].facts[0].citations[0].quote).toBe(input.suggestions[0].facts[0].citations[0].quote);
  expect(detail.sourceLinks).toMatchObject([{ url: input.suggestions[0].facts[0].citations[0].url, origin: true }]);
  // The accepted origin remains accessible after it leaves the recent-history window.
  for (let n = 0; n < 201; n++) {
    const later = { ...detail.syncUpdates[0], id: `later-${n}`, taskId: first.id, status: "rejected" };
    f.repo.db.prepare("INSERT INTO source_sync_candidates VALUES (?,?,?,?,?,?)").run(later.id, later.runId, first.id, later.status, later.id, JSON.stringify(later));
  }
  await f.reload();
  const reloaded = await f.detail(first.id);
  expect(reloaded.syncUpdates).toHaveLength(200);
  expect(reloaded.syncUpdates.some(update => update.id === candidate.id)).toBe(false);
  expect(reloaded.sourceLinks).toEqual(detail.sourceLinks);
  expect(reloaded.task).toEqual(detail.task);
});

it("rejects fabricated quotes, unknown calls, wrong sources, future messages and unsafe links atomically", async () => {
  const f = await setup(); const { run } = await startSourceSync(f); const { input, calls } = await sourceData(f, run);
  for (const changed of [
    { quote: "An invented reply." }, { callRef: "call:invented" }, { source: "slack" },
    { callRef: calls.find((c) => c.source === "gmail" && !c.read)!.ref },
    { messageId: "invented-id" }, { occurredAt: "2999-01-01T00:00:00Z" }, { url: "https://attacker.example/x" },
  ]) {
    const invalid = structuredClone(input);
    Object.assign(invalid.suggestions[0].facts[0].citations[0], changed);
    await expect(submitSourceData(f, run, invalid)).rejects.toThrow();
    expect(new SourceSyncStore(f.repo).candidates()).toHaveLength(0);
    expect(new SourceSyncStore(f.repo).checkpoints().gmail).toBeNull();
  }
  const invalid = structuredClone(input); (invalid.suggestions[0].facts[0] as { kind: string }).kind = "user_instruction";
  expect(syncSubmitSchema.safeParse(invalid).success).toBe(false);
  expect(callSource("mcp__Gmail__send_email")).toBeNull();
  expect(callSource("exec_command")).toBeNull();
});

it("advances only successful sources and preserves the first failed interval across days and reloads", async () => {
  const f = await setup(); const since = "2026-01-01T00:00:00Z";
  const { run } = await startSourceSync(f, since); const { input } = await sourceData(f, run);
  input.suggestions = [];
  Object.assign(input.reports[1], { status: "unavailable", detail: "Slack требует входа", callRefs: [], paginationComplete: false, linkedTasksChecked: false });
  input.reports[2].paginationComplete = false;
  await submitSourceData(f, run, input); await f.reload();
  const store = new SourceSyncStore(f.repo);
  expect(store.run(run.id).status).toBe("partial");
  expect(store.checkpoints()).toEqual({ gmail: run.until, slack: null, jira: null });
  const next = (await startSourceSync(f)).run;
  expect(next.ranges.gmail.since).toBe(run.until);
  expect(next.ranges.slack.since).toBe("2026-01-01T00:00:00.000Z");
  expect(next.ranges.jira.since).toBe("2026-01-01T00:00:00.000Z");
});

it("does not jump over a gap on a manual date override, including before any successful run", async () => {
  const f = await setup(); const first = (await startSourceSync(f, "2026-01-01T00:00:00Z")).run;
  await f.harness.behavior.callRpc("syncCancel", { runId: first.id });
  const later = (await startSourceSync(f, "2026-02-01T03:00:00+03:00")).run;
  const laterData = await sourceData(f, later); laterData.input.suggestions = [];
  await submitSourceData(f, later, laterData.input);
  const store = new SourceSyncStore(f.repo);
  expect(store.checkpoints().gmail).toBeNull();
  expect(store.state().nextSince.gmail).toBe("2026-01-01T00:00:00.000Z");
  const backfill = (await startSourceSync(f, "2025-12-01T00:00:00Z")).run;
  const olderData = await sourceData(f, backfill); olderData.input.suggestions = [];
  await submitSourceData(f, backfill, olderData.input);
  expect(store.checkpoints().gmail).toBe(backfill.until);
  expect(() => syncRanges(store.checkpoints(), "2999-01-01T00:00:00Z", backfill.until)).toThrow(/precede/);
});

it("detects an unfetched pagination token even when the collector claims complete coverage", async () => {
  const f = await setup(); const { run } = await startSourceSync(f); const { calls } = await sourceData(f, run);
  const page = calls.find((c) => c.source === "gmail" && !c.read)!;
  page.output = '{"nextPageToken":"missing-page"}';
  expect(validateSyncReports(reportsFor(calls), calls)[0]).toMatchObject({ status: "partial" });
  calls.push({ ...page, ref: "call:next-page", args: { pageToken: "missing-page" }, output: '{"threads":[]}' });
  expect(validateSyncReports(reportsFor(calls), calls)[0].status).toBe("complete");
});

it("reads long connector results from raw events, including their tail beyond the timeline cap", async () => {
  const f = await setup(); const { run } = await startSourceSync(f);
  const tail = "A decisive new reply at the end of a long thread.";
  connectorCall(f, run.threadId!, "mcp__Gmail__get_thread", { threadId: "long-thread" }, { text: "Earlier context. ".repeat(5000) + tail });
  const calls = await readSourceCalls(f.bb, run.threadId!);
  expect(calls[0].output).toContain(tail);
  expect(calls[0].truncated).toBe(false);
  expect(f.harness.inspection.sdk.callsTo("threads.events.list")[0][0]).toMatchObject({ types: ["item/completed"], order: "asc" });
});

it("requires live reads for Jira keys and source links in open dossiers", async () => {
  const f = await setup(); const task = await f.create("APP-745: https://example.atlassian.net/browse/APP-745");
  const { run } = await startSourceSync(f); const { calls } = await sourceData(f, run);
  const snapshots = [f.repo.kernel.getDossier(task.id)];
  expect(requiredSourceReads(snapshots, "jira")).toEqual(["APP-745"]);
  expect(validateSyncReports(reportsFor(calls), calls, snapshots)[2]).toMatchObject({ status: "partial" });
  connectorCall(f, run.threadId!, "mcp__Atlassian__getJiraIssue", { issueIdOrKey: "APP-745" }, { key: "APP-745", fields: { status: "Review", comment: [] } });
  const more = await readSourceCalls(f.bb, run.threadId!);
  expect(validateSyncReports(reportsFor(more), more, snapshots)[2].status).toBe("complete");
});

it("does not advance a source with an error, missing Gmail search or truncated output", async () => {
  const f = await setup(); const { run } = await startSourceSync(f); const { calls } = await sourceData(f, run);
  for (const property of [{ completed: false }, { truncated: true }]) {
    const copy = structuredClone(calls); Object.assign(copy.find((c) => c.source === "slack")!, property);
    expect(validateSyncReports(reportsFor(copy), copy)[1].status).toBe("partial");
  }
  const reduced = calls.filter((c) => !JSON.stringify(c.args).includes("is:unread"));
  expect(validateSyncReports(reportsFor(reduced), reduced)[0].status).toBe("partial");
});

it("rejects acceptance after a concurrent task edit without leaving a proposal or approval", async () => {
  const f = await setup(); const task = await f.create(); const { run } = await startSourceSync(f); const { input } = await sourceData(f, run, task.id);
  await submitSourceData(f, run, input); const store = new SourceSyncStore(f.repo); const candidate = store.candidates()[0];
  await f.harness.behavior.callRpc("note", { taskId: task.id, revision: task.revision, kind: "decision", text: "Новая договорённость", requestId: randomUUID() });
  await expect(f.harness.behavior.callRpc("syncAccept", { candidateId: candidate.id })).rejects.toThrow(/The dossier changed/);
  expect(store.candidate(candidate.id).status).toBe("pending");
  expect((await f.detail(task.id)).proposals).toHaveLength(0);
  expect((await f.detail(task.id)).projection.summary).toBeNull();
  const next = (await startSourceSync(f, run.ranges.gmail.since)).run;
  const replay = await sourceData(f, next, task.id);
  for (const fact of replay.input.suggestions[0].facts) fact.citations[0].occurredAt = input.suggestions[0].facts[0].citations[0].occurredAt;
  replay.input.suggestions[0].mergeCandidateIds = [candidate.id];
  await submitSourceData(f, next, replay.input);
  expect(store.candidate(candidate.id).status).toBe("superseded");
  const fresh = store.candidates().find((c) => c.status === "pending")!;
  expect(fresh.baseRevision).toBe(task.revision + 1);
  await f.harness.behavior.callRpc("syncAccept", { candidateId: fresh.id });
  expect((await f.detail(task.id)).facts.some((fact) => fact.text === "Новая договорённость")).toBe(true);
});

it("deduplicates a replay, including a new-task finding subsequently matched to its accepted task", async () => {
  const f = await setup(); const { run } = await startSourceSync(f); const first = await sourceData(f, run);
  await submitSourceData(f, run, first.input);
  expect(await submitSourceData(f, run, first.input)).toContain('"canonicalTasksChanged": false');
  const store = new SourceSyncStore(f.repo); const candidate = store.candidates()[0];
  const accepted = await f.harness.behavior.callRpc("syncAccept", { candidateId: candidate.id }) as { task: { id: string } };
  const next = (await startSourceSync(f, run.ranges.gmail.since)).run;
  const replay = await sourceData(f, next, accepted.task.id);
  for (const fact of replay.input.suggestions[0].facts) fact.citations[0].occurredAt = first.citation.occurredAt;
  await submitSourceData(f, next, replay.input);
  expect(store.candidates()).toHaveLength(1);
  expect(store.run(next.id)).toMatchObject({ suggestions: 0, duplicates: 1 });
});

it("keeps failed and cancelled runs durable without creating task sessions or moving checkpoints", async () => {
  const f = await setup(); const { run } = await startSourceSync(f);
  await f.reload(); expect(new SourceSyncStore(f.repo).active()[0].id).toBe(run.id);
  await f.idle(run.threadId!, "Не удалось подключиться к источникам.");
  expect(new SourceSyncStore(f.repo).run(run.id).status).toBe("blocked");
  expect(new SourceSyncStore(f.repo).checkpoints().gmail).toBeNull();
  const next = (await startSourceSync(f)).run; const { input } = await sourceData(f, next);
  expect(syncRunSchema.parse(await f.harness.behavior.callRpc("syncCancel", { runId: next.id })).status).toBe("cancelled");
  await expect(submitSourceData(f, next, input)).rejects.toThrow(/already finished/);
  expect(new SourceSyncStore(f.repo).candidates()).toHaveLength(0);
  await expect(f.harness.behavior.callAgentTool("c247_sync_calls", {}, { threadId: "unrelated" })).rejects.toThrow(/only to the 247C update collector/);
});

it("leaves rejected source findings out of task facts and remembers the rejection", async () => {
  const f = await setup(); const task = await f.create(); const { run } = await startSourceSync(f); const { input } = await sourceData(f, run, task.id);
  await submitSourceData(f, run, input); const store = new SourceSyncStore(f.repo); const candidate = store.candidates()[0];
  const rejected = syncCandidateSchema.parse(await f.harness.behavior.callRpc("syncReject", { candidateId: candidate.id }));
  expect(rejected.status).toBe("rejected");
  expect((await f.detail(task.id)).facts).toHaveLength(1);
  await expect(f.harness.behavior.callRpc("syncAccept", { candidateId: candidate.id })).rejects.toThrow(/rejected/);
});
