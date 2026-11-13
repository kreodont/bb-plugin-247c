import { expect, it } from "vitest";
import { collectSources, sourceExportPage, type SourceExport } from "./source-collector.js";
import type { SourceConnections } from "./source-connectors.js";
import type { SyncRun } from "./contracts.js";
import { syncRanges, validateSyncReports } from "./source-sync.js";
import { analysisExport, planSourceAnalysis } from "./source-analysis.js";

const threadId = "1a00000000000001";
const quote = "The retention ratio needs investigation.";
const until = "2026-09-30T07:00:00.000Z";
const run: SyncRun = { id: "large-mail-test", status: "starting", threadId: null, provider: "codex", model: "test", startedAt: until, finishedAt: null, until, manualSince: null,
  ranges: syncRanges({ gmail: null, slack: null, jira: null }, null, until), reports: [], error: null, suggestions: 0, duplicates: 0, fingerprint: "test" };
const dossiers = [{ task: { status: "open" }, sourceRef: `https://mail.google.com/mail/u/0/#inbox/${threadId}` }] as unknown as Parameters<typeof collectSources>[1];
type Message = { id: string; threadId: string; date: string; plaintextBody?: string };
function message(id: string, date: string, plaintextBody: string): Message { return { id, threadId, date, plaintextBody }; }
function messages(): Message[] {
  return [message(threadId, "2026-09-20T10:00:00Z", "Earlier context. ".repeat(55000)),
    message("1a00000000000002", "2026-09-28T10:00:00Z", "Previous reply. ".repeat(55000)),
    message("1a00000000000003", "2026-09-30T02:00:00Z", quote),
    message("1a00000000000004", "2026-09-30T08:00:00Z", "Future reply")];
}
async function collect(input = messages(), options: { maxCalls?: number; extra?: string; replace?: (m: Message) => unknown } = {}) {
  const reads: string[] = [];
  const result = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
  const connections: SourceConnections = {
    slack: { error: "Not part of this test" }, jira: { error: "Not part of this test" },
    gmail: { close: async () => {}, async call(tool, args) {
      if (tool === "search_threads") return result({ threads: [{ id: threadId }] });
      if (tool === "get_thread") return result({ id: threadId, messages: input, extra: options.extra });
      expect(tool).toBe("get_message");
      expect(args.messageFormat).toBe("PLAIN_TEXT");
      reads.push(String(args.messageId));
      const found = input.find(m => m.id === args.messageId)!;
      return result(options.replace?.(found) ?? found);
    } },
  };
  const bundle = await collectSources(run, dossiers, { gmailQuotaUnitsPerMinute: Infinity, connect: async () => connections, maxCalls: options.maxCalls });
  return { bundle, reads, report: validateSyncReports(bundle.reports, bundle.calls, dossiers)[0] };
}
function contents(bundle: SourceExport) { return bundle.documents.flatMap(d => JSON.parse(d.content).messages); }

it("recovers an oversized thread as independently citable messages, newest first, excluding future replies", async () => {
  const { bundle, reads, report } = await collect();
  expect(reads).toEqual(["1a00000000000003", "1a00000000000002", threadId]);
  expect(report).toMatchObject({ status: "complete", paginationComplete: true, linkedTasksChecked: true });
  expect(contents(bundle).map(m => m.id)).toEqual(reads);
  expect(contents(bundle)[0].body).toBe(quote);
  const receipt = bundle.calls.find(c => c.ref === bundle.documents[0].ref)!;
  expect(receipt).toMatchObject({ tool: "gmail.get_message", completed: true, truncated: false, read: true });
  expect(receipt.output).toContain(quote);
  expect(receipt.output).toContain(threadId);
  const failed = bundle.calls.find(c => c.tool === "gmail.get_thread")!;
  expect(failed).toMatchObject({ completed: false, truncated: true });
  expect(report.callRefs).not.toContain(failed.ref);
  expect(Buffer.byteLength(JSON.stringify(sourceExportPage(bundle, 0), null, 2))).toBeLessThanOrEqual(24000);
});

it("does not charge a discarded oversized response against the retained export budget", async () => {
  const { report, reads, bundle } = await collect([message(threadId, "2026-09-30T02:00:00Z", quote)], { extra: "x".repeat(16 * 1024 * 1024) });
  expect(report.status).toBe("complete");
  expect(reads).toEqual([threadId]);
  expect(contents(bundle)[0].body).toBe(quote);
});

it("preserves the newest recovered reply and reports incomplete coverage at the call limit", async () => {
  const { report, bundle, reads } = await collect(messages(), { maxCalls: 4 });
  expect(reads).toEqual(["1a00000000000003"]);
  expect(contents(bundle)[0].body).toBe(quote);
  expect(report.status).toBe("partial");
  expect(report.paginationComplete).toBe(false);
  expect(report.detail).toContain("recovery incomplete (1/3");
});

it.each(["error", "wrong-id", "wrong-thread", "missing-body", "missing-date", "oversized-message"])("does not claim full coverage when a message read returns %s", async kind => {
  const { report, bundle } = await collect(messages(), { replace: m => {
    if (m.id !== "1a00000000000002") return m;
    if (kind === "error") return { error: true, message: "Message unavailable" };
    if (kind === "wrong-id") return { ...m, id: "different-message" };
    if (kind === "wrong-thread") return { ...m, threadId: "different-thread" };
    if (kind === "missing-body") return { ...m, plaintextBody: undefined };
    if (kind === "missing-date") return { ...m, date: undefined };
    return { ...m, plaintextBody: "x".repeat(2 * 1024 * 1024) };
  } });
  expect(report.status).toBe("partial");
  expect(report.detail).toContain("recovery incomplete (2/3");
  expect(contents(bundle).map(m => m.id)).toEqual(["1a00000000000003", threadId]);
});

it("sends only changed messages to the next incremental analysis while retaining earlier context", async () => {
  const first = await collect();
  const work = { dayWork: {}, dayComplete: true, policy: "" };
  const baseline = planSourceAnalysis(first.bundle, "context", work, true);
  const second = await collect([...messages(), message("1a00000000000005", "2026-09-30T06:30:00Z", "Please check this account.")]);
  const plan = planSourceAnalysis(second.bundle, "context", work, true, baseline);
  expect(contents(analysisExport(second.bundle, plan)).map(m => m.id)).toEqual(["1a00000000000005"]);
  expect(contents(second.bundle).some(m => m.id === threadId)).toBe(true);
});
