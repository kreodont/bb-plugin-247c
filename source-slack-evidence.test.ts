import { expect, it } from "vitest";
import { slackCitationMatches, verifiedSlackTarget } from "./source-slack-evidence.js";
import type { SourceCall } from "./source-sync.js";
import { SourceSyncStore, validateSyncDraft } from "./source-sync.js";
import { fixture } from "./test-support.js";
import { sourceData, startSourceSync } from "./source-sync-test-support.js";

const ts = "1789034000.123456";
const citation = { source: "slack" as const, url: `https://example.slack.com/archives/C123REAL/p${ts.replace(".", "")}`, messageId: ts,
  callRef: "read", occurredAt: "2026-09-10T10:00:00Z", quote: "Please review." };
const call: SourceCall = { ref: "read", source: "slack", tool: "slack.slack_read_thread", args: { channel_id: "C123REAL", message_ts: ts },
  output: `Message TS: ${ts}\nPlease review.\nLink to another channel: https://example.slack.com/archives/C987OTHER/p${ts.replace(".", "")}`, completed: true, truncated: false, read: true };

it("binds Slack links to the channel actually read, not another channel in its body", () => {
  expect(slackCitationMatches(citation, call)).toBe(true);
  expect(slackCitationMatches({ ...citation, url: citation.url.replace("C123REAL", "C987OTHER") }, call)).toBe(false);
  expect(slackCitationMatches({ ...citation, url: citation.url.replace("123456", "123457") }, call)).toBe(false);
  expect(slackCitationMatches({ ...citation, url: citation.url + "?thread_ts=1789033000.654321" }, call)).toBe(false);
  expect(slackCitationMatches({ ...citation, url: citation.url + `?thread_ts=${ts}` }, call)).toBe(true);
  expect(verifiedSlackTarget(citation, { ...call, completed: false })).toBeNull();
  expect(verifiedSlackTarget(citation, { ...call, truncated: true })).toBeNull();
  expect(verifiedSlackTarget(citation, { ...call, args: null })).toBeNull();
});

it("accepts a reply only with its own timestamp and the verified parent", () => {
  const reply = "1789034100.654321", read = { ...call, output: call.output + `\nMessage TS: ${reply}\nAgreed.` };
  expect(slackCitationMatches({ ...citation, messageId: reply, quote: "Agreed.", url: citation.url.replace(ts.replace(".", ""), reply.replace(".", "")) + `?thread_ts=${ts}` }, read)).toBe(true);
  expect(verifiedSlackTarget({ ...citation, messageId: "1789034100.111111" }, read)).toBeNull();
});

it("rejects a fabricated channel at submission and recovers old addresses only from verified saved receipts", async () => {
  const f = await fixture();
  try {
    const { run } = await startSourceSync(f), { input } = await sourceData(f, run);
    const draft = input.suggestions[0];
    const ref = `export:${run.id}:read`;
    const read = { ...call, ref };
    for (const fact of draft.facts) fact.citations = [{ ...citation, callRef: ref }];
    expect(() => validateSyncDraft(draft, run, [], [read])).not.toThrow();
    for (const fact of draft.facts) fact.citations[0].url = citation.url.replace("C123REAL", "C987OTHER");
    expect(() => validateSyncDraft(draft, run, [], [read])).toThrow(/channel_id/);
    const store = new SourceSyncStore(f.repo);
    store.saveExport({ version: 1, runId: run.id, startedAt: run.startedAt, finishedAt: run.until, elapsedMs: 1, calls: [read], documents: [], reports: [] });
    // Simulate an already saved proposal from before strict channel validation.
    const id = "2f79510a-68c9-45fd-9ebf-97cce2caa9d8";
    const old = { ...draft, id, runId: run.id, baseRevision: null, before: null, status: "pending", createdAt: run.startedAt,
      resolvedAt: null, proposalId: null, resultTaskId: null };
    f.repo.db.prepare("INSERT INTO source_sync_candidates VALUES (?,?,?,?,?,?)").run(id, run.id, null, "pending", "legacy", JSON.stringify(old));
    expect(store.slackLinkResolver()({ channel: "C987OTHER", ts })).toEqual({ channel: "C123REAL", ts });
    expect(store.slackLinkResolver()({ channel: "CUNKNOWN", ts })).toBeNull();
    expect(store.candidate(id).facts[0].citations[0].url).toContain("C987OTHER");
    f.repo.db.prepare("DELETE FROM source_sync_exports WHERE run_id=?").run(run.id);
    store.saveExport({ version: 1, runId: run.id, startedAt: run.startedAt, finishedAt: run.until, elapsedMs: 1, calls: [{ ...read, completed: false }], documents: [], reports: [] });
    expect(store.slackLinkResolver()({ channel: "C987OTHER", ts })).toBeNull();
  } finally { await f.harness.lifecycle.dispose(); }
});
