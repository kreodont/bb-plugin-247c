import { expect, it } from "vitest";
import { collectSources, responseData } from "./source-collector.js";
import { defaultSourceConfig } from "./source-config.js";
import { syncRanges, validateSyncReports } from "./source-sync.js";
import type { SyncRun } from "./contracts.js";
import type { SourceConnections } from "./source-connectors.js";

const until = "2026-11-14T10:00:00Z";
const run: SyncRun = { id: "jira-envelope-test", status: "starting", threadId: null, provider: "codex", model: "test", startedAt: until, finishedAt: null, until, manualSince: null,
  ranges: syncRanges({ gmail: null, slack: null, jira: null }, null, until), reports: [], error: null, suggestions: 0, duplicates: 0, fingerprint: "test" };
const issue = (key: string) => ({ appliedContentFormat: "markdown", key, fields: { updated: until, summary: "Review the calculation", status: { name: "Open" },
  description: "Check the calculation against the report.", comment: { comments: [{ id: "comment-1", body: "The corrected report is ready.", created: until }], total: 1, startAt: 0 } } });
const response = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify({ data }) }], structuredContent: { issues: { nodes: [] }, context: {} } });
const config = { ...defaultSourceConfig, jiraSite: "example.atlassian.net", jiraProjects: ["APP"] };

it("unwraps current responses while preserving flat replies and outer diagnostics", () => {
  const data = issue("APP-1");
  expect(responseData(response(data))).toEqual(data);
  expect(responseData({ content: [{ type: "text", text: JSON.stringify(data) }] })).toEqual(data);
  expect(responseData({ structuredContent: { data } })).toEqual(data);
  for (const envelope of [{ error: true, message: "Denied", data }, { statusCode: 403, message: "Denied", data }]) {
    expect(responseData({ content: [{ type: "text", text: JSON.stringify(envelope) }] })).toEqual(envelope);
  }
  expect(responseData(response({ error: true, message: "Denied" }))).toEqual({ error: true, message: "Denied" });
});

it("collects every wrapped search page and full issue with usable evidence", async () => {
  const pages: unknown[] = [], reads: unknown[] = [];
  const connections: SourceConnections = { gmail: { error: "Unavailable" }, slack: { error: "Unavailable" }, jira: { close: async () => {}, supports: tool => tool === "listJiraIssueComments", async call(tool, args) {
    expect(tool).not.toBe("listJiraIssueComments"); // Embedded counts already confirm all comments.
    if (tool === "searchJiraIssuesUsingJql") {
      pages.push(args.nextPageToken);
      return response(args.nextPageToken ? { issues: [issue("APP-2")], isLast: true } : { issues: [issue("APP-1")], isLast: false, nextPageToken: "page-two" });
    }
    reads.push(args.issueIdOrKey);
    return response(issue(String(args.issueIdOrKey)));
  } } };
  const bundle = await collectSources(run, [], { config, connect: async () => connections });
  expect(pages).toEqual([undefined, "page-two"]);
  expect(reads).toEqual(["APP-1", "APP-2"]);
  expect(validateSyncReports(bundle.reports, bundle.calls, [], [], config.jiraProjects)[2]).toMatchObject({ status: "complete", paginationComplete: true, linkedTasksChecked: true, threadsRead: 2 });
  expect(bundle.documents).toHaveLength(2);
  expect(JSON.parse(bundle.documents[0].content)).toMatchObject({ key: "APP-1", status: "Open", comments: [{ id: "comment-1", body: "The corrected report is ready." }] });
  expect(bundle.calls.find(c => c.tool === "jira.getJiraIssue")?.output).toContain("The corrected report is ready.");
});

it.each(["wrapped error", "outer error", "missing comments", "missing page"])("does not claim complete Jira coverage after %s", async kind => {
  const connections: SourceConnections = { gmail: { error: "Unavailable" }, slack: { error: "Unavailable" }, jira: { close: async () => {}, async call(tool) {
    if (tool === "searchJiraIssuesUsingJql") return response({ issues: [issue("APP-1")], isLast: kind !== "missing page" });
    if (kind === "wrapped error") return response({ error: true, statusCode: 403, message: "Permission denied" });
    if (kind === "outer error") return { content: [{ type: "text", text: JSON.stringify({ statusCode: 403, message: "Permission denied", data: issue("APP-1") }) }] };
    const data = issue("APP-1");
    if (kind === "missing comments") delete (data.fields as Record<string, unknown>).comment;
    return response(data);
  } } };
  const bundle = await collectSources(run, [], { config, connect: async () => connections });
  expect(validateSyncReports(bundle.reports, bundle.calls, [], [], config.jiraProjects)[2].status).toBe("partial");
  if (kind.includes("error")) { expect(bundle.documents).toEqual([]); expect(bundle.reports[2].detail).toContain("HTTP 403"); }
});

const comment = (id: number) => ({ id: String(id), body: `<p>Comment ${id}</p>`, created: until, author: { displayName: "Reviewer" },
  parentId: id === 21 ? "1" : null, visibility: { type: "role", value: "Team" }, jsdPublic: false });

it.each(["complete", "zero comments", "second page denied", "wrong offset", "duplicate", "changed total", "missing final marker", "empty page", "call limit"])("reads separate comment pages with conservative coverage: %s", async kind => {
  const starts: unknown[] = [];
  const connections: SourceConnections = { gmail: { error: "Unavailable" }, slack: { error: "Unavailable" }, jira: {
    close: async () => {}, supports: tool => tool === "listJiraIssueComments", async call(tool, args) {
      if (tool === "searchJiraIssuesUsingJql") return response({ issues: [issue("APP-1")], isLast: true });
      if (tool === "getJiraIssue") { const data = issue("APP-1"); delete (data.fields as Record<string, unknown>).comment; return response(data); }
      starts.push(args.startAt);
      expect(args).toMatchObject({ issueIdOrKey: "APP-1", maxResults: 20, orderBy: "created" });
      if (kind === "zero comments") return response({ startAt: 0, total: 0, comments: [], isLast: true });
      if (args.startAt === 0) return response({ startAt: 0, maxResults: 20, total: 21, isLast: false, comments: Array.from({ length: 20 }, (_, i) => comment(i + 1)) });
      if (kind === "second page denied") return response({ error: true, statusCode: 403, message: "Forbidden" });
      return response({ startAt: kind === "wrong offset" ? 0 : 20, maxResults: 20, total: kind === "changed total" ? 22 : 21,
        isLast: kind === "missing final marker" ? undefined : kind === "empty page" ? false : true,
        appliedContentFormat: "html", comments: kind === "empty page" ? [] : [comment(kind === "duplicate" ? 1 : 21)] });
    },
  } };
  const bundle = await collectSources(run, [], { config, connect: async () => connections, ...(kind === "call limit" ? { maxCalls: 3 } : {}) });
  const complete = kind === "complete" || kind === "zero comments";
  expect(validateSyncReports(bundle.reports, bundle.calls, [], [], config.jiraProjects)[2].status).toBe(complete ? "complete" : "partial");
  expect(starts).toEqual(kind === "zero comments" || kind === "call limit" ? [0] : [0, 20]);
  if (kind === "complete") {
    const documents = bundle.documents.filter(d => d.tool === "listJiraIssueComments").map(d => JSON.parse(d.content));
    expect(documents.flatMap(d => d.comments)).toHaveLength(21);
    expect(documents[1]).toMatchObject({ key: "APP-1", appliedContentFormat: "html", comments: [{ id: "21", parentId: "1", jsdPublic: false, visibility: { type: "role", value: "Team" }, body: "<p>Comment 21</p>" }] });
    expect(bundle.calls.filter(c => c.tool === "jira.listJiraIssueComments").every(c => c.read && c.completed)).toBe(true);
  }
});
