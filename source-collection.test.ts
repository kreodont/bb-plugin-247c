import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import * as collector from "./source-collector.js";
import { collectSources, pageState, sourceRetryDelay, responseData, sourceExportPage, sourceLinks, type SourceExport } from "./source-collector.js";
import { syncStartSchema, type SyncRun } from "./contracts.js";
import type { SourceConnections } from "./source-connectors.js";
import { SourceSyncStore, requiredSourceReads, syncRanges, validateSyncReports } from "./source-sync.js";
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

it("requires the parent thread for a Slack reply link, even after the reply is deleted", () => {
  const text = "https://acme.slack.com/archives/C0123456789/p1789561088151039?thread_ts=1789019275.984449&cid=C0123456789 https://acme.slack.com/archives/C0123456789/p1789000000000100";
  const dossiers = [{ task: { status: "open" }, text }] as unknown as Parameters<typeof collectSources>[1];
  expect(requiredSourceReads(dossiers, "slack")).toEqual(["1789019275.984449", "1789000000.000100"]);
  expect(requiredSourceReads(dossiers, "slack")).toEqual(sourceLinks(text).slack.map(s => s.ts));
  const read = (ts: string, ref: string) => ({ ref, source: "slack" as const, tool: "slack.slack_read_thread", args: { channel_id: "C0123456789", message_ts: ts }, output: `{"messages":"Message TS: ${ts}\\nThere are no more messages in this thread."}`, completed: true, truncated: false, read: true });
  const search = { ref: "s", source: "slack" as const, tool: "slack.slack_search_public_and_private", args: { query: "is:dm" }, output: '{"results":"","has_more":false}', completed: true, truncated: false, read: false };
  const calls = [search, read("1789019275.984449", "a"), read("1789000000.000100", "b")];
  const [report] = validateSyncReports([{ source: "slack", status: "complete", detail: "ok", callRefs: calls.map(c => c.ref), paginationComplete: true, linkedTasksChecked: true, scanned: 2, threadsRead: 2 }], calls, dossiers);
  expect(report.status).toBe("complete");
});

it("excludes quote numbers and UUID fragments consistently from collection and coverage", () => {
  const text = "Q-12345 12345678-ABC4-4321-89AB-123456789ABC APP-815 https://example.atlassian.net/browse/APP-815 https://example.atlassian.net/browse/Q-42";
  const dossiers = [{ task: { status: "open" }, text }] as unknown as Parameters<typeof collectSources>[1];
  expect(sourceLinks(text).jira).toEqual(["APP-815", "Q-42"]);
  expect(requiredSourceReads(dossiers, "jira")).toEqual(["APP-815", "Q-42"]);
});

it("excludes all-zero example numbers from bare references and Jira URLs without dropping real numbers", () => {
  const text = "CASE-000000 APP-0 APP-00 APP-1 APP-100000 APP-00012 https://example.atlassian.net/browse/APP-1 https://example.atlassian.net/browse/APP-000 https://example.atlassian.net/browse/Q-42";
  const dossiers = [{ task: { status: "open" }, text }] as unknown as Parameters<typeof collectSources>[1];
  expect(sourceLinks(text).jira).toEqual(["APP-1", "APP-100000", "APP-00012", "Q-42"]);
  expect(requiredSourceReads(dossiers, "jira")).toEqual(sourceLinks(text).jira);
});

it("keeps Jira complete when a collected issue describes an all-zero placeholder", async () => {
  const ids: unknown[] = [];
  const description = "Manual audits currently use a fake case number, for example CASE-000000. See APP-43 for a real related issue.";
  const dossiers = [{ task: { status: "open" }, text: "https://example.atlassian.net/browse/APP-42 and the example https://example.atlassian.net/browse/CASE-000000" }] as unknown as Parameters<typeof collectSources>[1];
  const connections: SourceConnections = {
    gmail: { error: "Unavailable" }, slack: { error: "Unavailable" },
    jira: { close: async () => {}, async call(tool, args) {
      if (tool === "searchJiraIssuesUsingJql") return { content: [{ type: "text", text: '{"issues":[],"isLast":true}' }] };
      ids.push(args.issueIdOrKey);
      if (!["APP-42", "APP-43"].includes(String(args.issueIdOrKey))) return { isError: true, content: [{ type: "text", text: "Issue does not exist." }] };
      return { content: [{ type: "text", text: JSON.stringify({ key: args.issueIdOrKey, fields: { description: args.issueIdOrKey === "APP-42" ? description : "Confirmed", comment: { comments: [], total: 0 } } }) }] };
    } },
  };
  const bundle = await collectSources(sampleRun(), dossiers, { connect: async () => connections });
  expect(ids).toEqual(["APP-42", "APP-43"]);
  expect(bundle.documents).toHaveLength(2);
  expect(bundle.documents[0].content).toContain("CASE-000000");
  expect(validateSyncReports(bundle.reports, bundle.calls, dossiers).find(r => r.source === "jira")).toMatchObject({ status: "complete", paginationComplete: true, linkedTasksChecked: true, threadsRead: 2 });
});

it("does not treat bare store identifiers as Jira links from collected issue prose", async () => {
  const ids: unknown[] = [];
  const dossiers = [{ task: { status: "open" }, text: "https://example.atlassian.net/browse/BK-820" }] as unknown as Parameters<typeof collectSources>[1];
  const connections: SourceConnections = {
    gmail: { error: "Unavailable" }, slack: { error: "Unavailable" },
    jira: { close: async () => {}, async call(tool, args) {
      if (tool === "searchJiraIssuesUsingJql") return { content: [{ type: "text", text: '{"issues":[],"isLast":true}' }] };
      ids.push(args.issueIdOrKey);
      if (args.issueIdOrKey === "BK-820") return { content: [{ type: "text", text: JSON.stringify({
        key: "BK-820", fields: { description: "Stores ABC-197 and ABC-335 failed. See https://example.atlassian.net/browse/SYS-100.", comment: { comments: [], total: 0 } },
      }) }] };
      if (args.issueIdOrKey === "SYS-100") return { content: [{ type: "text", text: JSON.stringify({ key: "SYS-100", fields: { description: "Confirmed", comment: { comments: [], total: 0 } } }) }] };
      return { isError: true, content: [{ type: "text", text: "Issue does not exist." }] };
    } },
  };
  const bundle = await collectSources(sampleRun(), dossiers, { connect: async () => connections });
  expect(ids).toEqual(["BK-820", "SYS-100"]);
  expect(bundle.reports.find(report => report.source === "jira")).toMatchObject({ status: "complete", paginationComplete: true, linkedTasksChecked: true });
});

it.each([600, 4])("follows a linked issue chain through completion or the request limit (%i), including cycles", async maxCalls => {
  const ids: unknown[] = [];
  const connections: SourceConnections = {
    gmail: { error: "Unavailable" }, slack: { error: "Unavailable" },
    jira: { close: async () => {}, async call(tool, args) {
      if (tool === "searchJiraIssuesUsingJql") return { content: [{ type: "text", text: '{"issues":[{"key":"APP-1","fields":{"updated":"2026-09-10T10:00:00Z"}}],"isLast":true}' }] };
      ids.push(args.issueIdOrKey);
      const number = Number(String(args.issueIdOrKey).split("-")[1]);
      return { content: [{ type: "text", text: JSON.stringify({ key: args.issueIdOrKey, fields: { description: `Related issue: APP-${number < 8 ? number + 1 : 1}`, comment: { comments: [], total: 0 } } }) }] };
    } },
  };
  const bundle = await collectSources(sampleRun(), [], { connect: async () => connections, maxCalls });
  const report = validateSyncReports(bundle.reports, bundle.calls).find(r => r.source === "jira")!;
  expect(ids).toEqual(Array.from({ length: maxCalls === 600 ? 8 : 3 }, (_, i) => `APP-${i + 1}`));
  expect(new Set(ids).size).toBe(ids.length);
  expect(report.status).toBe(maxCalls === 600 ? "complete" : "partial");
  if (maxCalls === 4) expect(report.detail).toContain("export limit was reached");
});

it.each([true, false])("resolves Gmail message permalinks with searched thread=%s", async inSearch => {
  const ids: unknown[] = [];
  const dossiers = [{ task: { status: "open" }, sourceRef: "https://mail.google.com/mail/u/0/#inbox/1a08d7511a507393" }] as unknown as Parameters<typeof collectSources>[1];
  const connections: SourceConnections = {
    slack: { error: "Unavailable" }, jira: { error: "Unavailable" },
    gmail: { close: async () => {}, async call(tool, args) {
      if (tool === "search_threads") return { content: [{ type: "text", text: JSON.stringify({ threads: inSearch ? [{ id: "1a04026aa250ce0e" }] : [] }) }] };
      if (tool === "get_message") {
        expect(args).toEqual({ messageId: "1a08d7511a507393", messageFormat: "METADATA_ONLY" });
        return { content: [{ type: "text", text: '{"id":"1a08d7511a507393","threadId":"1a04026aa250ce0e"}' }] };
      }
      ids.push(args.threadId);
      return { content: [{ type: "text", text: JSON.stringify({ id: args.threadId, messages: [{ id: "1a08d7511a507393", threadId: args.threadId, date: "2026-09-10T10:00:00Z", plaintextBody: "Confirmed" }] }) }] };
    } },
  };
  const bundle = await collectSources(sampleRun(), dossiers, { connect: async () => connections });
  expect(ids).toEqual(["1a04026aa250ce0e"]);
  expect(bundle.documents).toHaveLength(1);
  expect(bundle.documents[0].content).toContain("Confirmed");
  expect(validateSyncReports(bundle.reports, bundle.calls, dossiers)[0].status).toBe("complete");
});

it.each(["gmail", "jira"] as const)("reports %s source errors with the requested ID instead of a format error", async source => {
  const connections: SourceConnections = { gmail: { error: "Unavailable" }, slack: { error: "Unavailable" }, jira: { error: "Unavailable" } };
  connections[source] = { close: async () => {}, async call(tool) {
    if (tool === "search_threads") return { content: [{ type: "text", text: '{"threads":[{"id":"missing"}]}' }] };
    if (tool === "searchJiraIssuesUsingJql") return { content: [{ type: "text", text: '{"issues":[{"key":"APP-404","fields":{"updated":"2026-09-10T10:00:00Z"}}],"isLast":true}' }] };
    return source === "gmail" ? { isError: true, content: [{ type: "text", text: "Requested entity was not found." }] }
      : { content: [{ type: "text", text: JSON.stringify({ error: true, message: "Issue does not exist or you do not have permission to see it." }) }] };
  } };
  const bundle = await collectSources(sampleRun(), [], { connect: async () => connections });
  const report = bundle.reports.find(r => r.source === source)!;
  expect(report.status).toBe("partial");
  expect(report.detail).toContain(source === "gmail" ? "missing" : "APP-404");
  expect(report.detail).toContain(source === "gmail" ? "not found" : "permission");
  expect(report.detail).not.toContain("format");
  expect(bundle.documents).toHaveLength(0);
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
  expect(bundle.reports[0].detail).toContain("pagination");
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

it("waits out Slack rate limits, including transport-wrapped ratelimited payloads", async () => {
  let searches = 0, threadReads = 0;
  const delays: Array<[number, boolean]> = [];
  const limited = 'Streamable HTTP error: Error POSTing to endpoint: event: message\ndata: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"ratelimited"}],"isError":true},"id":282}';
  const connections: SourceConnections = { gmail: { error: "Нет доступа" }, jira: { error: "Нет доступа" }, slack: { close: async () => {}, async call(tool) {
    if (tool === "slack_search_public_and_private") {
      if (++searches === 1) return { isError: true, content: [{ type: "text", text: "ratelimited" }] };
      return { content: [{ type: "text", text: JSON.stringify({ results: "### Result 1\nhttps://acme.slack.com/archives/C0123456789/p1757500000000100" }) }] };
    }
    if (++threadReads <= 2) throw new Error(limited);
    return { content: [{ type: "text", text: JSON.stringify({ messages: "Message_TS: 1757500000.000100 hello" }) }] };
  } } };
  const bundle = await collectSources(sampleRun(), [], { connect: async () => connections, retryDelayMs: (attempt, rateLimited) => { delays.push([attempt, rateLimited]); return 0; } });
  expect(bundle.reports[1].status).toBe("complete");
  expect(threadReads).toBe(3);
  expect(delays.filter(([, rateLimited]) => rateLimited).length).toBeGreaterThanOrEqual(3);
  expect(bundle.calls.some(c => c.output.includes("ratelimited"))).toBe(false);
});

it("backs off rate limits for seconds rather than retrying inside the same window", () => {
  expect([0, 1, 2].map(attempt => sourceRetryDelay(attempt, true))).toEqual([5000, 15000, 30000]);
  expect([0, 1].map(attempt => sourceRetryDelay(attempt, false))).toEqual([1000, 2000]);
});

it.each([404, 403, 429, 503])("classifies Jira HTTP %i by the error status, not quota metadata", async statusCode => {
  let reads = 0;
  const delays: boolean[] = [];
  const message = statusCode === 429 ? "Too many requests." : statusCode === 503 ? "Service unavailable." : "Issue does not exist or you do not have permission to see it.";
  const payload = { error: true, message: JSON.stringify({ errorMessages: [message], errors: {} }),
    rateLimit: { limit: 400, remaining: 399, headers: { "x-ratelimit-limit": "400", "x-ratelimit-remaining": "399", "x-request-id": "429" } }, statusCode };
  const connections: SourceConnections = { gmail: { error: "Unavailable" }, slack: { error: "Unavailable" }, jira: {
    close: async () => {}, async call(tool) {
      if (tool === "searchJiraIssuesUsingJql") return { content: [{ type: "text", text: '{"issues":[{"key":"APP-7","fields":{"updated":"2026-09-10T10:00:00Z"}}],"isLast":true}' }] };
      reads++;
      return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
  } };
  const bundle = await collectSources(sampleRun(), [], { connect: async () => connections, retryDelayMs: (_attempt, limited) => { delays.push(limited); return 0; } });
  expect(reads).toBe(statusCode === 429 ? 4 : statusCode === 503 ? 3 : 1);
  expect(delays).toEqual(statusCode === 429 ? [true, true, true] : statusCode === 503 ? [false, false] : []);
  const report = bundle.reports.find(r => r.source === "jira")!;
  expect(report.status).toBe("partial");
  expect(report.detail).toContain(`getJiraIssue (APP-7): HTTP ${statusCode}: ${message}`);
  expect(bundle.documents).toHaveLength(0);
  if (statusCode === 404) expect(bundle.calls.find(c => c.tool === "jira.getJiraIssue")?.output).toContain('"remaining":399');
});

it("retries an actual nested Jira 429 and completes after recovery", async () => {
  let reads = 0;
  const connections: SourceConnections = { gmail: { error: "Unavailable" }, slack: { error: "Unavailable" }, jira: {
    close: async () => {}, async call(tool) {
      if (tool === "searchJiraIssuesUsingJql") return { content: [{ type: "text", text: '{"issues":[{"key":"APP-7","fields":{"updated":"2026-09-10T10:00:00Z"}}],"isLast":true}' }] };
      const data = ++reads === 1 ? { statusCode: 429, message: "Quota exhausted", rateLimit: { limit: 400, remaining: 0 } }
        : { key: "APP-7", fields: { comment: { comments: [], total: 0 } }, rateLimit: { limit: 400, remaining: 399 } };
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  } };
  const bundle = await collectSources(sampleRun(), [], { connect: async () => connections, retryDelayMs: () => 0 });
  expect(reads).toBe(2);
  expect(bundle.reports.find(r => r.source === "jira")?.status).toBe("complete");
  expect(bundle.documents).toHaveLength(1);
  expect(bundle.calls.some(c => c.output.includes("Quota exhausted"))).toBe(false);
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
  expect(JSON.stringify(spawn.input)).toContain("PREPARED");
  expect(f.repo.list().total).toBe(0);
  const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ origin: { pluginId: "247c", kind: null }, thread: { id: run.threadId!, title: `247C · updates · ${run.id}` } }));
  expect(config.tools.map(t => t.name)).toContain("c247_sync_data");
  const bundle = store.export(run.id)!;
  const submission = { suggestions: [], finalize: true };
  await expect(f.harness.behavior.callAgentTool("c247_sync_submit", submission, ctx)).rejects.toThrow(/export pages/);
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

it("keeps the collection's Jira project scope through finalization even after settings change", async () => {
  const collect = vi.spyOn(collector, "collectSources").mockImplementation(async run => bundleFor(run));
  const f = await fixture(); hosts.push(f);
  await f.create("https://example.atlassian.net/browse/OTHER-7");
  await f.harness.behavior.setSettings({ sources: '{"jiraProjects":["APP"]}' });
  const input = syncStartSchema.parse({ requestId: randomUUID(), since: null, request: f.startInput("unused", 0).request });
  const initial = await f.harness.behavior.callRpc("syncStart", input) as SyncRun;
  const store = new SourceSyncStore(f.repo);
  await vi.waitFor(() => expect(store.run(initial.id).status).toBe("working"));
  expect(collect.mock.calls[0][2]?.config?.jiraProjects).toEqual(["APP"]);
  expect(store.request(initial.id).jiraProjects).toEqual(["APP"]);
  const run = store.run(initial.id);
  const spawn = f.harness.inspection.sdk.callsTo("threads.spawn")[0][0];
  expect(JSON.stringify(spawn)).toContain("Jira project scope: only APP");
  await f.harness.behavior.setSettings({ sources: '{"jiraProjects":["OTHER"]}' });
  await f.harness.behavior.callAgentTool("c247_sync_submit", { suggestions: [], finalize: true }, { threadId: run.threadId! });
  expect(store.run(initial.id).status).toBe("completed");
  expect(store.checkpoints().jira).toBe(run.until);
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

it.each([true, false])("retries an SSE gateway disconnect and preserves coverage when recovery is %s", async recover => {
  let reads = 0;
  const delays: Array<[number, boolean]> = [];
  const failure = 'Streamable HTTP error: Error POSTing to endpoint: event: message\r\ndata: {"message":"upstream connect error or disconnect/reset before headers. reset reason: connection termination","status":503}\r\n\r\n';
  const connections: SourceConnections = { gmail: { error: "Unavailable" }, slack: { error: "Unavailable" }, jira: {
    close: async () => {}, async call(tool) {
      if (tool === "searchJiraIssuesUsingJql") return { content: [{ type: "text", text: '{"issues":[{"key":"APP-7","fields":{"updated":"2026-09-10T10:00:00Z"}}],"isLast":true}' }] };
      if (++reads === 1 || !recover) throw new Error(failure);
      return { content: [{ type: "text", text: JSON.stringify({ key: "APP-7", fields: { comment: { comments: [], total: 0 } } }) }] };
    },
  } };
  const bundle = await collectSources(sampleRun(), [], { connect: async () => connections,
    retryDelayMs: (attempt, limited) => { delays.push([attempt, limited]); return 0; } });
  expect(reads).toBe(recover ? 2 : 3);
  expect(delays).toEqual(recover ? [[0, false]] : [[0, false], [1, false]]);
  expect(bundle.reports.find(r => r.source === "jira")?.status).toBe(recover ? "complete" : "partial");
  expect(bundle.documents).toHaveLength(recover ? 1 : 0);
  if (recover) expect(bundle.calls.some(c => c.output.includes("connection termination"))).toBe(false);
  else expect(bundle.reports.find(r => r.source === "jira")?.detail).toContain("HTTP 503:");
});
