import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { collectSources, receiptText, type SourceExport } from "./source-collector.js";
import { missingSlackThread, skippedSlackCalls } from "./source-slack-missing.js";
import { SourceSyncStore, syncRanges, validateSyncReports, type SourceCall } from "./source-sync.js";
import { fixture } from "./test-support.js";
import { startSourceSync } from "./source-sync-test-support.js";
import type { SyncRun } from "./contracts.js";

const channel = "C123CHANNEL", missing = "1789034000.123456", available = "1789034100.654321";
const link = `https://example.slack.com/archives/${channel}/p${missing.replace(".", "")}`;
const response = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const failure = (text: string) => ({ isError: true, content: [{ type: "text", text }] });
const absent: SourceCall = { ref: "missing", source: "slack", tool: "slack.slack_read_thread", args: { channel_id: channel, message_ts: missing },
  output: receiptText({ text: "execution_failed: thread_not_found" }), completed: false, truncated: false, read: true };
const readable: SourceCall = { ref: "readable", source: "slack", tool: "slack.slack_read_thread", args: { channel_id: channel, message_ts: available },
  output: receiptText({ messages: `Message TS: ${available}\nStill available.` }), completed: true, truncated: false, read: true };
function run(): SyncRun {
  const until = "2026-09-10T12:00:00.000Z";
  return { id: randomUUID(), status: "starting", threadId: null, provider: "codex", model: "test", startedAt: until, finishedAt: null, until, manualSince: null,
    ranges: syncRanges({ gmail: null, slack: null, jira: null }, null, until), reports: [], error: null, suggestions: 0, duplicates: 0, fingerprint: "test" };
}
async function collect(options: { availableThread?: boolean; probeError?: string; probeMalformed?: boolean; threadError?: string; searchError?: string } = {}, sourceRun = run()) {
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  const text = link + (options.availableThread ? ` https://example.slack.com/archives/${channel}/p${available.replace(".", "")}` : "");
  const dossiers = [{ task: { status: "open" }, text }] as unknown as Parameters<typeof collectSources>[1];
  const bundle = await collectSources(sourceRun, dossiers, { retryDelayMs: () => 0, gmailQuotaUnitsPerMinute: Infinity, connect: async () => ({
    gmail: { close: async () => {}, call: async () => response({ threads: [] }) },
    jira: { close: async () => {}, call: async () => response({ issues: [], isLast: true }) },
    slack: { close: async () => {}, async call(tool, args) {
      seen.push({ tool, args });
      if (tool === "slack_search_public_and_private") return options.searchError ? failure(options.searchError) : response({ results: "No results found.", pagination_info: "No more results" });
      if (tool === "slack_read_channel") return options.probeError ? failure(options.probeError) : response(options.probeMalformed ? { unexpected: true }
        : { messages: `Message TS: ${available}\nAccess probe only.`, next_cursor: "more-channel-history" });
      if (args.message_ts === available) return response({ messages: `Message TS: ${available}\nStill available.`, pagination_info: "No more messages" });
      return failure(options.threadError ?? "execution_failed: thread_not_found");
    } },
  }) });
  return { bundle, seen, dossiers, report: validateSyncReports(bundle.reports, bundle.calls, dossiers).find(r => r.source === "slack")! };
}

it("requires an exact missing-message diagnostic and successful access to the same channel", () => {
  expect(skippedSlackCalls([absent, readable])).toEqual(new Set([absent.ref]));
  expect(skippedSlackCalls([absent, { ...readable, args: { channel_id: "COTHER" } }]).size).toBe(0);
  for (const changed of [
    { output: "not_authed" }, { output: "channel_not_found" }, { output: "HTTP 503: thread_not_found" },
    { output: receiptText({ messages: "Someone wrote thread_not_found" }) }, { completed: true }, { truncated: true },
    { args: { ...absent.args as object, cursor: "page2" } }, { source: "jira" as const },
  ]) expect(missingSlackThread({ ...absent, ...changed })).toBe(false);
});

it.each([true, false])("skips missing messages with existing channel access=%s without making them citable", async availableThread => {
  const { bundle, seen, report } = await collect({ availableThread });
  expect(report).toMatchObject({ status: "complete", paginationComplete: true, linkedTasksChecked: true, threadsRead: availableThread ? 1 : 0 });
  expect(report.detail).toContain("Skipped 1 Slack message");
  expect(seen.filter(c => c.tool === "slack_read_channel")).toHaveLength(availableThread ? 0 : 1);
  expect(bundle.calls.find(c => (c.args as any).message_ts === missing)).toMatchObject({ completed: false, read: true });
  expect(bundle.documents.some(d => d.content.includes("Access probe only"))).toBe(false);
  expect(bundle.documents).toHaveLength(availableThread ? 1 : 0);
});

it.each(["channel_not_found", "not_in_channel", "not_authed", "Request timed out", "HTTP 503: Service unavailable", "ratelimited"])("keeps a failed channel access probe visible: %s", async probeError => {
  const { report } = await collect({ probeError });
  expect(report.status).toBe("partial"); expect(report.detail).toContain(probeError);
});

it("preserves other errors, malformed probes and source pagination gaps", async () => {
  expect((await collect({ probeMalformed: true })).report.status).toBe("partial");
  const search = await collect({ availableThread: true, searchError: "Search permission denied" });
  expect(search.report.status).toBe("partial"); expect(search.report.detail).toContain("Search permission denied");
  expect(search.report.detail).not.toContain("thread_not_found");
  const timeout = await collect({ availableThread: true, threadError: "Request timed out" });
  expect(timeout.report.status).toBe("partial"); expect(timeout.report.detail).toContain("Request timed out");
  const { bundle } = await collect({ availableThread: true });
  const first = bundle.calls.find(c => c.tool.endsWith("slack_search_public_and_private"))!;
  first.output = receiptText({ results: "No results found.", next_cursor: "unread-search-page" });
  expect(validateSyncReports(bundle.reports, bundle.calls).find(r => r.source === "slack")?.status).toBe("partial");
});

it("clears an old missing-message alert in the display without rewriting the run, receipts, task or checkpoint", async () => {
  const f = await fixture();
  try {
    const task = f.repo.create({ title: "Existing request", description: link, requestId: randomUUID() });
    const { run: saved } = await startSourceSync(f), store = new SourceSyncStore(f.repo);
    const { bundle } = await collect({ availableThread: true }, saved);
    const reports = bundle.reports.map(r => r.source === "slack" ? { ...r, status: "partial" as const, paginationComplete: false, linkedTasksChecked: false,
      detail: `slack_read_thread (${channel}:${missing}): execution_failed: thread_not_found` } : r);
    const old: SourceExport = { ...bundle, reports };
    store.saveExport(old);
    store.save({ ...saved, status: "partial", finishedAt: saved.until, reports, collection: { phase: "analyzing", calls: bundle.calls.length, reads: bundle.documents.length, elapsedMs: 1 } });
    const snapshot = () => ({ run: f.repo.db.prepare("SELECT * FROM source_sync_runs WHERE id=?").get(saved.id),
      export: new SourceSyncStore(f.repo).export(saved.id), dossier: f.repo.kernel.getDossier(task.id), checkpoints: new SourceSyncStore(f.repo).checkpoints() });
    const before = snapshot();
    expect(store.run(saved.id)).toMatchObject({ status: "completed" });
    expect(store.state().runs[0].reports.find(r => r.source === "slack")?.detail).toContain("Skipped 1");
    expect(await f.harness.behavior.callRpc("updaterHealth", {})).toMatchObject({ alert: false });
    expect(snapshot()).toEqual(before);
    await f.reload();
    expect(new SourceSyncStore(f.repo).run(saved.id).status).toBe("completed");
    expect(snapshot()).toEqual(before);
  } finally { await f.harness.lifecycle.dispose(); }
});

it("advances a new check's checkpoint past a missing message without changing its task", async () => {
  const f = await fixture();
  try {
    const task = f.repo.create({ title: "Existing request", description: link, requestId: randomUUID() });
    const { run: saved } = await startSourceSync(f), store = new SourceSyncStore(f.repo);
    const { bundle } = await collect({}, saved), before = f.repo.kernel.getDossier(task.id);
    const result = store.submit(saved.id, { reports: bundle.reports, suggestions: [] }, bundle.calls);
    expect(result.status).toBe("completed");
    expect(store.checkpoints().slack).toBe(saved.until);
    expect(f.repo.kernel.getDossier(task.id)).toEqual(before);
  } finally { await f.harness.lifecycle.dispose(); }
});
