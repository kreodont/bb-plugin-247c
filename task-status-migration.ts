import type Database from "better-sqlite3";

// Append-only migration: SQLite requires rebuilding a table to extend CHECK.
// Keep the original CORE_SCHEMA text and all existing migration hashes intact.
export const TASK_STATUS_MIGRATION = `
  CREATE TABLE tasks_with_waiting (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open', 'waiting', 'done', 'archived')),
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO tasks_with_waiting(rowid,id,title,status,revision,created_at,updated_at)
    SELECT rowid,id,title,status,revision,created_at,updated_at FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_with_waiting RENAME TO tasks;
  CREATE TEMP TABLE c247_fk_guard (violations INTEGER CHECK(violations = 0));
  INSERT INTO c247_fk_guard SELECT count(*) FROM pragma_foreign_key_check;
  DROP TABLE c247_fk_guard;
`;

// Foreign-key enforcement must be suspended outside the SDK's migration
// transaction for this table rebuild. The migration itself checks every FK
// before committing, so any failure rolls back data and the migration ledger.
export function migrateTaskStatuses(db: Database.Database, migrate: () => void) {
  if (db.inTransaction) throw new Error("Task status migration requires its own transaction.");
  const foreignKeys = db.pragma("foreign_keys", { simple: true });
  try {
    db.pragma("foreign_keys = OFF");
    migrate();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}
