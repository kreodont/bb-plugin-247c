import { afterEach, expect, it, vi } from "vitest";
import { makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import { fixture } from "./test-support.js";
import { sourceData, startSourceSync } from "./source-sync-test-support.js";
import { SourceSyncRuntime } from "./source-sync.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
const runtimes: SourceSyncRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose();
  vi.restoreAllMocks(); vi.useRealTimers();
});
async function setup() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
  const f = await fixture(); hosts.push(f);
  const task = await f.create();
  const { run } = await startSourceSync(f);
  const { input, calls } = await sourceData(f, run, task.id);
  const runtime = new SourceSyncRuntime(f.bb, f.repo); runtimes.push(runtime);
  const store = runtime.store;
  store.save({ ...run, collection: { phase: "analyzing", calls: calls.length, reads: 1, elapsedMs: 10 } });
  store.saveExport({ version: 1, runId: run.id, startedAt: run.startedAt, finishedAt: run.until, elapsedMs: 10, calls, reports: input.reports, documents: [] });
  store.recordDataPage(run.id, 0);
  const threadId = run.threadId!;
  const state = (status: "active" | "idle" | "error") => { f.threads.set(threadId, { ...f.threads.get(threadId)!, status }); };
  state("error");
  const retry = (queueState?: string) => ({ ...makeQueueEntry({ threadId, initiator: "system", originPluginId: "provider-retry", sendAt: Date.now() + 60_000,
    payload: { kind: "retry", attempt: 2, retryOfTurnRequestId: "request-original", reason: "Provider overloaded" } }),
    ...(queueState ? { state: queueState } : {}) });
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  return { f, runtime, store, run, input, task, threadId, state, retry, advance };
}

it("keeps the export, saved proposals and analyst tools usable through an overload retry", async () => {
  const { f, runtime, store, run, input, task, threadId, state, retry, advance } = await setup();
  const before = await f.detail(task.id);
  await runtime.submit(threadId, { suggestions: input.suggestions });
  // The failure event precedes provider-retry's durable queue write.
  await runtime.tick(run.id);
  expect(store.run(run.id)).toMatchObject({ status: "working", finishedAt: null, error: null });
  advance(10_000); f.queued.set(threadId, [retry("scheduled")]);
  await runtime.tick(run.id);
  advance(120_000); await runtime.tick(run.id);
  expect(store.run(run.id).status).toBe("working");
  expect(store.checkpoints().gmail).toBeNull();
  expect(store.candidates()).toHaveLength(1);
  // The retry is claimed before the thread becomes active.
  f.queued.set(threadId, []); state("idle"); await runtime.tick(run.id);
  advance(1000); state("active"); await runtime.tick(run.id);
  await expect(f.harness.behavior.callAgentTool("c247_day_review", {}, { threadId })).resolves.toBeDefined();
  await runtime.submit(threadId, { suggestions: input.suggestions });
  await runtime.submit(threadId, { suggestions: [], finalize: true });
  expect(store.run(run.id)).toMatchObject({ status: "completed", suggestions: 1 });
  expect(store.checkpoints().gmail).toBe(run.until);
  expect(store.candidates()).toHaveLength(1);
  expect((await f.detail(task.id)).projection).toEqual(before.projection);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

it.each([undefined, "queued", "scheduled", "claimed", "waiting", "failed_retrying"])("retains a pending retry across reload (%s)", async queueState => {
  const { f, runtime, run, threadId, retry, advance } = await setup();
  f.queued.set(threadId, [retry(queueState)]); await runtime.tick(run.id);
  runtime.dispose(); await f.reload();
  const reloaded = new SourceSyncRuntime(f.bb, f.repo); runtimes.push(reloaded);
  advance(300_000); await reloaded.tick(run.id);
  expect(reloaded.store.run(run.id)).toMatchObject({ status: "working", finishedAt: null });
  expect(reloaded.store.checkpoints().gmail).toBeNull();
});

it.each(["no retry", "exhausted retry", "legacy failed retry", "ordinary message"])("reports a terminal stop after the scheduling grace: %s", async kind => {
  const { f, runtime, store, run, threadId, retry, advance } = await setup();
  if (kind === "exhausted retry") f.queued.set(threadId, [retry("failed_exhausted")]);
  if (kind === "legacy failed retry") f.queued.set(threadId, [{ ...retry(), failureReason: "Retry limit reached" }]);
  if (kind === "ordinary message") f.queued.set(threadId, [makeQueueEntry({ threadId })]);
  f.harness.inspection.sdk.stub("threads.events.list", async () => [{ id: "event-failed", threadId, seq: 10, createdAt: Date.now(), scope: { kind: "thread" }, type: "turn/completed",
    data: { status: "failed", error: { message: "Selected model is at capacity." } } }]);
  await runtime.tick(run.id); advance(29_999); await runtime.tick(run.id);
  expect(store.run(run.id).status).toBe("working");
  advance(1); await runtime.tick(run.id);
  expect(store.run(run.id)).toMatchObject({ status: "blocked", error: expect.stringContaining("Selected model is at capacity.") });
  expect(store.checkpoints().gmail).toBeNull();
  await expect(runtime.submit(threadId, { suggestions: [], finalize: true })).rejects.toThrow("already finished");
});

it("does not close a thread that resumes during the final status inspection", async () => {
  const { f, runtime, store, run, advance, state } = await setup();
  await runtime.tick(run.id); advance(30_000);
  f.harness.inspection.sdk.stub("threads.events.list", async () => { state("active"); return []; });
  await runtime.tick(run.id);
  expect(store.run(run.id).status).toBe("working");
});

it("preserves completion while the retry queue is being inspected", async () => {
  const { f, runtime, store, run, threadId } = await setup();
  f.harness.inspection.sdk.stub("threads.queuedMessages.list", async () => {
    await runtime.submit(threadId, { suggestions: [], finalize: true }); return [];
  });
  await runtime.tick(run.id);
  expect(store.run(run.id).status).toBe("completed");
  expect(store.checkpoints().gmail).toBe(run.until);
});

it("preserves cancellation even if a retry remains queued", async () => {
  const { f, runtime, store, run, threadId, retry, advance } = await setup();
  f.queued.set(threadId, [retry("scheduled")]); await runtime.tick(run.id);
  await runtime.cancel(run.id); advance(120_000); await runtime.tick(run.id);
  expect(store.run(run.id).status).toBe("cancelled");
  expect(store.checkpoints().gmail).toBeNull();
  await expect(runtime.submit(threadId, { suggestions: [], finalize: true })).rejects.toThrow("already finished");
});

it.each(["archivedAt", "deletedAt"])("does not wait for a retry after %s is set", async field => {
  const { f, runtime, store, run, threadId, retry } = await setup();
  f.queued.set(threadId, [retry("scheduled")]);
  f.threads.set(threadId, { ...f.threads.get(threadId)!, [field]: Date.now() });
  await runtime.tick(run.id);
  expect(store.run(run.id)).toMatchObject({ status: "blocked", error: expect.stringContaining("archived or deleted") });
});

it.each(["pending", "unavailable"])("keeps the existing run deadline when the retry queue is %s", async kind => {
  const { f, runtime, store, run, threadId, retry, advance } = await setup();
  if (kind === "pending") f.queued.set(threadId, [retry("scheduled")]);
  else f.harness.inspection.sdk.stub("threads.queuedMessages.list", async () => { throw new Error("Temporarily unavailable"); });
  await runtime.tick(run.id); advance(60_000); await runtime.tick(run.id);
  expect(store.run(run.id).status).toBe("working");
  advance(45 * 60_000); await runtime.tick(run.id);
  expect(store.run(run.id).status).toBe("cancelled");
  expect(store.checkpoints().gmail).toBeNull();
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
});
