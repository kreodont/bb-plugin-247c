import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import * as collector from "./source-collector.js";
import { collectSources, pageState, responseData, sourceExportPage, sourceLinks, type SourceExport } from "./source-collector.js";
import { syncStartSchema, type SyncRun } from "./contracts.js";
import type { SourceConnections } from "./source-connectors.js";
import { SourceSyncStore, syncRanges, validateSyncReports } from "./source-sync.js";
import { fixture } from "./test-support.js";
import { reportsFor } from "./source-sync-test-support.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); vi.restoreAllMocks(); });
function sampleRun(): SyncRun {
  const until = "2026-09-10T12:00:00.000Z";
  return { id: randomUUID(), status: "starting", threadId: null, provider: "codex", model: "gpt-5.6-sol", startedAt: until, finishedAt: null, until, manualSince: null,
    ranges: syncRanges({ gmail: null, slack: null, jira: null }, null, until), reports: [], error: null, suggestions: 0, duplicates: 0, fingerprint: "test" };
}
function bundleFor(run: SyncRun, large = false): SourceExport {
  const calls = [
    { source: "gmail" as const, tool: "gmail.search_threads", args: { query: "is:unread in:inbox" }, output: '{"threads":[]}' },
    { source: "gmail" as const, tool: "gmail.search_threads", args: { query: "after:1234" }, output: '{"threads":[]}' },
    { source: "slack" as const, tool: "slack.slack_search_public_and_private", args: { query: "is:dm" }, output: '{"results":"","has_more":false}' },
    { source: "jira" as const, tool: "jira.searchJiraIssuesUsingJql", args: { jql: "updated >= -1d" }, output: '{"issues":[],"isLast":true}' },
  ].map((c, i) => ({ ...c, ref: `export:${run.id}:${i}`, completed: true, truncated: false, read: false }));
  const reports = reportsFor(calls); reports[0].scanned = 0;
  return { version: 1, runId: run.id, startedAt: run.startedAt, finishedAt: run.until, elapsedMs: 1234, calls, reports,
    documents: large ? [{ ref: calls[0].ref, source: "gmail", tool: "get_thread", args: {}, content: "Контекст. ".repeat(60000) }] : [] };
}

it("uses Jira's response body rather than the unrelated UI graph", () => {
  expect(responseData({ content: [{ type: "text", text: '{"issues":[],"isLast":true}' }], structuredContent: { issues: { nodes: [] }, context: {} } })).toEqual({ issues: [], isLast: true });
  expect(responseData({ content: [{ type: "text", text: '{"key":"APP-123","fields":{}}' }], structuredContent: { issues: { nodes: [] } } }).key).toBe("APP-123");
});
it("follows Slack's prose cursors, refuses an ambiguous full page, and resolves parent threads", () => {
  expect(pageState({ pagination_info: "For the next page of results use cursor `abc=`" }, 20, 20)).toEqual({ token: "abc=", complete: false });
  expect(pageState({ pagination_info: "End of results - No more pages available." }, 20, 20)).toEqual({ complete: true });
  expect(pageState({ threads: [] }, 50, 50)).toEqual({ complete: false });
  const refs = sourceLinks("https://example.slack.com/archives/C123/p1789000001123456?thread_ts=1788990000.654321&cid=C123 https://mail.google.com/mail/u/0/#all/1a089cd34a16fe63 APP-815");
  expect(refs).toEqual({ gmail: ["1a089cd34a16fe63"], slack: [{ channel: "C123", ts: "1788990000.654321" }], jira: ["APP-815"] });
});

it("collects paginated sources in code, deduplicates reads and retains sent replies and cross-source links", async () => {
  const run = sampleRun(), seen: { source: string; tool: string; args: Record<string, any> }[] = [];
  const closed = vi.fn();
  const connections = Object.fromEntries(["gmail", "slack", "jira"].map(source => [source, { close: async () => closed(source), async call(tool: string, args: Record<string, any>) {
    seen.push({ source, tool, args });
    let data: unknown;
    if (tool === "search_threads") data = args.query.includes("is:unread") ? { threads: [] } : args.pageToken ? { threads: [{ id: "1a089cd34a16fe64" }] } : { threads: [{ id: "1a089cd34a16fe63" }], nextPageToken: "page-2" };
    else if (tool === "get_thread") data = { id: args.threadId, messages: [{ id: "m1", sender: "owner@example.com", date: "2026-09-10T10:00:00Z", internalDate: "1789034400000", labelIds: ["SENT"], plaintextBody: "Done. APP-815 https://example.slack.com/archives/C123/p1789000001123456?thread_ts=1788990000.654321" }] };
    else if (tool === "slack_search_public_and_private") data = { results: "No messages found", pagination_info: "End of results - No more pages available." };
    else if (tool === "slack_read_channel") data = { messages: "", pagination_info: "There are no more messages available." };
    else if (tool === "slack_read_thread") data = { messages: "Message TS: 1788990000.654321\nDone", pagination_info: "There are no more messages in this thread." };
    else if (tool === "searchJiraIssuesUsingJql") data = { issues: [{ key: "APP-815", fields: { updated: "2026-09-10T10:00:00Z" } }, { key: "APP-999", fields: { updated: "2026-09-10T18:00:00Z" } }], isLast: true };
    else data = { key: args.issueIdOrKey, fields: { updated: "2026-09-10T10:00:00Z", status: { name: "Done" }, description: "Fixed", comment: { comments: [], total: 0 } }, comments: [] };
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  } }])) as unknown as SourceConnections;
  const bundle = await collectSources(run, [], { connect: async () => connections });
  expect(bundle.reports.every(r => r.status === "complete")).toBe(true);
  expect(seen.filter(c => c.tool === "get_thread")).toHaveLength(2);
  expect(seen.filter(c => c.tool === "slack_read_thread")).toHaveLength(1);
  expect(seen.find(c => c.tool === "slack_read_thread")?.args.message_ts).toBe("1788990000.654321");
  expect(seen.some(c => c.args.issueIdOrKey === "APP-999")).toBe(false);
  expect(seen.filter(c => c.tool === "getJiraIssue")).toHaveLength(1);
  expect(seen.find(c => c.tool === "getJiraIssue")?.args.updateHistory).toBe(false);
  expect(bundle.documents.find(d => d.source === "gmail")?.content).toContain('"SENT"');
  expect(bundle.documents.find(d => d.source === "jira")?.content).toContain('"status":"Done"');
  expect(closed).toHaveBeenCalledTimes(3);
  expect(validateSyncReports(bundle.reports, bundle.calls).every(r => r.status === "complete")).toBe(true);
});

it("marks an export partial on missing pagination and unavailable sources without inventing coverage", async () => {
  const connections: SourceConnections = { slack: { error: "Нет доступа" }, jira: { error: "Нет доступа" }, gmail: { close: async () => {}, async call(tool, args) {
    return { content: [{ type: "text", text: JSON.stringify(tool === "search_threads" ? args.query?.toString().includes("is:unread") ? { threads: [] } : { threads: Array.from({ length: 50 }, () => ({ id: "thread" })) } : { id: "thread", messages: [] }) }] };
  } } };
  const bundle = await collectSources(sampleRun(), [], { connect: async () => connections });
  expect(bundle.reports.map(r => r.status)).toEqual(["partial", "unavailable", "unavailable"]);
  expect(bundle.reports[0].detail).toContain("пагинации");
});

it("retries a transient MCP error payload and does not cite its failed body", async () => {
  let attempts = 0;
  const connections: SourceConnections = { slack: { error: "Нет доступа" }, jira: { error: "Нет доступа" }, gmail: { close: async () => {}, async call() {
    if (++attempts === 1) return { isError: true, content: [{ type: "text", text: "The service is currently unavailable." }] };
    return { content: [{ type: "text", text: '{"threads":[]}' }] };
  } } };
  const bundle = await collectSources(sampleRun(), [], { connect: async () => connections });
  expect(attempts).toBe(3);
  expect(bundle.reports[0].status).toBe("complete");
  expect(bundle.calls.some(c => c.output.includes("currently unavailable"))).toBe(false);
});

it("starts analysis with the chosen non-corporate model only after the export and requires all pages", async () => {
  vi.spyOn(collector, "collectSources").mockImplementation(async run => bundleFor(run, true));
  const f = await fixture(); hosts.push(f);
  const input = syncStartSchema.parse({ requestId: randomUUID(), since: null, request: f.startInput("unused", 0).request });
  const initial = await f.harness.behavior.callRpc("syncStart", input) as SyncRun;
  expect(initial.collection?.phase).toBe("collecting");
  const store = new SourceSyncStore(f.repo);
  await vi.waitFor(() => expect(store.run(initial.id).status).toBe("working"));
  const run = store.run(initial.id), ctx = { threadId: run.threadId!, projectId: "proj_personal", signal: new AbortController().signal };
  const spawn = f.harness.inspection.sdk.callsTo("threads.spawn")[0][0] as Parameters<typeof f.bb.sdk.threads.spawn>[0];
  expect(spawn.providerId).toBe("codex");
  expect(spawn.model).toBe(input.request.model);
  expect(JSON.stringify(spawn.input)).toContain("ГОТОВУЮ выгрузку");
  expect(f.repo.list().total).toBe(0);
  const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ origin: { pluginId: "247c", kind: null }, thread: { id: run.threadId!, title: `247C · обновления · ${run.id}` } }));
  expect(config.tools.map(t => t.name)).toContain("c247_sync_data");
  const bundle = store.export(run.id)!;
  const submission = { suggestions: [], finalize: true };
  await expect(f.harness.behavior.callAgentTool("c247_sync_submit", submission, ctx)).rejects.toThrow(/страницы выгрузки/);
  const pages = sourceExportPage(bundle, 0).totalPages;
  for (let page = 1; page < pages; page++) await f.harness.behavior.callAgentTool("c247_sync_data", { page }, ctx);
  await f.harness.behavior.callAgentTool("c247_sync_submit", submission, ctx);
  expect(store.run(run.id).status).toBe("completed");
  expect(store.checkpoints().gmail).toBe(run.until);
  expect(f.harness.inspection.sdk.callsTo("threads.events.list")).toHaveLength(0);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

it("keeps partial script reports authoritative even when the model claims complete coverage", async () => {
  vi.spyOn(collector, "collectSources").mockImplementation(async run => {
    const bundle = bundleFor(run); bundle.reports[1] = { ...bundle.reports[1], status: "partial", paginationComplete: false, detail: "Осталась страница Slack" }; return bundle;
  });
  const f = await fixture(); hosts.push(f);
  const input = syncStartSchema.parse({ requestId: randomUUID(), since: null, request: f.startInput("unused", 0).request });
  const initial = await f.harness.behavior.callRpc("syncStart", input) as SyncRun;
  const store = new SourceSyncStore(f.repo);
  await vi.waitFor(() => expect(store.run(initial.id).status).toBe("working"));
  const run = store.run(initial.id), bundle = store.export(run.id)!;
  const reports = structuredClone(bundle.reports); reports[1] = { ...reports[1], status: "complete", paginationComplete: true };
  await f.harness.behavior.callAgentTool("c247_sync_submit", { reports, suggestions: [], finalize: true }, { threadId: run.threadId! });
  expect(store.run(run.id).status).toBe("partial");
  expect(store.checkpoints()).toEqual({ gmail: run.until, slack: null, jira: run.until });
});

it("cancels collection without launching a model and retains any returned export", async () => {
  let finish!: (bundle: SourceExport) => void;
  let signal: AbortSignal | undefined;
  vi.spyOn(collector, "collectSources").mockImplementation((_run, _dossiers, options) => { signal = options?.signal; return new Promise(resolve => { finish = resolve; }); });
  const f = await fixture(); hosts.push(f);
  const input = syncStartSchema.parse({ requestId: randomUUID(), since: null, request: f.startInput("unused", 0).request });
  const run = await f.harness.behavior.callRpc("syncStart", input) as SyncRun;
  await f.harness.behavior.callRpc("syncCancel", { runId: run.id });
  expect(signal?.aborted).toBe(true);
  finish(bundleFor(run));
  const store = new SourceSyncStore(f.repo);
  await vi.waitFor(() => expect(store.export(run.id)).not.toBeNull());
  expect(store.run(run.id).status).toBe("cancelled");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  expect(store.checkpoints().gmail).toBeNull();
});
