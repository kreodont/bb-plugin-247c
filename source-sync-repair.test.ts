import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { sourceData, startSourceSync } from "./source-sync-test-support.js";
import { SourceSyncRuntime, SourceSyncStore } from "./source-sync.js";
import { collectSources, SOURCE_PAGE_BYTES, sourceExportPage, type SourceExport } from "./source-collector.js";
import type { SourceConnections } from "./source-connectors.js";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.harness.lifecycle.dispose(); vi.restoreAllMocks(); });
async function setup() { const f = await fixture(); fixtures.push(f); return f; }
async function scriptRun(f: Awaited<ReturnType<typeof fixture>>, taskId: string) {
  const { run } = await startSourceSync(f);
  const { input, calls } = await sourceData(f, run, taskId);
  const store = new SourceSyncStore(f.repo);
  store.save({ ...run, collection: { phase: "analyzing", calls: calls.length, reads: 1, elapsedMs: 15 } });
  const bundle: SourceExport = { version: 1, runId: run.id, startedAt: run.startedAt, finishedAt: run.until, elapsedMs: 15, calls, reports: input.reports, documents: [] };
  store.saveExport(bundle); store.recordDataPage(run.id, 0);
  return { run, input, calls, store, bundle };
}

it("bounds every serialized page and reassembles Unicode and heavily escaped content without loss", async () => {
  const f = await setup(); const task = await f.create();
  const { bundle } = await scriptRun(f, task.id);
  bundle.documents = ["Привет 😀\n\t\"\\".repeat(11000), ""].map((content, index) => ({ ref: `ref-${index}`, source: "gmail", tool: "get_thread", args: { threadId: `thread-${index}` }, content }));
  const first = sourceExportPage(bundle, 0), chunks = [];
  for (let page = 0; page < first.totalPages; page++) {
    const data = sourceExportPage(bundle, page);
    expect(Buffer.byteLength(JSON.stringify(data, null, 2))).toBeLessThanOrEqual(SOURCE_PAGE_BYTES);
    expect(data.nextPage).toBe(page + 1 < first.totalPages ? page + 1 : null);
    chunks.push(...data.documents);
  }
  for (const doc of bundle.documents) {
    const parts = chunks.filter(c => c.ref === doc.ref);
    expect(parts.map(p => p.content).join("")).toBe(doc.content);
    expect(parts.map(p => p.part)).toEqual(parts.map((_, i) => i + 1));
    expect(parts.every(p => p.parts === parts.length)).toBe(true);
    expect(parts.some(p => /[\uD800-\uDBFF]$/.test(p.content))).toBe(false);
  }
});

it("saves batches across reloads and advances checkpoints only on explicit completion", async () => {
  const f = await setup(); const a = await f.create("A"), b = await f.create("B");
  const { run, input } = await scriptRun(f, a.id);
  const before = [await f.detail(a.id), await f.detail(b.id)];
  const ctx = { threadId: run.threadId! };
  const submit = (suggestions = input.suggestions, finalize?: boolean) => f.harness.behavior.callAgentTool("c247_sync_submit", { suggestions, ...(finalize === undefined ? {} : { finalize }) }, ctx);
  await submit();
  await f.reload();
  const store = new SourceSyncStore(f.repo);
  expect(store.run(run.id)).toMatchObject({ status: "working", suggestions: 1, finishedAt: null });
  expect(store.checkpoints().gmail).toBeNull();
  await submit();
  expect(store.run(run.id).suggestions).toBe(1);
  const second = structuredClone(input.suggestions); second[0].taskId = b.id;
  await submit(second);
  expect(store.run(run.id).suggestions).toBe(2);
  await submit([], true);
  const completed = store.run(run.id);
  expect(completed).toMatchObject({ status: "completed", suggestions: 2 });
  expect(store.checkpoints().gmail).toBe(run.until);
  await submit([], true);
  expect(store.run(run.id)).toEqual(completed);
  expect((await f.detail(a.id)).projection).toEqual(before[0].projection);
  expect((await f.detail(b.id)).facts).toEqual(before[1].facts);
});

it("reports every invalid draft with its index and task identity and retains earlier batches", async () => {
  const f = await setup(); const open = await f.create("Open"), closed = await f.create("Closed");
  f.repo.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(closed.id);
  const { run, input, store } = await scriptRun(f, open.id);
  const ctx = { threadId: run.threadId! };
  await f.harness.behavior.callAgentTool("c247_sync_submit", { suggestions: input.suggestions }, ctx);
  const missingId = randomUUID();
  const invalid = [structuredClone(input.suggestions[0]), structuredClone(input.suggestions[0])];
  invalid[0].taskId = missingId; invalid[1].taskId = closed.id;
  let error = "";
  try { await f.harness.behavior.callAgentTool("c247_sync_submit", { suggestions: invalid, finalize: true }, ctx); }
  catch (cause) { error = String(cause); }
  expect(error).toContain(`suggestions[0]`); expect(error).toContain(missingId);
  expect(error).toContain(`suggestions[1]`); expect(error).toContain("status=done");
  expect(store.run(run.id)).toMatchObject({ status: "working", suggestions: 1 });
  expect(store.candidates()).toHaveLength(1); expect(store.checkpoints().gmail).toBeNull();
});

it("replaces an unreviewed batch with a combined proposal under a new approval identity", async () => {
  const f = await setup(); const task = await f.create();
  const { run, input, store } = await scriptRun(f, task.id);
  const ctx = { threadId: run.threadId! };
  await f.harness.behavior.callAgentTool("c247_sync_submit", { suggestions: input.suggestions }, ctx);
  const original = store.candidates()[0];
  const combined = structuredClone(input.suggestions);
  combined[0].changes.summary!.value += " Сохранён уточнённый результат анализа.";
  await f.harness.behavior.callAgentTool("c247_sync_submit", { suggestions: combined }, ctx);
  expect(store.candidate(original.id).status).toBe("superseded");
  const pending = store.candidates().filter(c => c.status === "pending");
  expect(pending).toHaveLength(1); expect(pending[0].id).not.toBe(original.id);
  expect(store.run(run.id).suggestions).toBe(1);
  expect(() => store.accept(original.id)).toThrow(/superseded/);
  await f.harness.behavior.callAgentTool("c247_sync_submit", { suggestions: combined, finalize: true }, ctx);
  expect(store.candidates().filter(c => c.status === "pending")).toHaveLength(1);
});

it("supplements a finished export without changing accepted data, previous candidates or checkpoints", async () => {
  const f = await setup(); const a = await f.create("A"), b = await f.create("B");
  const { run, input, store } = await scriptRun(f, a.id);
  await f.harness.behavior.callAgentTool("c247_sync_submit", { suggestions: input.suggestions, finalize: true }, { threadId: run.threadId! });
  const original = store.candidates()[0], finished = store.run(run.id).finishedAt;
  const checkpoints = store.checkpoints(), before = await f.detail(b.id);
  const extra = structuredClone(input.suggestions); extra[0].taskId = b.id;
  const runtime = new SourceSyncRuntime(f.bb, f.repo);
  runtime.supplement(run.id, extra); runtime.supplement(run.id, extra);
  expect(store.candidates()).toHaveLength(2);
  expect(store.candidate(original.id)).toEqual(original);
  expect(store.checkpoints()).toEqual(checkpoints);
  expect(store.run(run.id)).toMatchObject({ status: "completed", suggestions: 2, finishedAt: finished });
  expect((await f.detail(b.id)).projection).toEqual(before.projection);
  expect((await f.detail(b.id)).facts).toEqual(before.facts);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

it("rejects stale or fabricated supplements atomically and cannot revive a cancelled run", async () => {
  const f = await setup(); const task = await f.create();
  const { run, input, store } = await scriptRun(f, task.id);
  await f.harness.behavior.callAgentTool("c247_sync_submit", { suggestions: [], finalize: true }, { threadId: run.threadId! });
  const runtime = new SourceSyncRuntime(f.bb, f.repo);
  const fabricated = structuredClone(input.suggestions); fabricated[0].facts[0].citations[0].quote = "Invented";
  expect(() => runtime.supplement(run.id, fabricated)).toThrow(/quote is absent/);
  f.repo.db.prepare("UPDATE tasks SET revision=revision+1 WHERE id=?").run(task.id);
  expect(() => runtime.supplement(run.id, input.suggestions)).toThrow(/The dossier changed/);
  expect(store.candidates()).toHaveLength(0);
  store.save({ ...store.run(run.id), status: "cancelled" });
  expect(() => runtime.supplement(run.id, [])).toThrow(/already finished/);
});

it.each(["throw", "payload"])("retries MCP Request timed out returned as %s", async mode => {
  const f = await setup(); const task = await f.create();
  const { run } = await scriptRun(f, task.id);
  let attempts = 0;
  const connections: SourceConnections = { gmail: { error: "No access" }, slack: { error: "No access" }, jira: { close: async () => {}, async call() {
    if (++attempts === 1) {
      if (mode === "throw") throw new Error("MCP error -32001: Request timed out");
      return { isError: true, content: [{ type: "text", text: "MCP error -32001: Request timed out" }] };
    }
    return { content: [{ type: "text", text: '{"issues":[],"isLast":true}' }] };
  } } };
  const result = await collectSources(run, [], { gmailQuotaUnitsPerMinute: Infinity, connect: async () => connections });
  expect(attempts).toBe(2); expect(result.reports[2].status).toBe("complete");
  expect(result.calls.every(call => call.completed)).toBe(true);
});
