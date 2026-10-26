import type Database from "better-sqlite3";
import { gzipSync } from "node:zlib";
import { syncCandidateSchema, syncRunSchema } from "./contracts.js";
import { unpackSourceJson } from "./source-storage.js";
import type { SourceExport } from "./source-collector.js";

export function retainSourcePayloads(db: Database.Database, days: number, apply = false, now = Date.now()) {
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("Invalid source retention period.");
  return db.transaction(() => {
    const result = { eligibleRuns: 0, protectedRuns: 0, bytesBefore: 0, bytesAfter: 0, citedCallsKept: 0, applied: apply, busy: false };
    if (db.prepare("SELECT 1 FROM source_sync_runs WHERE status IN ('starting','working','collecting') LIMIT 1").get()) return { ...result, busy: true };
    const protectedIds = new Set<string>();
    const cited = new Set<string>();
    const pendingRefs = new Set<string>();
    for (const row of db.prepare("SELECT value_json FROM source_sync_candidates").iterate() as Iterable<{ value_json: string }>) {
      const candidate = syncCandidateSchema.parse(JSON.parse(row.value_json));
      if (candidate.status === "pending") protectedIds.add(candidate.runId);
      for (const fact of candidate.facts) for (const citation of fact.citations) {
        cited.add(citation.callRef);
        if (candidate.status === "pending") pendingRefs.add(citation.callRef);
        const runId = /^export:([a-f0-9-]{36}):/.exec(citation.callRef)?.[1];
        if (candidate.status === "pending" && runId) protectedIds.add(runId);
      }
    }
    const baseline = db.prepare("SELECT id FROM source_sync_runs WHERE status IN ('completed','partial') AND json_extract(request_json,'$.incremental')=1 AND json_extract(request_json,'$.analysis') IS NOT NULL ORDER BY rowid DESC LIMIT 1").get() as { id: string } | undefined;
    if (baseline) protectedIds.add(baseline.id);
    for (const row of db.prepare("SELECT run_id FROM source_sync_exports ORDER BY rowid DESC LIMIT 3").all() as { run_id: string }[]) protectedIds.add(row.run_id);
    const checkpoints = new Map((db.prepare("SELECT source,through FROM source_sync_checkpoints").all() as { source: string; through: string }[]).map(r => [r.source, Date.parse(r.through)]));
    const ids = db.prepare(`SELECT id FROM source_sync_runs
      WHERE json_extract(value_json,'$.payloadRetiredAt') IS NULL
      AND julianday(json_extract(value_json,'$.finishedAt')) < julianday(?) ORDER BY rowid`).all(new Date(now - days * 86400000).toISOString()) as { id: string }[];
    for (const { id } of ids) {
      const row = db.prepare(`SELECT r.id,r.value_json,r.request_json,r.context_gzip,e.value_json AS export_json,e.value_gzip
        FROM source_sync_runs r LEFT JOIN source_sync_exports e ON e.run_id=r.id WHERE r.id=?`).get(id) as {
        id: string; value_json: string; request_json: string; context_gzip: Buffer | null; export_json: string | null; value_gzip: Buffer | null;
      };
      const run = syncRunSchema.parse(JSON.parse(row.value_json));
      // An unread interval is protected even after its collector has stopped.
      if (protectedIds.has(row.id) || !["completed", "partial", "blocked", "cancelled"].includes(run.status)
        || !Number.isFinite(Date.parse(run.until)) || !Object.keys(run.ranges).length
        || Object.keys(run.ranges).some(source => !(checkpoints.get(source)! >= Date.parse(run.until)))) {
        result.protectedRuns++; continue;
      }
      const bundle = row.export_json === null ? null : unpackSourceJson<SourceExport>(row.export_json, row.value_gzip);
      if (bundle?.calls.some(call => pendingRefs.has(call.ref))) { result.protectedRuns++; continue; }
      const calls = bundle?.calls.filter(call => cited.has(call.ref)) ?? [];
      // Citation receipts remain available for historical evidence and Slack
      // root-thread recovery. Unreferenced full bodies and frozen context expire.
      const retained = bundle && calls.length ? gzipSync(JSON.stringify({ ...bundle, calls, documents: [] })) : null;
      const metadata = JSON.parse(row.request_json);
      delete metadata.snapshots; delete metadata.pendingCandidates;
      const context = gzipSync(JSON.stringify({ snapshots: [], pendingCandidates: [] }));
      result.eligibleRuns++;
      result.bytesBefore += Buffer.byteLength(row.request_json) + (row.context_gzip?.length ?? 0) + Buffer.byteLength(row.export_json ?? "") + (row.value_gzip?.length ?? 0);
      result.bytesAfter += Buffer.byteLength(JSON.stringify(metadata)) + context.length + (retained?.length ?? 0);
      result.citedCallsKept += calls.length;
      if (apply) {
        if (retained) db.prepare("UPDATE source_sync_exports SET value_json='{}',value_gzip=? WHERE run_id=?").run(retained, row.id);
        else db.prepare("DELETE FROM source_sync_exports WHERE run_id=?").run(row.id);
        db.prepare("UPDATE source_sync_runs SET request_json=?,context_gzip=?,value_json=? WHERE id=?").run(JSON.stringify(metadata), context, JSON.stringify({ ...run, payloadRetiredAt: new Date(now).toISOString() }), row.id);
      }
    }
    if (apply && result.eligibleRuns) db.prepare("UPDATE source_storage_state SET needs_compaction=1 WHERE id=1").run();
    return result;
  })();
}
