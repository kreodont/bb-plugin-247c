import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GmailQuotaGate } from "./source-gmail-quota.js";
import { collectSources } from "./source-collector.js";
import { syncRanges, validateSyncReports } from "./source-sync.js";
import type { SyncRun } from "./contracts.js";
import type { SourceConnections } from "./source-connectors.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const quota = "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmailmcp.googleapis.com'.";
const payload = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
function run(): SyncRun {
  const until = "2026-11-13T07:00:00Z";
  return { id: "quota-run", status: "starting", threadId: null, provider: "codex", model: "test", startedAt: until, finishedAt: null, until, manualSince: null,
    ranges: syncRanges({ gmail: null, slack: null, jira: null }, null, until), reports: [], error: null, suggestions: 0, duplicates: 0, fingerprint: "test" };
}

it("paces concurrent full-thread and metadata reads with quota headroom", async () => {
  const gate = new GmailQuotaGate(), signal = new AbortController().signal, times: number[] = [];
  await gate.acquire("get_thread", { messageFormat: "PLAIN_TEXT" }, signal);
  const queued = Promise.all(Array.from({ length: 3 }, async () => {
    await gate.acquire("get_message", { messageFormat: "METADATA_ONLY" }, signal); times.push(performance.now());
  }));
  await vi.advanceTimersByTimeAsync(1499); expect(times).toEqual([]);
  await vi.advanceTimersByTimeAsync(501); await queued;
  expect(times).toEqual([1500, 1750, 2000]);
  expect(vi.getTimerCount()).toBe(0);
});

it("pauses already waiting callers together and releases them gradually", async () => {
  const gate = new GmailQuotaGate(), signal = new AbortController().signal, times: number[] = [];
  await gate.acquire("get_thread", {}, signal);
  const queued = Promise.all(Array.from({ length: 2 }, async () => { await gate.acquire("get_thread", {}, signal); times.push(performance.now()); }));
  gate.cooldown();
  await vi.advanceTimersByTimeAsync(59_999); expect(times).toEqual([]);
  await vi.advanceTimersByTimeAsync(1); expect(times).toEqual([60_000]);
  await vi.advanceTimersByTimeAsync(1500); await queued;
  expect(times).toEqual([60_000, 61_500]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["cancel", "stop"])("cleans up quota waits immediately on %s", async action => {
  const gate = new GmailQuotaGate(), parent = new AbortController();
  gate.cooldown();
  const settled = Promise.allSettled([gate.acquire("get_thread", {}, parent.signal), gate.acquire("get_message", {}, parent.signal)]);
  const reason = new Error(action);
  if (action === "cancel") parent.abort(reason); else gate.stop(reason);
  expect(await settled).toEqual([{ status: "rejected", reason }, { status: "rejected", reason }]);
  expect(vi.getTimerCount()).toBe(0);
});

it("recovers the exact Gmail quota error without blocking other sources or consuming the read budget", async () => {
  const sent: { source: string; at: number }[] = [];
  let limited = false;
  const connections: SourceConnections = {
    gmail: { close: async () => {}, async call() {
      sent.push({ source: "gmail", at: performance.now() });
      if (!limited) { limited = true; return { isError: true, content: [{ type: "text", text: quota }] }; }
      return payload({ threads: [] });
    } },
    slack: { close: async () => {}, async call() { sent.push({ source: "slack", at: performance.now() }); return payload({ results: "No results", has_more: false }); } },
    jira: { close: async () => {}, async call() { sent.push({ source: "jira", at: performance.now() }); return payload({ issues: [], isLast: true }); } },
  };
  const result = collectSources(run(), [], { timeoutMs: 50, connect: async () => connections });
  await vi.advanceTimersByTimeAsync(59_999);
  expect(sent.filter(c => c.source === "gmail")).toHaveLength(1);
  expect(sent.some(c => c.source === "slack" && c.at < 1000)).toBe(true);
  expect(sent.some(c => c.source === "jira" && c.at < 1000)).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  const bundle = await result;
  expect(bundle.reports.every(r => r.status === "complete")).toBe(true);
  expect(sent.filter(c => c.source === "gmail")).toHaveLength(3);
  expect(bundle.calls.some(c => c.output.includes("Quota exceeded"))).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops remaining Gmail reads after bounded quota retries and preserves partial coverage", async () => {
  let searches = 0, reads = 0;
  const connections: SourceConnections = {
    slack: { error: "Unavailable" }, jira: { error: "Unavailable" }, gmail: { close: async () => {}, async call(tool) {
      if (tool === "search_threads") {
        searches++;
        return payload({ threads: Array.from({ length: 30 }, (_, i) => ({ id: `thread-${i}` })) });
      }
      reads++;
      return { isError: true, content: [{ type: "text", text: quota }] };
    } },
  };
  const result = collectSources(run(), [], { connect: async () => connections });
  await vi.runAllTimersAsync();
  const bundle = await result;
  expect(searches).toBe(2);
  expect(reads).toBe(4);
  expect(bundle.reports[0]).toMatchObject({ status: "partial", paginationComplete: false, linkedTasksChecked: false });
  expect(bundle.reports[0].detail).toContain("remaining reads are deferred");
  expect(bundle.documents).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("resumes oversized-thread recovery after a message hits the quota", async () => {
  const id = "1a00000000000001", seen: string[] = [];
  const messages = [1, 2, 3].map(n => ({ id: `1a0000000000000${n}`, threadId: id, date: `2026-11-12T0${n}:00:00Z`, plaintextBody: `Reply ${n}` }));
  let limited = false;
  const connections: SourceConnections = {
    slack: { error: "Unavailable" }, jira: { error: "Unavailable" }, gmail: { close: async () => {}, async call(tool, args) {
      if (tool === "search_threads") return payload({ threads: [{ id }] });
      if (tool === "get_thread") return payload({ id, messages, overflow: "x".repeat(2 * 1024 * 1024) });
      seen.push(String(args.messageId));
      if (!limited && args.messageId === messages[1].id) {
        limited = true; return { isError: true, content: [{ type: "text", text: quota }] };
      }
      return payload(messages.find(m => m.id === args.messageId));
    } },
  };
  const result = collectSources(run(), [], { timeoutMs: 50, connect: async () => connections });
  await vi.runAllTimersAsync();
  const bundle = await result;
  expect(seen).toEqual([messages[2].id, messages[1].id, messages[1].id, messages[0].id]);
  expect(bundle.documents).toHaveLength(3);
  expect(validateSyncReports(bundle.reports, bundle.calls)[0]).toMatchObject({ status: "complete", paginationComplete: true, linkedTasksChecked: true });
  expect(bundle.calls.some(c => c.output.includes("Quota exceeded"))).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels collection during the shared Gmail cooldown without sending more requests", async () => {
  const parent = new AbortController();
  let sent = 0;
  const connections: SourceConnections = {
    slack: { error: "Unavailable" }, jira: { error: "Unavailable" }, gmail: { close: async () => {}, async call() {
      sent++; return { isError: true, content: [{ type: "text", text: quota }] };
    } },
  };
  const result = collectSources(run(), [], { signal: parent.signal, connect: async () => connections });
  await vi.advanceTimersByTimeAsync(1000); expect(sent).toBe(1);
  parent.abort();
  const bundle = await result;
  expect(bundle.reports[0].status).not.toBe("complete");
  expect(bundle.reports[0].detail).toContain("canceled");
  expect(sent).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});
