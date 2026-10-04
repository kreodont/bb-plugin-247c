import { migrateTaskStatuses, TASK_STATUS_MIGRATION } from "./task-status-migration.js";
import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { CORE_SCHEMA } from "./core/schema.js";
import { EXTRA_SCHEMA, Repository } from "./repository.js";
import { compatibleMigrations, CUSTOMER_MIGRATION, RETIRED_TIME_MIGRATION } from "./migration-compatibility.js";
import { DayPlanning } from "./day-planning.js";
import { randomUUID } from "node:crypto";

const current = [CORE_SCHEMA, ...EXTRA_SCHEMA];
it.each(["fresh", "pre-sources", "retired-time", "sources"])("preserves the %s database history across upgrade and reload", async history => {
  const { bb, harness } = createFakePluginHost({ pluginId: "migration-test" });
  const db = bb.storage.database();
  try {
    const previous = history === "fresh" ? [] : history === "pre-sources" ? current.slice(0, 33)
      : history === "retired-time" ? [...current.slice(0, 33), RETIRED_TIME_MIGRATION] : current.slice(0, 34);
    bb.storage.migrate(db, previous);
    const before = db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all();
    const repo = new Repository(db, () => {}), days = new DayPlanning(repo);
    const task = history !== "fresh" ? repo.kernel.createTask({ title: "Preserve work" }) : null;
    const item = task ? days.add({ taskId: task.id, date: "2026-09-21", plannedMinutes: 60, reportedMinutes: 25, requestId: randomUUID() }) : null;
    migrateTaskStatuses(db, () => bb.storage.migrate(db, compatibleMigrations(db, current)));
    migrateTaskStatuses(db, () => bb.storage.migrate(db, compatibleMigrations(db, current)));
    expect(db.prepare("SELECT * FROM _bb_migrations WHERE id < ? ORDER BY id").all(previous.length)).toEqual(before);
    expect(db.prepare("SELECT count(*) AS n FROM task_source_preferences").get()).toEqual({ n: 0 });
    if (item) expect(days.get(item.id)).toEqual(item);
    expect(!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='time_proposals'").get()).toBe(history === "retired-time");
    const future = [...current, "CREATE TABLE future_marker (id INTEGER PRIMARY KEY)"];
    migrateTaskStatuses(db, () => bb.storage.migrate(db, compatibleMigrations(db, future)));
    expect(db.prepare("SELECT count(*) AS n FROM future_marker").get()).toEqual({ n: 0 });
  } finally { await harness.lifecycle.dispose(); }
});

it("rejects an unknown collision without rewriting the migration ledger", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "migration-test" });
  const db = bb.storage.database();
  try {
    bb.storage.migrate(db, [...current.slice(0, 33), "CREATE TABLE unrelated (id INTEGER PRIMARY KEY)"]);
    const before = db.prepare("SELECT * FROM _bb_migrations").all();
    expect(() => migrateTaskStatuses(db, () => bb.storage.migrate(db, compatibleMigrations(db, current)))).toThrow(/does not match/);
    expect(db.prepare("SELECT * FROM _bb_migrations").all()).toEqual(before);
  } finally { await harness.lifecycle.dispose(); }
});

it.each(["customer", "waiting", "customer-retired", "waiting-retired"])("merges the %s migration history without losing accepted data", async history => {
  const { bb, harness } = createFakePluginHost({ pluginId: "migration-test" });
  const db = bb.storage.database(); db.pragma("foreign_keys = ON");
  try {
    const waiting = history.startsWith("waiting");
    const previous = [...current.slice(0, 35), waiting ? TASK_STATUS_MIGRATION : CUSTOMER_MIGRATION];
    if (history.endsWith("retired")) previous.splice(33, 2, RETIRED_TIME_MIGRATION, current[33]);
    migrateTaskStatuses(db, () => bb.storage.migrate(db, previous));
    const repo = new Repository(db, () => {}), days = new DayPlanning(repo);
    const task = repo.kernel.createTask({ title: "Preserve accepted work" });
    if (waiting) db.prepare("UPDATE tasks SET status='waiting' WHERE id=?").run(task.id);
    else db.prepare("UPDATE task_projections SET customer='Acme' WHERE task_id=?").run(task.id);
    const item = days.add({ taskId: task.id, date: "2026-10-02", plannedMinutes: 45, reportedMinutes: 0, requestId: randomUUID() });
    db.exec("CREATE TABLE child_guard (task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE)");
    db.prepare("INSERT INTO child_guard VALUES (?)").run(task.id);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_bb_migrations'").all() as { name: string }[]).map(r => r.name);
    const snapshot = () => tables.map(name => (db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as Record<string, unknown>[])
      .map(row => { const copy = { ...row }; if (waiting && name === "task_projections") delete copy.customer; return copy; }));
    const before = snapshot(), ledger = db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all();
    const upgrade = () => migrateTaskStatuses(db, () => bb.storage.migrate(db, compatibleMigrations(db, current)));
    upgrade(); upgrade();
    expect(snapshot()).toEqual(before);
    expect(days.get(item.id)).toEqual(item);
    expect(db.prepare("SELECT * FROM _bb_migrations WHERE id<36 ORDER BY id").all()).toEqual(ledger);
    expect(db.prepare("SELECT customer FROM task_projections WHERE task_id=?").get(task.id)).toEqual({ customer: waiting ? null : "Acme" });
    expect(() => db.prepare("UPDATE tasks SET status='waiting' WHERE id=?").run(task.id)).not.toThrow();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    migrateTaskStatuses(db, () => bb.storage.migrate(db, compatibleMigrations(db, [...current, "CREATE TABLE next_shared_migration (id TEXT)"])));
    expect(db.prepare("SELECT count(*) AS n FROM next_shared_migration").get()).toEqual({ n: 0 });
  } finally { await harness.lifecycle.dispose(); }
});

it("rejects an unknown migration at the customer/waiting collision", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "migration-test" });
  const db = bb.storage.database();
  try {
    bb.storage.migrate(db, [...current.slice(0, 35), "CREATE TABLE unrelated_at_35 (id TEXT)"]);
    const before = db.prepare("SELECT * FROM _bb_migrations").all();
    expect(() => migrateTaskStatuses(db, () => bb.storage.migrate(db, compatibleMigrations(db, current)))).toThrow(/does not match/);
    expect(db.prepare("SELECT * FROM _bb_migrations").all()).toEqual(before);
  } finally { await harness.lifecycle.dispose(); }
});
