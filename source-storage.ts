import type Database from "better-sqlite3";
import { gzip, gzipSync, gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";

export const SOURCE_STORAGE_MIGRATION = `
  ALTER TABLE source_sync_exports ADD COLUMN value_gzip BLOB;
  ALTER TABLE source_sync_runs ADD COLUMN context_gzip BLOB;
  CREATE TABLE source_storage_state (id INTEGER PRIMARY KEY CHECK(id=1), needs_compaction INTEGER NOT NULL CHECK(needs_compaction IN (0,1)));
  INSERT INTO source_storage_state VALUES (1,0);
`;

// Above the collector's bounded export size, including JSON escaping and its
// copies of document bodies. Never allocate unbounded output from a damaged blob.
const MAX_BYTES = 256 * 1024 * 1024;
const gzipAsync = promisify(gzip);
type Request = Record<string, unknown>;
type RequestRow = { request_json: string; context_gzip: Buffer | null };

function rawBytes(raw: string) {
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.length > MAX_BYTES) throw new Error("Saved source payload exceeds the compression limit; original data is unchanged.");
  return bytes;
}
export function unpackSourceJson<T>(plain: string, compressed: Buffer | null): T {
  if (compressed === null) return JSON.parse(plain) as T;
  try { return JSON.parse(gunzipSync(compressed, { maxOutputLength: MAX_BYTES }).toString("utf8")) as T; }
  catch { throw new Error("Compressed source data could not be verified. Restore the affected data from a verified backup."); }
}
function splitRequest(request: Request) {
  const metadata = { ...request }, context: Request = {};
  for (const key of ["snapshots", "pendingCandidates"]) {
    if (Object.hasOwn(metadata, key)) { context[key] = metadata[key]; delete metadata[key]; }
  }
  return { metadata: JSON.stringify(metadata), context: JSON.stringify(context) };
}
export function packSourceRequest(request: Request) {
  const parts = splitRequest(request);
  return { metadata: parts.metadata, context: gzipSync(rawBytes(parts.context)) };
}

export class SourceStorage {
  constructor(readonly db: Database.Database) {}
  private row(id: string): RequestRow {
    const row = this.db.prepare("SELECT request_json,context_gzip FROM source_sync_runs WHERE id=?").get(id) as RequestRow | undefined;
    if (!row) throw new Error("Update check not found.");
    return row;
  }
  request<T>(id: string): T {
    const row = this.row(id), metadata = JSON.parse(row.request_json);
    return (row.context_gzip === null ? metadata : { ...metadata, ...unpackSourceJson<Request>("{}", row.context_gzip) }) as T;
  }
  saveRequest(id: string, request: Request) {
    const packed = packSourceRequest(request);
    this.db.transaction(() => {
      if (this.row(id).context_gzip === null) this.dirty();
      this.db.prepare("UPDATE source_sync_runs SET request_json=?,context_gzip=? WHERE id=?").run(packed.metadata, packed.context, id);
    })();
  }
  // Page receipts and analysis state change often; keep them queryable without
  // decompressing or recompressing the immutable task snapshot on every page.
  patchMetadata(id: string, change: (metadata: Request) => Request) {
    this.db.transaction(() => {
      const row = this.row(id), updated = change(JSON.parse(row.request_json));
      if (row.context_gzip === null) this.saveRequest(id, updated);
      else this.db.prepare("UPDATE source_sync_runs SET request_json=? WHERE id=?").run(JSON.stringify(updated), id);
    })();
  }
  export<T>(id: string): T | null {
    const row = this.db.prepare("SELECT value_json,value_gzip FROM source_sync_exports WHERE run_id=?").get(id) as { value_json: string; value_gzip: Buffer | null } | undefined;
    return row ? unpackSourceJson<T>(row.value_json, row.value_gzip) : null;
  }
  saveExport(id: string, value: unknown) {
    this.db.prepare("INSERT INTO source_sync_exports(run_id,value_json,value_gzip) VALUES (?,'{}',?)").run(id, gzipSync(rawBytes(JSON.stringify(value))));
  }
  private dirty() { this.db.prepare("UPDATE source_storage_state SET needs_compaction=1 WHERE id=1").run(); }

  // A row is replaced only after round-trip verification and only if it is
  // still the row read before the async compression. Cancellation leaves it
  // readable in the legacy format. Every completed row survives a restart.
  async compressOne(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const item = this.db.prepare("SELECT run_id,value_json FROM source_sync_exports WHERE value_gzip IS NULL LIMIT 1").get() as { run_id: string; value_json: string } | undefined;
    const request = item ? undefined : this.db.prepare("SELECT id,request_json FROM source_sync_runs WHERE context_gzip IS NULL LIMIT 1").get() as { id: string; request_json: string } | undefined;
    if (!item && !request) return false;
    const parts = request ? splitRequest(JSON.parse(request.request_json)) : null;
    const bytes = rawBytes(item ? item.value_json : parts!.context);
    const compressed = await gzipAsync(bytes);
    if (signal.aborted) return false;
    if (!gunzipSync(compressed, { maxOutputLength: MAX_BYTES }).equals(bytes)) throw new Error("Source compression did not round-trip; original data is unchanged.");
    this.db.transaction(() => {
      const result = item
        ? this.db.prepare("UPDATE source_sync_exports SET value_json='{}',value_gzip=? WHERE run_id=? AND value_gzip IS NULL AND value_json=?").run(compressed, item.run_id, item.value_json)
        : this.db.prepare("UPDATE source_sync_runs SET request_json=?,context_gzip=? WHERE id=? AND context_gzip IS NULL AND request_json=?").run(parts!.metadata, compressed, request!.id, request!.request_json);
      if (result.changes) this.dirty();
    })();
    return true;
  }
  compact(): boolean {
    const state = this.db.prepare("SELECT needs_compaction FROM source_storage_state WHERE id=1").get() as { needs_compaction: number };
    if (!state.needs_compaction || this.db.inTransaction) return false;
    // Do not interrupt collection, a review, or a calendar import. The next
    // maintenance pass can reclaim pages after those operations finish.
    if (this.db.prepare("SELECT 1 FROM source_sync_runs WHERE status IN ('starting','working','collecting') LIMIT 1").get()
      || this.db.prepare("SELECT 1 FROM sessions WHERE status IN ('starting','collecting','review_starting','reviewing','repair_starting') LIMIT 1").get()
      || this.db.prepare("SELECT 1 FROM calendar_sync_state WHERE json_extract(value_json,'$.status')='running' LIMIT 1").get()) return false;
    if (this.db.name !== ":memory:") {
      const fs = statfsSync(dirname(this.db.name));
      const pages = Number(this.db.pragma("page_count", { simple: true })), pageSize = Number(this.db.pragma("page_size", { simple: true }));
      if (fs.bavail * fs.bsize < pages * pageSize + 64 * 1024 * 1024) return false;
    }
    this.db.exec("VACUUM");
    this.db.prepare("UPDATE source_storage_state SET needs_compaction=0 WHERE id=1").run();
    // A checkpoint can be deferred by another reader. VACUUM has already
    // succeeded; the normal WAL checkpoint will reclaim the remaining log.
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    return true;
  }
  async maintain(signal: AbortSignal) {
    while (await this.compressOne(signal)) { /* Async compression yields between rows. */ }
    if (!signal.aborted) this.compact();
  }
}
