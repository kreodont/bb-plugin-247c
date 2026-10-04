import { migrateTaskStatuses } from "./task-status-migration.js";
import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { CORE_SCHEMA } from "./core/schema.js";
import { EXTRA_SCHEMA, Repository } from "./repository.js";
import { compatibleMigrations, RETIRED_TIME_MIGRATION } from "./migration-compatibility.js";
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
