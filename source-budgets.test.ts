import { afterEach, expect, it, vi } from "vitest";
import { collectSources } from "./source-collector.js";
import { SourceBudget } from "./source-budget.js";
import { syncRanges } from "./source-sync.js";
import type { SyncRun } from "./contracts.js";
import type { SourceConnections, SourceConnector } from "./source-connectors.js";

afterEach(() => vi.useRealTimers());
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const data = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const empty = (): SourceConnections => ({
  gmail: { close: vi.fn(async () => {}), call: vi.fn(async () => data({ threads: [] })) },
  slack: { close: vi.fn(async () => {}), call: vi.fn(async () => data({ results: "", has_more: false })) },
  jira: { close: vi.fn(async () => {}), call: vi.fn(async () => data({ issues: [], isLast: true })) },
});
function run(): SyncRun {
  const until = "2026-10-20T12:00:00.000Z";
  return { id: "budget-test", status: "starting", threadId: null, provider: "codex", model: "test", startedAt: until, finishedAt: null, until, manualSince: null,
    ranges: syncRanges({ gmail: null, slack: null, jira: null }, null, until), reports: [], error: null, suggestions: 0, duplicates: 0, fingerprint: "test" };
}

it("starts Gmail before Jira finishes setup and preserves a full read budget after slow setup", async () => {
  vi.useFakeTimers();
  const connections = empty(), observed: number[] = [], start = Date.now();
  (connections.gmail as SourceConnector).call = async () => { observed.push(Date.now() - start); await pause(40); return data({ threads: [] }); };
  const result = collectSources(run(), [], { timeoutMs: 50, connect: async (_signal, ready) => {
    await pause(200); // Setup time must not consume the read allowance.
    ready("gmail", connections.gmail); ready("slack", connections.slack);
    await pause(1000);
    connections.jira = { error: "Source connection setup timed out" };
    ready("jira", connections.jira);
    return connections;
  } });
  await vi.advanceTimersByTimeAsync(1201);
  const bundle = await result;
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every(at => at < 1200)).toBe(true);
  expect(bundle.reports.map(r => r.status)).toEqual(["complete", "complete", "unavailable"]);
  expect((connections.gmail as SourceConnector).close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("times out Jira reads without aborting a source that becomes ready later", async () => {
  vi.useFakeTimers(); const connections = empty();
  (connections.jira as SourceConnector).call = async (_tool, _args, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  const result = collectSources(run(), [], { timeoutMs: 50, connect: async (_signal, ready) => {
    ready("jira", connections.jira); ready("slack", connections.slack);
    await pause(100);
    ready("gmail", connections.gmail); return connections;
  } });
  await vi.advanceTimersByTimeAsync(101);
  const bundle = await result;
  expect(bundle.reports.map(r => r.status)).toEqual(["complete", "complete", "unavailable"]);
  expect(bundle.reports[2].detail).toContain("jira read time budget exhausted (0.05s)");
  expect(bundle.reports[0].detail).not.toContain("budget exhausted");
  for (const c of Object.values(connections)) expect((c as SourceConnector).close).toHaveBeenCalledOnce();
});

it("keeps unused time for links discovered by another source after an idle wait", async () => {
  vi.useFakeTimers(); const connections = empty();
  const id = "abcdef0123456789";
  const gmailReads: string[] = [];
  (connections.gmail as SourceConnector).call = async (tool, args) => {
    await pause(10);
    if (tool === "search_threads") return data({ threads: [] });
    gmailReads.push(tool);
    return data(tool === "get_message" ? { id: args.messageId, threadId: id } : { id, messages: [] });
  };
  (connections.jira as SourceConnector).call = async tool => data(tool === "searchJiraIssuesUsingJql"
    ? { issues: [{ key: "BK-1", fields: { updated: run().until } }], isLast: true }
    : { key: "BK-1", fields: { description: `https://mail.google.com/mail/u/0/#all/${id}`, comment: { comments: [], total: 0 } } });
  const result = collectSources(run(), [], { timeoutMs: 50, connect: async (_signal, ready) => {
    ready("gmail", connections.gmail); ready("slack", connections.slack);
    await pause(1000); ready("jira", connections.jira); return connections;
  } });
  await vi.advanceTimersByTimeAsync(1100);
  const bundle = await result;
  expect(gmailReads).toEqual(["get_message", "get_thread"]);
  expect(bundle.reports.every(r => r.status === "complete")).toBe(true);
});

it("does not let one source exhaust another source's request allowance", async () => {
  const connections = empty();
  (connections.jira as SourceConnector).call = async (_tool, args) => data({ issues: [], isLast: false, nextPageToken: String(Number(args.nextPageToken ?? 0) + 1) });
  const bundle = await collectSources(run(), [], { maxCalls: 4, connect: async (_signal, ready) => {
    ready("jira", connections.jira); ready("slack", connections.slack);
    await pause(10); ready("gmail", connections.gmail); return connections;
  } });
  expect(bundle.reports[0].status).toBe("complete");
  expect(bundle.reports[2]).toMatchObject({ status: "partial", paginationComplete: false });
  expect(bundle.calls.filter(c => c.source === "jira")).toHaveLength(4);
});

it("shares active wall time between concurrent calls, pauses it when idle, and never resets consumed time", async () => {
  vi.useFakeTimers();
  const budget = new SourceBudget(new AbortController().signal, 100);
  const first = budget.enter(), second = budget.enter();
  await vi.advanceTimersByTimeAsync(60); first(); second();
  await vi.advanceTimersByTimeAsync(1000);
  expect(budget.signal.aborted).toBe(false);
  const third = budget.enter(); await vi.advanceTimersByTimeAsync(39);
  expect(budget.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(budget.signal.aborted).toBe(true);
  third(); budget.dispose(); expect(vi.getTimerCount()).toBe(0);
});

it("propagates cancellation to every active source without labelling it a quota or timeout", async () => {
  const controller = new AbortController(), connections = empty(); let started = 0;
  for (const c of Object.values(connections)) (c as SourceConnector).call = async (_tool, _args, signal) => {
    started++;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const result = collectSources(run(), [], { signal: controller.signal, connect: async () => connections });
  await vi.waitFor(() => expect(started).toBeGreaterThanOrEqual(3)); controller.abort();
  const bundle = await result;
  expect(bundle.reports.every(r => r.status === "unavailable" && r.detail.includes("check was canceled"))).toBe(true);
  for (const c of Object.values(connections)) expect((c as SourceConnector).close).toHaveBeenCalledOnce();
});
