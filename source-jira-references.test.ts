import { expect, it } from "vitest";
import { collectSources } from "./source-collector.js";
import type { SourceConnections } from "./source-connectors.js";
import type { SyncCandidate, SyncRun } from "./contracts.js";
import type { TaskDossier } from "./core/types.js";
import { confirmedJiraReferences } from "./source-links.js";
import { defaultSourceConfig } from "./source-config.js";
import { requiredSourceReads, syncRanges, validateSyncReports } from "./source-sync.js";

const until = "2026-10-01T12:00:00.000Z";
const run: SyncRun = { id: "test", status: "starting", threadId: null, provider: "codex", model: "test", startedAt: until, finishedAt: null, until, manualSince: null,
  ranges: syncRanges({ gmail: null, slack: null, jira: null }, null, until), reports: [], error: null, suggestions: 0, duplicates: 0, fingerprint: "test" };
const dossier = (text: string, status = "open") => ({ task: { title: "Commission report", status }, facts: [{ text }] }) as TaskDossier;
const result = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

function sources(searchKeys: string[] = [], description = "") {
  const reads: string[] = [];
  const connections: SourceConnections = { gmail: { error: "Unavailable" }, slack: { error: "Unavailable" }, jira: {
    close: async () => {}, async call(tool, args) {
      if (tool === "searchJiraIssuesUsingJql") return result({ issues: searchKeys.map(key => ({ key, fields: { updated: "2026-10-01T10:00:00Z" } })), isLast: true });
      reads.push(String(args.issueIdOrKey));
      return result({ key: args.issueIdOrKey, fields: { description, comment: { comments: [], total: 0 } } });
    },
  } };
  return { reads, connections };
}

it("does not make store codes in accepted notes or pending proposals into Jira reads", async () => {
  const dossiers = [dossier("Added Example Retail - ST-7 with zero ARR. Also ST-8.")];
  const pendingCandidates = [{ title: "Check Example Retail ST-9", facts: [{ text: "No change for ST-9." }] }] as SyncCandidate[];
  const f = sources();
  const bundle = await collectSources(run, dossiers, { gmailQuotaUnitsPerMinute: Infinity, connect: async () => f.connections, pendingCandidates });
  expect(f.reads).toEqual([]);
  expect(requiredSourceReads(dossiers, "jira", pendingCandidates)).toEqual([]);
  expect(validateSyncReports(bundle.reports, bundle.calls, dossiers, pendingCandidates).find(r => r.source === "jira")).toMatchObject({ status: "complete", linkedTasksChecked: true });
});

it("keeps explicit links and bare keys from their confirmed projects, including pending proposals", async () => {
  const dossiers = [dossier("APP-8, store ST-7. See https://example.atlassian.net/browse/APP-7")];
  const pendingCandidates = [{ title: "SUP-2", facts: [{ citations: [{ source: "jira", url: "https://example.atlassian.net/browse/SUP-1" }] }] }] as SyncCandidate[];
  const f = sources();
  const bundle = await collectSources(run, dossiers, { gmailQuotaUnitsPerMinute: Infinity, connect: async () => f.connections, pendingCandidates });
  expect(f.reads.sort()).toEqual(["APP-7", "APP-8", "SUP-1", "SUP-2"]);
  expect(requiredSourceReads(dossiers, "jira", pendingCandidates).sort()).toEqual(f.reads);
  expect(validateSyncReports(bundle.reports, bundle.calls, dossiers, pendingCandidates).find(r => r.source === "jira")?.status).toBe("complete");
});

it("reconsiders bare keys when a later Jira search establishes their project", async () => {
  const dossiers = [dossier("APP-8 is still open; store ST-7 was added.")];
  const f = sources(["APP-7"]);
  const bundle = await collectSources(run, dossiers, { gmailQuotaUnitsPerMinute: Infinity, connect: async () => f.connections });
  expect(f.reads.sort()).toEqual(["APP-7", "APP-8"]);
  expect(requiredSourceReads(dossiers, "jira", [], bundle.calls)).toEqual(["APP-8"]);
  const withoutLinkedRead = bundle.calls.filter(c => (c.args as Record<string, unknown>).issueIdOrKey !== "APP-8");
  const reports = bundle.reports.map(r => ({ ...r, callRefs: r.callRefs.filter(ref => withoutLinkedRead.some(c => c.ref === ref)) }));
  expect(validateSyncReports(reports, withoutLinkedRead, dossiers).find(r => r.source === "jira")?.status).toBe("partial");
});

it("reconsiders bare keys before an explicit link discovered in a later source read", async () => {
  const dossiers = [dossier("SUP-2; store ST-7. https://example.atlassian.net/browse/APP-7")];
  const f = sources([], "SUP-3 https://example.atlassian.net/browse/SUP-1");
  const bundle = await collectSources(run, dossiers, { gmailQuotaUnitsPerMinute: Infinity, connect: async () => f.connections });
  expect(f.reads.sort()).toEqual(["APP-7", "SUP-1", "SUP-2", "SUP-3"]);
  expect(validateSyncReports(bundle.reports, bundle.calls, dossiers).find(r => r.source === "jira")?.status).toBe("complete");
});

it.each([true, false])("uses Jira notification subjects, not ordinary store-code brackets (Jira=%s)", async jira => {
  const f = sources();
  f.connections.gmail = { close: async () => {}, async call(tool) {
    if (tool === "search_threads") return result({ threads: [{ id: "mail" }] });
    return result({ id: "mail", messages: [{ id: "m", date: "2026-10-01T10:00:00Z", subject: jira ? "[JIRA] Reviewer mentioned you on NEW-7" : "Commission report [ST-7]", plaintextBody: "NEW-8, ST-7 and ST-8." }] });
  } };
  await collectSources(run, [dossier("NEW-9")], { gmailQuotaUnitsPerMinute: Infinity, connect: async () => f.connections });
  expect(f.reads.sort()).toEqual(jira ? ["NEW-7", "NEW-8", "NEW-9"] : []);
});

it("keeps real inaccessible Jira URLs partial even if their key resembles a store code", async () => {
  const f = sources();
  f.connections.jira = { close: async () => {}, async call(tool) {
    return tool === "searchJiraIssuesUsingJql" ? result({ issues: [], isLast: true })
      : { ...result({ error: true, statusCode: 404, message: "Issue does not exist or you do not have permission to see it." }), isError: true };
  } };
  const dossiers = [dossier("https://example.atlassian.net/browse/ST-7")];
  const bundle = await collectSources(run, dossiers, { gmailQuotaUnitsPerMinute: Infinity, connect: async () => f.connections });
  expect(bundle.reports.find(r => r.source === "jira")).toMatchObject({ status: "partial" });
  expect(bundle.reports.find(r => r.source === "jira")?.detail).toContain("getJiraIssue (ST-7): HTTP 404");
});

it("does not use archived or completed task links to confirm store-code projects in live tasks", () => {
  expect(requiredSourceReads([dossier("ST-7"), dossier("https://example.atlassian.net/browse/ST-1", "done")], "jira")).toEqual([]);
});

it("requires project evidence without adding prefix-specific exceptions", () => {
  expect(confirmedJiraReferences("ST-7 APP-9 Q-12345 12345678-ABC4-4321-89AB-123456789ABC", ["APP"])).toEqual(["APP-9"]);
  expect(confirmedJiraReferences("APP-0 APP-00 APP-1 https://example.atlassian.net/browse/APP-2 https://example.atlassian.net/browse/Q-42")).toEqual(["APP-1", "APP-2", "Q-42"]);
});

it("enforces configured projects for bare keys, direct URLs, search results and followed links", async () => {
  const projects = ["APP", "OPS"];
  const dossiers = [dossier("APP-8, APPX-7, ST-7 https://example.atlassian.net/browse/OTHER-1")];
  const f = sources(["APP-7", "OTHER-2"], "OPS-3 and https://example.atlassian.net/browse/OTHER-3");
  const bundle = await collectSources(run, dossiers, { config: { ...defaultSourceConfig, jiraProjects: projects }, gmailQuotaUnitsPerMinute: Infinity, connect: async () => f.connections });
  expect(f.reads.sort()).toEqual(["APP-7", "APP-8", "OPS-3"]);
  const search = bundle.calls.find(c => c.tool === "jira.searchJiraIssuesUsingJql")!;
  expect((search.args as Record<string, unknown>).jql).toContain('AND project IN ("APP", "OPS")');
  expect(requiredSourceReads(dossiers, "jira", [], bundle.calls, projects)).toEqual(["APP-8"]);
  expect(validateSyncReports(bundle.reports, bundle.calls, dossiers, [], projects).find(r => r.source === "jira")).toMatchObject({ status: "complete", scanned: 1 });
});

it("does not report missing reads when a search only returns out-of-scope projects", async () => {
  const f = sources(["OTHER-2"]);
  const bundle = await collectSources(run, [], { config: { ...defaultSourceConfig, jiraProjects: ["APP"] }, gmailQuotaUnitsPerMinute: Infinity, connect: async () => f.connections });
  expect(f.reads).toEqual([]);
  expect(validateSyncReports(bundle.reports, bundle.calls, [], [], ["APP"]).find(r => r.source === "jira")).toMatchObject({ status: "complete", scanned: 0, threadsRead: 0 });
});
