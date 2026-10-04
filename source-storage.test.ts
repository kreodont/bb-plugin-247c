import { afterEach, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { statfsSync } from "node:fs";
import { fixture } from "./test-support.js";
import { startSourceSync, sourceData } from "./source-sync-test-support.js";
import { SourceStorage } from "./source-storage.js";
import { SourceSyncStore } from "./source-sync.js";
import type { SourceExport } from "./source-collector.js";

vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, statfsSync: vi.fn(fs.statfsSync) };
});
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.harness.lifecycle.dispose(); vi.clearAllMocks(); });
async function setup(legacy = false) {
  const f = await fixture(); fixtures.push(f);
  const task = await f.create("Preserve source history");
  const { run } = await startSourceSync(f), store = new SourceSyncStore(f.repo);
  const { calls, input } = await sourceData(f, run, task.id);
  const bundle: SourceExport = { version: 1, runId: run.id, startedAt: run.startedAt, finishedAt: run.until, elapsedMs: 10, reports: input.reports, calls,
    documents: [{ ref: "unicode", source: "gmail", tool: "get_thread", args: { threadId: "fixture" }, content: 'Привет 😀\n\t"\\'.repeat(20000) }] };
  const request = store.request(run.id), rawExport = `\n${JSON.stringify(bundle)}\n`;
  if (legacy) {
    f.repo.db.prepare("UPDATE source_sync_runs SET request_json=?,context_gzip=NULL WHERE id=?").run(JSON.stringify(request), run.id);
    f.repo.db.prepare("INSERT INTO source_sync_exports(run_id,value_json) VALUES (?,?)").run(run.id, rawExport);
  } else store.saveExport(bundle);
  return { f, task, run, store, bundle, request, rawExport };
}
const pending = (db: Awaited<ReturnType<typeof fixture>>["repo"]["db"]) => db.prepare("SELECT needs_compaction FROM source_storage_state").get();

it("compresses new exports and frozen context while leaving launch metadata queryable", async () => {
  const { f, run, store, request, bundle } = await setup();
  const saved = f.repo.db.prepare("SELECT value_json,value_gzip FROM source_sync_exports WHERE run_id=?").get(run.id) as { value_json: string; value_gzip: Buffer };
  expect(saved.value_json).toBe("{}");
  expect(saved.value_gzip.length).toBeLessThan(Buffer.byteLength(JSON.stringify(bundle)) / 4);
  expect(store.export(run.id)).toEqual(bundle);
  expect(store.request(run.id)).toEqual(request);
  const row = f.repo.db.prepare("SELECT request_json,context_gzip,json_extract(request_json,'$.input.request.providerId') AS provider FROM source_sync_runs WHERE id=?").get(run.id) as { request_json: string; context_gzip: Buffer; provider: string };
  expect(JSON.parse(row.request_json).snapshots).toBeUndefined();
  expect(JSON.parse(row.request_json).pendingCandidates).toBeUndefined();
  expect(row.provider).toBe(request.input!.request.providerId);
  for (let page = 0; page < 20; page++) store.recordDataPage(run.id, page);
  store.recordDayReview(run.id, ["item", "item"]);
  expect(f.repo.db.prepare("SELECT context_gzip FROM source_sync_runs WHERE id=?").get(run.id)).toEqual({ context_gzip: row.context_gzip });
  await f.reload();
  const reloaded = new SourceSyncStore(f.repo);
  expect(reloaded.request(run.id)).toEqual({ ...request, dataPagesRead: Array.from({ length: 20 }, (_, i) => i), dayItemsRead: ["item"] });
  expect(reloaded.export(run.id)).toEqual(bundle);
});

it("migrates legacy rows losslessly, preserves proposals, and compacts only after an active check finishes", async () => {
  const { f, task, run, store, request, bundle, rawExport } = await setup(true);
  const before = f.repo.detail(task.id), ledger = f.repo.db.prepare("SELECT * FROM _bb_migrations").all();
  await store.storage.maintain(new AbortController().signal);
  expect(store.request(run.id)).toEqual(request);
  expect(store.export(run.id)).toEqual(bundle);
  expect(f.repo.detail(task.id)).toEqual(before);
  expect(f.repo.db.prepare("SELECT * FROM _bb_migrations").all()).toEqual(ledger);
  const row = f.repo.db.prepare("SELECT value_gzip FROM source_sync_exports WHERE run_id=?").get(run.id) as { value_gzip: Buffer };
  expect(gunzipSync(row.value_gzip).toString()).toBe(rawExport);
  expect(pending(f.repo.db)).toEqual({ needs_compaction: 1 });
  store.save({ ...store.run(run.id), status: "partial", finishedAt: new Date().toISOString() });
  expect(store.storage.compact()).toBe(true);
  expect(store.storage.compact()).toBe(false);
  expect(pending(f.repo.db)).toEqual({ needs_compaction: 0 });
  expect(f.repo.db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  expect(f.repo.db.pragma("foreign_key_check")).toEqual([]);
});

it("does not write a row after cancellation and resumes with mixed storage formats", async () => {
  const { f, run, store, request, bundle, rawExport } = await setup(true);
  const controller = new AbortController();
  const migrating = store.storage.compressOne(controller.signal); controller.abort();
  expect(await migrating).toBe(false);
  expect(f.repo.db.prepare("SELECT value_json,value_gzip FROM source_sync_exports").get()).toEqual({ value_json: rawExport, value_gzip: null });
  expect(await store.storage.compressOne(new AbortController().signal)).toBe(true);
  expect(store.export(run.id)).toEqual(bundle);
  expect(store.request(run.id)).toEqual(request);
  await f.reload();
  const reloaded = new SourceStorage(f.repo.db);
  await reloaded.maintain(new AbortController().signal);
  expect(reloaded.request(run.id)).toEqual(request);
  expect(reloaded.export(run.id)).toEqual(bundle);
});

it("keeps concurrent metadata edits when async migration loses its compare-and-swap", async () => {
  const { f, run, store, request } = await setup(true);
  await store.storage.compressOne(new AbortController().signal); // Export first.
  const migrating = store.storage.compressOne(new AbortController().signal);
  store.recordDataPage(run.id, 9); // Converts the context itself while compression yields.
  await migrating;
  expect(store.request(run.id)).toEqual({ ...request, dataPagesRead: [9] });
  expect(f.repo.db.prepare("SELECT context_gzip IS NOT NULL AS compressed FROM source_sync_runs").get()).toEqual({ compressed: 1 });
});

it("preserves raw rows on a failed conversion and retries compaction after disk space returns", async () => {
  const { f, run, store, bundle } = await setup(true);
  f.repo.db.prepare("UPDATE source_sync_runs SET request_json='invalid' WHERE id=?").run(run.id);
  await expect(store.storage.maintain(new AbortController().signal)).rejects.toThrow();
  expect(store.export(run.id)).toEqual(bundle);
  expect(f.repo.db.prepare("SELECT request_json,context_gzip FROM source_sync_runs").get()).toEqual({ request_json: "invalid", context_gzip: null });
  store.save({ ...store.run(run.id), status: "partial", finishedAt: new Date().toISOString() });
  vi.mocked(statfsSync).mockReturnValueOnce({ bavail: 0, bsize: 4096 } as ReturnType<typeof statfsSync>);
  expect(store.storage.compact()).toBe(false);
  expect(pending(f.repo.db)).toEqual({ needs_compaction: 1 });
  expect(store.storage.compact()).toBe(true);
});

it("reports damaged compressed data instead of returning an empty history", async () => {
  const { f, run, store } = await setup();
  f.repo.db.prepare("UPDATE source_sync_exports SET value_gzip=? WHERE run_id=?").run(Buffer.from("damaged"), run.id);
  expect(() => store.export(run.id)).toThrow(/could not be verified/);
  f.repo.db.prepare("UPDATE source_sync_runs SET context_gzip=? WHERE id=?").run(Buffer.from("damaged"), run.id);
  expect(() => store.request(run.id)).toThrow(/could not be verified/);
});

it("stops background migration cleanly on reload and resumes without losing a source row", async () => {
  const { f, run, store, bundle, request } = await setup(true);
  const service = f.harness.behavior.runService("source-storage");
  service.controller.abort(); await service.done;
  await f.reload();
  const reloaded = new SourceSyncStore(f.repo);
  expect(reloaded.export(run.id)).toEqual(bundle);
  expect(reloaded.request(run.id)).toEqual(request);
  const restarted = f.harness.behavior.runService("source-storage");
  await vi.waitFor(() => expect(f.repo.db.prepare("SELECT count(*) AS n FROM source_sync_runs WHERE context_gzip IS NULL").get()).toEqual({ n: 0 }));
  restarted.controller.abort(); await restarted.done;
  expect(reloaded.export(run.id)).toEqual(bundle);
});
