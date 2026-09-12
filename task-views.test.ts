import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { CORE_SCHEMA } from "./core/schema.js";
import { EXTRA_SCHEMA, Repository } from "./repository.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() { const f = await fixture(); hosts.push(f); return f; }

it("tracks new tasks and accepted updates without treating agent reads or pending proposals as visits", async () => {
  const f = await setup(), task = await f.create("Context"), state = () => f.repo.list().tasks[0].unseen;
  expect(state()).toBe("new");
  await f.detail(task.id);
  await f.harness.behavior.callAgentTool("c247_read", { taskId: task.id }, { threadId: "reader", projectId: "proj_personal" });
  expect(state()).toBe("new");
  f.repo.markSeen(task.id, task.revision);
  const proposal = f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: {
    rationale: "Update summary", confidence: 1, changes: { summary: { value: "Reviewed", evidenceRefs: [f.repo.detail(task.id).facts[0].id] } },
  } }, "test");
  expect(state()).toBeNull();
  f.repo.accept(proposal.id, task.revision);
  expect(state()).toBe("updated");
  await f.reload(); expect(state()).toBe("updated");
  const revision = f.repo.kernel.getTask(task.id).revision;
  f.repo.markSeen(task.id, revision);
  expect(state()).toBeNull();
  expect(f.repo.kernel.getTask(task.id).revision).toBe(revision);
});

it("acknowledges only rendered revisions and never regresses a later visit", async () => {
  const f = await setup(), task = await f.create("Context");
  f.repo.note({ taskId: task.id, revision: task.revision, kind: "progress", text: "Update", requestId: randomUUID() });
  const latest = f.repo.kernel.getTask(task.id).revision;
  f.repo.markSeen(task.id, task.revision);
  expect(f.repo.list().tasks[0].unseen).toBe("updated");
  f.repo.markSeen(task.id, latest); f.repo.markSeen(task.id, task.revision);
  expect(f.repo.list().tasks[0].unseen).toBeNull();
  expect(() => f.repo.markSeen(task.id, latest + 1)).toThrow(/Invalid/);
});

it("baselines existing tasks at migration without changing their durable records", () => {
  const db = new Database(":memory:");
  try {
    const viewMigration = EXTRA_SCHEMA.findIndex(sql => sql.startsWith("CREATE TABLE task_views"));
    db.exec(CORE_SCHEMA); for (const migration of EXTRA_SCHEMA.slice(0, viewMigration)) db.exec(migration);
    const repo = new Repository(db, () => {}), task = repo.create({ title: "Existing task", description: "Original", requestId: randomUUID() });
    const before = repo.kernel.getDossier(task.id);
    for (const migration of EXTRA_SCHEMA.slice(viewMigration)) db.exec(migration);
    expect(repo.list().tasks[0].unseen).toBeNull(); expect(repo.kernel.getDossier(task.id)).toEqual(before);
    const fresh = repo.create({ title: "New task", description: "", requestId: randomUUID() });
    expect(repo.list().tasks.find(t => t.id === fresh.id)?.unseen).toBe("new");
  } finally { db.close(); }
});
