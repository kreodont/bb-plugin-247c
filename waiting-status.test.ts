import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createFakePluginHost, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { fixture } from "./test-support.js";
import { CORE_SCHEMA } from "./core/schema.js";
import { EXTRA_SCHEMA, Repository } from "./repository.js";
import { compatibleMigrations } from "./migration-compatibility.js";
import { migrateTaskStatuses } from "./task-status-migration.js";
import { DayPlanning } from "./day-planning.js";
import { sessionSchema } from "./contracts.js";
import { SourceSyncStore, requiredSourceReads } from "./source-sync.js";
import { sourceData, startSourceSync, submitSourceData } from "./source-sync-test-support.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); vi.useRealTimers(); });
async function setup() { const f = await fixture({ settings: { workProvider: "claude-work", workModel: "claude-opus-5[1m]" } }); hosts.push(f); return f; }

it("upgrades a populated database without changing tasks, receipts, day time or foreign keys", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "waiting-migration" });
  const db = bb.storage.database(); db.pragma("foreign_keys = ON");
  try {
    bb.storage.migrate(db, [CORE_SCHEMA, ...EXTRA_SCHEMA.slice(0, 35)]);
    const repo = new Repository(db, () => {}), days = new DayPlanning(repo);
    const task = repo.create({ title: "Await approval", description: "Keep this context", requestId: randomUUID() });
    const fact = repo.kernel.appendFact({ taskId: task.id, kind: "decision", text: "The task is complete." });
    const proposal = repo.kernel.createProposal({ taskId: task.id, baseRevision: repo.kernel.getTask(task.id).revision, model: "test", output: { rationale: "User decision", confidence: 1, changes: { status: { value: "done", evidenceRefs: [fact.id] } } } });
    repo.accept(proposal.id, proposal.baseRevision);
    days.add({ taskId: task.id, date: "2026-10-02", plannedMinutes: 40, reportedMinutes: 65, requestId: randomUUID() });
    db.exec("CREATE TABLE child_guard (task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE)");
    db.prepare("INSERT INTO child_guard VALUES (?)").run(task.id);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_bb_migrations'").all() as { name: string }[]).map(r => r.name);
    const saved = tables.map(table => db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all());
    const upgrade = () => migrateTaskStatuses(db, () => bb.storage.migrate(db, compatibleMigrations(db, [CORE_SCHEMA, ...EXTRA_SCHEMA])));
    upgrade(); upgrade();
    expect(tables.map(table => db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all())).toEqual(saved);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(repo.status(task.id, "waiting", repo.kernel.getTask(task.id).revision).status).toBe("waiting");
    expect(() => db.prepare("UPDATE tasks SET status='invalid' WHERE id=?").run(task.id)).toThrow(/CHECK/);
  } finally { await harness.lifecycle.dispose(); }
});

it("rolls the rebuild and migration ledger back if foreign-key validation fails", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "waiting-rollback" });
  const db = bb.storage.database();
  try {
    bb.storage.migrate(db, [CORE_SCHEMA, ...EXTRA_SCHEMA.slice(0, 35)]);
    db.pragma("foreign_keys = OFF");
    db.exec("CREATE TABLE dangling (task_id TEXT REFERENCES tasks(id)); INSERT INTO dangling VALUES ('missing');");
    db.pragma("foreign_keys = ON");
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='tasks'").get();
    const ledger = db.prepare("SELECT * FROM _bb_migrations").all();
    expect(() => migrateTaskStatuses(db, () => bb.storage.migrate(db, [CORE_SCHEMA, ...EXTRA_SCHEMA]))).toThrow(/CHECK/);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='tasks'").get()).toEqual(schema);
    expect(db.prepare("SELECT * FROM _bb_migrations").all()).toEqual(ledger);
    expect(db.prepare("SELECT * FROM dangling").all()).toEqual([{ task_id: "missing" }]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  } finally { await harness.lifecycle.dispose(); }
});

it("keeps waiting tasks, priority, chat dispatch and manual day time available across reload", async () => {
  const f = await setup(), task = await f.create();
  const priority = f.repo.classify({ taskId: task.id, revision: 0, urgent: true, important: true });
  const current = f.repo.kernel.getTask(task.id);
  const waiting = await f.harness.behavior.callRpc("status", { taskId: task.id, status: "waiting", revision: current.revision });
  expect(waiting).toMatchObject({ status: "waiting" });
  expect(f.repo.list().tasks).toMatchObject([{ id: task.id, status: "waiting", planning: priority }]);
  await expect(f.harness.behavior.callRpc("status", { taskId: task.id, status: "open", revision: current.revision })).rejects.toThrow(/changed/);
  const session = sessionSchema.parse(await f.harness.behavior.callRpc("openChat", { taskId: task.id, requestId: randomUUID() }));
  const row = new DayPlanning(f.repo).add({ taskId: task.id, date: "2026-10-02", reportedMinutes: 50, requestId: randomUUID() });
  expect(await f.harness.behavior.callRpc("day", { date: row.date })).toMatchObject({ items: [{ taskStatus: "waiting", reportedMinutes: 50 }] });
  const before = f.repo.kernel.getTask(task.id);
  await f.harness.behavior.callRpc("status", { taskId: task.id, status: "open", revision: before.revision });
  await f.harness.behavior.callRpc("status", { taskId: task.id, status: "waiting", revision: before.revision + 1 });
  expect(f.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
  await f.reload();
  expect(f.repo.session(session.id).status).toBe("working");
  expect(f.repo.list().total).toBe(1);
  const result = await f.harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread: f.threads.get(session.workerThreadId!)!, input: { text: "Read the reply", blocks: [{ type: "text", text: "Read the reply", mentions: [] }] } }));
  expect(result?.action).not.toBe("block");
  await expect(f.harness.behavior.callRpc("status", { taskId: task.id, status: "done", revision: f.repo.kernel.getTask(task.id).revision })).rejects.toThrow(/session/);
});

it("updates the existing waiting task when a reply arrives, only after proposal acceptance", async () => {
  const f = await setup();
  const task = f.repo.create({ title: "Report", description: "Await reply", primarySourceUrl: "https://mail.google.com/mail/u/0/#all/thread-gmail-1", requestId: randomUUID() });
  f.repo.status(task.id, "waiting", task.revision);
  const dossier = f.repo.kernel.getDossier(task.id);
  expect(requiredSourceReads([{ ...dossier, projection: { ...dossier.projection, summary: "https://mail.google.com/mail/u/0/#all/1a04026aa250ce0e" } }], "gmail")).toEqual(["1a04026aa250ce0e"]);
  const { run } = await startSourceSync(f), { input } = await sourceData(f, run, task.id);
  input.suggestions[0].changes.status = { value: "open", evidenceRefs: ["fact:0"] };
  await submitSourceData(f, run, input);
  expect(f.repo.kernel.getTask(task.id).status).toBe("waiting");
  const store = new SourceSyncStore(f.repo), candidate = store.candidates()[0];
  expect(candidate.taskId).toBe(task.id);
  await f.harness.behavior.callRpc("syncAccept", { candidateId: candidate.id });
  expect(f.repo.kernel.getTask(task.id).status).toBe("open");
  expect(f.repo.list(true).total).toBe(1);
});

it("requires conversation evidence for waiting and preserves explicit approval when reopening closed work", async () => {
  const { validateExtraction } = await import("./conversation.js");
  const quote = "I sent the request and am waiting for their reply.";
  const transcript = { threadId: "thread_test", capturedAt: new Date().toISOString(), warnings: [], messages: [{ ref: "m1", role: "assistant" as const, sequence: 1, text: quote }] };
  const draft = { rationale: "Awaiting confirmation", facts: [{ kind: "progress", text: quote, citations: [{ messageRef: "m1", quote }] }], changes: { status: { value: "waiting", evidenceRefs: ["fact:0"] } }, knowledge: [] };
  expect(validateExtraction(draft, transcript, undefined, "open").changes?.status?.value).toBe("waiting");
  expect(() => validateExtraction({ ...draft, facts: [] }, transcript, undefined, "open")).toThrow(/cite/);
  expect(() => validateExtraction(draft, transcript, undefined, "done")).toThrow(/user decision/);
  draft.changes.status.value = "open";
  expect(validateExtraction(draft, transcript, undefined, "waiting").changes?.status?.value).toBe("open");
  expect(() => validateExtraction(draft, transcript, undefined, "done")).toThrow(/user decision/);
});

it("derives waiting age from accepted transitions and preserves it through updates and reload", async () => {
  const f = await setup(), task = await f.create();
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = "2026-10-02T12:00:00.000Z";
  vi.setSystemTime(new Date(start));
  f.repo.status(task.id, "waiting", task.revision);
  vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  // The start must survive even when it is outside the visible history window.
  for (let i = 0; i < 105; i++) f.repo.kernel.appendFact({ taskId: task.id, kind: "progress", text: `Follow-up ${i}` });
  f.repo.status(task.id, "waiting", f.repo.kernel.getTask(task.id).revision);
  const fact = f.repo.detail(task.id).facts[0];
  const propose = (status: "waiting" | "open") => f.repo.kernel.createProposal({
    taskId: task.id, baseRevision: f.repo.kernel.getTask(task.id).revision, model: "test",
    output: { rationale: "Confirmed status", confidence: 1, changes: { status: { value: status, evidenceRefs: [fact.id] } } },
  });
  const unchanged = propose("waiting");
  f.repo.accept(unchanged.id, unchanged.baseRevision);
  const row = new DayPlanning(f.repo).add({ taskId: task.id, date: "2026-10-05", requestId: randomUUID() });
  await f.reload();
  expect(f.repo.list().tasks[0].waitingSince).toBe(start);
  expect((await f.detail(task.id)).task.waitingSince).toBe(start);
  expect(await f.harness.behavior.callRpc("day", { date: row.date })).toMatchObject({ items: [{ waitingSince: start }] });
  const resumed = propose("open"); f.repo.accept(resumed.id, resumed.baseRevision);
  expect(f.repo.kernel.getTask(task.id).waitingSince).toBeNull();
  const pending = propose("waiting");
  expect(f.repo.kernel.getTask(task.id).waitingSince).toBeNull();
  const restarted = "2026-10-07T12:00:00.000Z";
  vi.setSystemTime(new Date(restarted)); f.repo.accept(pending.id, pending.baseRevision);
  expect(f.repo.kernel.getTask(task.id).waitingSince).toBe(restarted);
  f.repo.status(task.id, "done", f.repo.kernel.getTask(task.id).revision);
  expect(f.repo.kernel.getTask(task.id).waitingSince).toBeNull();
});

it("leaves the age unknown when a waiting task has no status history", async () => {
  const f = await setup(), task = await f.create();
  f.repo.status(task.id, "waiting", task.revision);
  f.repo.db.prepare("DELETE FROM kernel_events WHERE task_id=? AND type='task.status-changed'").run(task.id);
  expect(f.repo.kernel.getTask(task.id).waitingSince).toBeNull();
});
