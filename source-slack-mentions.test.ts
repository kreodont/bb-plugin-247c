import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { collectSources } from "./source-collector.js";
import { defaultSourceConfig } from "./source-config.js";
import type { SourceConnections } from "./source-connectors.js";
import type { SyncRun } from "./contracts.js";

const since = "2026-09-10T10:00:00.000Z", until = "2026-09-10T11:00:00.000Z";
const mentionQuery = "<@U123OWNER>";
const parent = "1789034000.123456";
function run(): SyncRun {
  return { id: randomUUID(), status: "starting", threadId: null, provider: "codex", model: "test", startedAt: until, finishedAt: null, until, manualSince: null,
    ranges: { gmail: { since, previous: since }, slack: { since, previous: since }, jira: { since, previous: since } }, reports: [], error: null, suggestions: 0, duplicates: 0, fingerprint: "test" };
}
function response(data: unknown) { return { content: [{ type: "text", text: JSON.stringify(data) }] }; }
function connections(slack: SourceConnections["slack"]): SourceConnections {
  return { gmail: { error: "Not part of this check" }, jira: { error: "Not part of this check" }, slack };
}

it.each([mentionQuery, "from:me"])("finds %s outside watched channels when incoming searches are empty, follows pages and reads each parent once", async query => {
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  const bundle = await collectSources(run(), [], {
    config: { ...defaultSourceConfig, slackUserId: "U123OWNER", slackChannels: ["support"] },
    connect: async () => connections({ close: async () => {}, async call(tool, args) {
      seen.push({ tool, args });
      if (tool === "slack_read_thread") return response({ messages: `Message TS: ${parent}\nPlease review the next change.\nMessage TS: 1789034700.654321\nNon-urgent.`, pagination_info: "There are no more messages in this thread." });
      if (args.query !== query) return response({ results: "No results found.", pagination_info: "End of results - No more pages available." });
      const ts = args.cursor ? "1789034700654321" : "1789034400123456";
      return response({ results: `### Result 1 of 2\nChannel: #engineering (ID: C987ENG)\nPermalink: https://example.slack.com/archives/C987ENG/p${ts}?thread_ts=${parent}\nText: ${query === mentionQuery ? "<@U123OWNER> Please review." : "Please approve my change."}`,
        pagination_info: args.cursor ? "End of results - No more pages available." : "For the next page of results use cursor `mentions-page-2`" });
    } }),
  });
  const searches = seen.filter(c => c.args.query === query);
  expect(searches).toHaveLength(2);
  expect(searches[1].args.cursor).toBe("mentions-page-2");
  expect(searches.every(c => c.args.after === String(Date.parse(since) / 1000 - 300) && c.args.before === String(Date.parse(until) / 1000))).toBe(true);
  expect(seen.filter(c => c.tool === "slack_read_thread")).toEqual([{ tool: "slack_read_thread", args: { channel_id: "C987ENG", message_ts: parent, limit: 1000, latest: String(Date.parse(until) / 1000) } }]);
  expect(bundle.documents).toHaveLength(1);
  expect(bundle.documents[0].content).toContain("Non-urgent.");
  expect(bundle.reports.find(r => r.source === "slack")).toMatchObject({ status: "complete", paginationComplete: true, threadsRead: 1 });
});

it.each([mentionQuery, "from:me"])("reports partial coverage when %s fails despite successful empty searches", async query => {
  const bundle = await collectSources(run(), [], {
    config: { ...defaultSourceConfig, slackUserId: "U123OWNER" },
    connect: async () => connections({ close: async () => {}, async call(_tool, args) {
      if (args.query === query) return { isError: true, content: [{ type: "text", text: "Search permission denied." }] };
      return response({ results: "No results found.", pagination_info: "End of results - No more pages available." });
    } }),
  });
  expect(bundle.reports.find(r => r.source === "slack")).toMatchObject({ status: "partial", paginationComplete: false });
  expect(bundle.reports.find(r => r.source === "slack")?.detail).toContain("Search permission denied");
  expect(bundle.documents).toEqual([]);
});

it("does not send an invalid mention query when the Slack member ID is not configured", async () => {
  const queries: unknown[] = [];
  await collectSources(run(), [], { connect: async () => connections({ close: async () => {}, async call(_tool, args) {
    queries.push(args.query);
    return response({ results: "No results found.", pagination_info: "End of results - No more pages available." });
  } }) });
  expect(queries).toEqual(["is:dm", "is:mpim", "to:me", "from:me"]);
});

it.each(["complete", "failed", "missing-message", "no-proof"])("recovers an invalid saved address only after a verified current read: %s", async outcome => {
  const bundle = await collectSources(run(), [], {
    resolveSlackLink: () => outcome === "no-proof" ? null : { channel: "C123REAL", ts: parent },
    connect: async () => connections({ close: async () => {}, async call(tool, args) {
      if (tool === "slack_search_public_and_private") return response({ results: args.query === "is:dm"
        ? `### Result 1 of 1\nPermalink: https://example.slack.com/archives/C987WRONG/p${parent.replace(".", "")}` : "No results found.", pagination_info: "No more results" });
      if (args.channel_id === "C987WRONG" || outcome === "failed") return { isError: true, content: [{ type: "text", text: "execution_failed: thread_not_found" }] };
      return response({ messages: `Message TS: ${outcome === "missing-message" ? "1789034700.654321" : parent}\nPlease review.`, pagination_info: "No more messages" });
    } }),
  });
  const report = bundle.reports.find(r => r.source === "slack")!;
  expect(report.status).toBe(outcome === "complete" ? "complete" : "partial");
  if (outcome === "complete") {
    expect(bundle.calls.some(c => !c.completed && c.output.includes("thread_not_found"))).toBe(true);
    expect(report.callRefs.every(ref => bundle.calls.find(c => c.ref === ref)?.completed)).toBe(true);
    expect(bundle.documents[0].args.channel_id).toBe("C123REAL");
  } else expect(report.detail).toContain(`C987WRONG:${parent}`);
});
