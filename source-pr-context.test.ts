import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pullRequestReferences } from "./source-links.js";
import { collectSources } from "./source-collector.js";
import { syncRanges, validateSyncDraft } from "./source-sync.js";
import type { SourceConnections } from "./source-connectors.js";
import type { SyncDraft, SyncRun } from "./contracts.js";
import { fixture } from "./test-support.js";

const url = "https://github.com/example/service/pull/123";
const until = "2026-09-10T12:00:00.000Z";
const run: SyncRun = { id: randomUUID(), status: "working", threadId: null, provider: "codex", model: "test", startedAt: until, finishedAt: null, until, manualSince: null,
  ranges: syncRanges({ gmail: null, slack: null, jira: null }, null, until), reports: [], error: null, suggestions: 0, duplicates: 0, fingerprint: "test" };

it("normalizes PR identity without confusing repositories, longer numbers or lookalike hosts", () => {
  expect(pullRequestReferences(`${url}/files ${url}#discussion_r1 ${url}4 https://github.com/Example/Other/pull/123 https://github.com.evil.test/example/service/pull/123 https://github.com/example/service/pull/123abc`)).toEqual([url, `${url}4`, "https://github.com/example/other/pull/123"]);
  expect(pullRequestReferences(url.replaceAll("/", "\\/"))).toEqual([url]);
});

it.each([false, true])("looks up an unlinked Slack PR in older full email threads (already linked: %s)", async known => {
  const searches: string[] = [], issues: string[] = [];
  let reads = 0;
  const connections: SourceConnections = {
    gmail: { close: async () => {}, async call(tool, args) {
      if (tool === "search_threads") {
        searches.push(String(args.query));
        return { content: [{ type: "text", text: JSON.stringify({ threads: String(args.query).includes(url) ? [{ id: "pr-thread" }] : [] }) }] };
      }
      reads++;
      return { content: [{ type: "text", text: JSON.stringify({ id: args.threadId, messages: [
        { id: "older", date: "2026-09-01T10:00:00Z", subject: "[APP-70] Publish installation event", plaintextBody: `Implementation for APP-71. ${url}` },
        { id: "future", date: "2026-09-11T10:00:00Z", plaintextBody: "Future progress must not be exported" },
      ] }) }] };
    } },
    slack: { close: async () => {}, async call(tool, args) {
      const data = tool === "slack_search_public_and_private"
        ? { results: args.query === "from:me" ? "### Result 1\nhttps://example.slack.com/archives/C123/p1789034400000000" : "No messages found", has_more: false }
        : { messages: `Message TS: 1789034400.000000\nPlease review ${url}. Left a comment.`, has_more: false };
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } },
    jira: { close: async () => {}, async call(tool, args) {
      if (tool === "searchJiraIssuesUsingJql") return { content: [{ type: "text", text: '{"issues":[],"isLast":true}' }] };
      issues.push(String(args.issueIdOrKey));
      return { content: [{ type: "text", text: JSON.stringify({ key: args.issueIdOrKey, fields: { summary: "Publish installation event", comment: { comments: [], total: 0 } } }) }] };
    } },
  };
  const f = await fixture();
  try {
    const task = await f.create(known ? `Implementation: ${url}` : "Publish installation event");
    const bundle = await collectSources(run, [f.repo.kernel.getDossier(task.id)], { connect: async () => connections });
    const contextSearches = searches.filter(q => q.includes(url));
    expect(contextSearches).toHaveLength(known ? 0 : 1);
    expect(reads).toBe(known ? 0 : 1);
    if (!known) {
      expect(contextSearches[0]).toBe(`"${url}" before:1789041601`);
      expect(bundle.documents.find(d => d.source === "gmail")?.content).toContain("APP-71");
      expect(bundle.documents.find(d => d.source === "gmail")?.content).not.toContain("Future progress");
      expect(issues.sort()).toEqual(["APP-70", "APP-71"]);
    }
    expect(bundle.reports.every(r => r.status === "complete")).toBe(true);
  } finally { await f.harness.lifecycle.dispose(); }
});

it("refuses a separate PR task when an accepted dossier already links that exact PR", async () => {
  const f = await fixture();
  try {
    const task = await f.create(`Publish installation event: ${url}`);
    const snapshot = f.repo.kernel.getDossier(task.id);
    const draft: SyncDraft = { taskId: null, title: "Handle review comment", rationale: "A review reply arrived", confidence: 1, facts: [],
      changes: { summary: { value: `Review ${url}/files`, evidenceRefs: ["fact:0"] }, nextStep: { value: "Handle comment", evidenceRefs: ["fact:0"] } } };
    expect(() => validateSyncDraft(draft, run, [snapshot], [])).toThrow(task.id);
    snapshot.task.status = "done";
    expect(() => validateSyncDraft(draft, run, [snapshot], [])).toThrow(/already linked/);
    draft.changes.summary!.value = "https://github.com/example/other/pull/123";
    expect(() => validateSyncDraft(draft, run, [snapshot], [])).not.toThrow(/already linked/);
    expect(f.repo.list().total).toBe(1);
  } finally { await f.harness.lifecycle.dispose(); }
});
