import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

// Released as migration 33, then removed during a feature rollback. Its exact
// text must remain available for databases that recorded it before the rollback.
export const RETIRED_TIME_MIGRATION = `CREATE TABLE time_review_contexts (id TEXT PRIMARY KEY, value_json TEXT NOT NULL);
   CREATE TABLE time_proposals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), date TEXT NOT NULL, status TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, value_json TEXT NOT NULL);
   CREATE UNIQUE INDEX one_pending_time_proposal ON time_proposals(task_id,date) WHERE status='pending';
   CREATE TABLE time_daily_reviews (date TEXT PRIMARY KEY, reviewed_at TEXT NOT NULL, revision TEXT NOT NULL);`;
const retiredHash = createHash("sha256").update(RETIRED_TIME_MIGRATION).digest("hex");

export function compatibleMigrations(db: Database.Database, statements: string[]): string[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_bb_migrations'").get()) return statements;
  const columns = db.prepare("PRAGMA table_info(_bb_migrations)").all() as { name: string }[];
  const recorded = db.prepare(columns.some(c => c.name === "statement_hash")
    ? "SELECT statement_hash FROM _bb_migrations WHERE id=33"
    : "SELECT NULL AS statement_hash FROM _bb_migrations WHERE id=33").get() as { statement_hash: string | null } | undefined;
  const legacy = recorded?.statement_hash === retiredHash || recorded?.statement_hash === null
    && !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='time_review_contexts'").get();
  if (!legacy) return statements; // Unknown hashes still fail the SDK's integrity check.
  const result = [...statements];
  // 0.5.32 reused index 33 for source preferences. On the older history, retain
  // 33 and append that table at 34; both histories resume shared migrations at 35.
  result.splice(33, 2, RETIRED_TIME_MIGRATION, statements[33]);
  return result;
}
