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
async function collect(input = messages(), options: { maxCalls?: number; extra?: string; metadataOnly?: boolean; replace?: (m: Message) => unknown } = {}) {
  const reads: string[] = [];
  const result = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
  const connections: SourceConnections = {
    slack: { error: "Not part of this test" }, jira: { error: "Not part of this test" },
    gmail: { close: async () => {}, async call(tool, args) {
      if (tool === "search_threads") return result({ threads: [{ id: threadId }] });
      if (tool === "get_thread") return result({ id: threadId, messages: options.metadataOnly ? input.map(m => ({ ...m, plaintextBody: undefined })) : input,
        extra: options.extra ?? (options.metadataOnly ? "x".repeat(2 * 1024 * 1024) : undefined) });
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

it("retains a large full response as citable parts without redownloading any messages", async () => {
  const { bundle, reads, report } = await collect();
  expect(reads).toEqual([]);
  expect(report).toMatchObject({ status: "complete", paginationComplete: true, linkedTasksChecked: true });
  expect(contents(bundle).map(m => m.id)).toEqual(["1a00000000000003", "1a00000000000002", threadId]);
  expect(contents(bundle)[0].body).toBe(quote);
  const receipt = bundle.calls.find(c => c.ref === bundle.documents[0].ref)!;
  expect(receipt).toMatchObject({ tool: "gmail.get_thread", args: { threadId, messageFormat: "PLAIN_TEXT" }, completed: true, truncated: false, read: true });
  expect(receipt.output).toContain(quote);
  expect(receipt.output).toContain(threadId);
  const failed = bundle.calls.find(c => c.tool === "gmail.get_thread")!;
  expect(failed).toMatchObject({ completed: false, truncated: true });
  expect(report.callRefs).not.toContain(failed.ref);
  expect(receipt.responsePart).toEqual({ callRef: failed.ref, messageId: "1a00000000000003" });
  expect(bundle.calls.filter(c => !c.responsePart)).toHaveLength(3);
  expect(Buffer.byteLength(JSON.stringify(sourceExportPage(bundle, 0), null, 2))).toBeLessThanOrEqual(24000);
});

it("does not charge a discarded oversized response against the retained export budget", async () => {
  const { report, reads, bundle } = await collect([message(threadId, "2026-09-30T02:00:00Z", quote)], { extra: "x".repeat(16 * 1024 * 1024) });
  expect(report.status).toBe("complete");
  expect(reads).toEqual([]);
  expect(contents(bundle)[0].body).toBe(quote);
});

it("does not spend call budget retaining already received messages", async () => {
  const { report, bundle, reads } = await collect(messages(), { maxCalls: 3 });
  expect(reads).toEqual([]);
  expect(report.status).toBe("complete");
  expect(contents(bundle)).toHaveLength(3);
});

it("preserves the newest recovered reply and reports incomplete coverage when fallback hits the call limit", async () => {
  const { report, bundle, reads } = await collect(messages(), { maxCalls: 4, metadataOnly: true });
  expect(reads).toEqual(["1a00000000000003"]);
  expect(contents(bundle)[0].body).toBe(quote);
  expect(report.status).toBe("partial");
  expect(report.paginationComplete).toBe(false);
  expect(report.detail).toContain("recovery incomplete (1/3");
});

it.each(["error", "wrong-id", "wrong-thread", "missing-body", "missing-date", "oversized-message"])("does not claim full coverage when a message read returns %s", async kind => {
  const { report, bundle } = await collect(messages(), { metadataOnly: true, replace: m => {
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

it("fetches only the missing body, while preserving the other complete messages", async () => {
  const original = messages(), input = original.map(m => m.id === "1a00000000000002" ? { ...m, plaintextBody: undefined } : m);
  const { report, bundle, reads } = await collect(input, { extra: "x".repeat(2 * 1024 * 1024), replace: m => original.find(o => o.id === m.id) });
  expect(reads).toEqual(["1a00000000000002"]);
  expect(report.status).toBe("complete");
  expect(contents(bundle)).toHaveLength(3);
  expect(bundle.documents.filter(d => d.responsePart)).toHaveLength(2);
});

it("keeps available older bodies when a missing new body cannot be fetched", async () => {
  const input = messages().map(m => m.id === "1a00000000000003" ? { ...m, plaintextBody: undefined } : m);
  const { report, bundle, reads } = await collect(input, { maxCalls: 3 });
  expect(reads).toEqual([]);
  expect(report.status).toBe("partial");
  expect(contents(bundle).map(m => m.id)).toEqual(["1a00000000000002", threadId]);
  expect(report.detail).toContain("recovery incomplete (2/3");
});

it("preserves the export byte cap for locally split response parts", async () => {
  const input = Array.from({ length: 12 }, (_, n) => message(`1a000000000000${n.toString().padStart(2, "0")}`, "2026-09-30T02:00:00Z", "Mail body. ".repeat(130_000)));
  const { report, bundle, reads } = await collect(input);
  expect(reads).toEqual([]);
  expect(report.status).toBe("partial");
  expect(report.detail).toContain("export byte limit");
  expect(bundle.calls.reduce((sum, c) => sum + Buffer.byteLength(c.output), 0)).toBeLessThanOrEqual(32 * 1024 * 1024);
});

it("keeps the incremental baseline of legacy get_message recovery across the upgrade", async () => {
  const old = await collect(messages(), { metadataOnly: true });
  const work = { dayWork: {}, dayComplete: true, policy: "" };
  const baseline = planSourceAnalysis(old.bundle, "context", work, true);
  const current = await collect();
  const plan = planSourceAnalysis(current.bundle, "context", work, true, baseline);
  expect(analysisExport(current.bundle, plan).documents).toEqual([]);
});

it("stops with a valid partial report when a full response exceeds the receipt count limit", async () => {
  const input = Array.from({ length: 1001 }, (_, n) => message(n.toString(16).padStart(16, "0"), "2026-09-30T02:00:00Z", "Short reply."));
  const { report, bundle, reads } = await collect(input, { extra: "x".repeat(2 * 1024 * 1024) });
  expect(reads).toEqual([]);
  expect(report.status).toBe("partial");
  expect(report.detail).toContain("receipt limit");
  expect(report.callRefs).toHaveLength(1000);
  expect(bundle.calls).toHaveLength(1000);
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
