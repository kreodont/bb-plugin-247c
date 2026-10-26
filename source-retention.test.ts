import { afterEach, expect, it } from "vitest";
import { fixture } from "./test-support.js";
import { sourceData, startSourceSync, submitSourceData } from "./source-sync-test-support.js";
import { SourceSyncStore } from "./source-sync.js";
import { retainSourcePayloads } from "./source-retention.js";
import type { SourceExport } from "./source-collector.js";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.harness.lifecycle.dispose(); });
const future = Date.now() + 20 * 86400000;
async function setup(pending = false) {
  const f = await fixture(); fixtures.push(f);
  const task = await f.create("Keep accepted history");
  const store = new SourceSyncStore(f.repo);
  const runs = [];
  for (let n = 0; n < 4; n++) {
    const { run } = await startSourceSync(f);
    const { calls, input } = await sourceData(f, run, task.id);
    if (n || !pending) input.suggestions = [];
    await submitSourceData(f, run, input);
    const bundle: SourceExport = { version: 1, runId: run.id, startedAt: run.startedAt, finishedAt: run.until,
      elapsedMs: 10, reports: input.reports, calls, documents: [{ ref: "unused", source: "gmail", tool: "get_thread", args: {}, content: "Unreferenced body".repeat(1000) }] };
    store.saveExport(bundle);
    runs.push(run);
  }
  return { f, store, runs, task };
}

it("previews then retires old payloads without changing tasks, evidence, checkpoints or history", async () => {
  const { f, store, runs, task } = await setup();
  const dossier = f.repo.detail(task.id), checkpoints = store.checkpoints();
  const preview = retainSourcePayloads(f.repo.db, 14, false, future);
  expect(preview.eligibleRuns).toBe(1);
  expect(store.export(runs[0].id)).not.toBeNull();
  const result = retainSourcePayloads(f.repo.db, 14, true, future);
  expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
  expect(store.export(runs[0].id)).toBeNull();
  expect(store.request(runs[0].id).snapshots).toEqual([]);
  expect(store.run(runs[0].id).payloadRetiredAt).toBe(new Date(future).toISOString());
  expect(store.checkpoints()).toEqual(checkpoints);
  expect(f.repo.detail(task.id)).toEqual(dossier);
  expect(retainSourcePayloads(f.repo.db, 14, true, future).eligibleRuns).toBe(0);
  expect(f.repo.db.pragma("foreign_key_check")).toEqual([]);
});

it("protects pending proposals and keeps their cited receipts after acceptance", async () => {
  const { f, store, runs } = await setup(true);
  expect(retainSourcePayloads(f.repo.db, 14, true, future).eligibleRuns).toBe(0);
  const candidate = store.candidates()[0];
  await f.harness.behavior.callRpc("syncAccept", { candidateId: candidate.id });
  const before = f.repo.detail(candidate.taskId!);
  const result = retainSourcePayloads(f.repo.db, 14, true, future);
  expect(result.eligibleRuns).toBe(1);
  expect(result.citedCallsKept).toBe(1);
  expect(store.export(runs[0].id)?.calls.map(c => c.ref)).toEqual([candidate.facts[0].citations[0].callRef]);
  expect(store.export(runs[0].id)?.documents).toEqual([]);
  expect(f.repo.detail(candidate.taskId!)).toEqual(before);
});

it("protects unread intervals and pauses cleanup during active collection", async () => {
  const { f, store, runs } = await setup();
  f.repo.db.prepare("UPDATE source_sync_checkpoints SET through=? WHERE source='jira'").run(runs[0].ranges.jira.since);
  expect(retainSourcePayloads(f.repo.db, 14, true, future).eligibleRuns).toBe(0);
  f.repo.db.prepare("UPDATE source_sync_checkpoints SET through=?").run(runs[3].until);
  const active = await startSourceSync(f);
  expect(retainSourcePayloads(f.repo.db, 14, true, future).busy).toBe(true);
  store.save({ ...active.run, status: "blocked", finishedAt: new Date().toISOString() });
  expect(retainSourcePayloads(f.repo.db, 14, false, future).eligibleRuns).toBeGreaterThan(0);
});

it("keeps an old incremental baseline and rejects invalid policy values", async () => {
  const { f, store, runs } = await setup();
  store.storage.patchMetadata(runs[0].id, m => ({ ...m, incremental: true, analysis: {} }));
  expect(retainSourcePayloads(f.repo.db, 14, true, future).eligibleRuns).toBe(0);
  for (const days of [0, -1, 1.5, 3651]) expect(() => retainSourcePayloads(f.repo.db, days)).toThrow();
});
