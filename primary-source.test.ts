import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { taskSchema } from "./contracts.js";
import { SourceSyncStore } from "./source-sync.js";
import { sourceData, startSourceSync, submitSourceData } from "./source-sync-test-support.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() { const f = await fixture(); hosts.push(f); return f; }
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
const original = "https://example.slack.com/archives/C123/p1234567890000000";
const later = "https://example.atlassian.net/browse/APP-42";

it("records an explicit creation source once, with or without a description, and restores it after reload", async () => {
  const f = await setup();
  for (const description of ["Review the source request", ""]) {
    const input = { title: "Review a request", description, primarySourceUrl: original, requestId: randomUUID() };
    const task = taskSchema.parse(await f.harness.behavior.callRpc("create", input));
    expect(await f.harness.behavior.callRpc("create", input)).toEqual(task);
    const detail = await f.detail(task.id);
    expect(detail.primarySource?.url).toBe(original);
    expect(detail.sourceRevision).toBe(1);
    expect(detail.facts).toHaveLength(1);
    expect(detail.facts[0].sourceRef).toBe(original);
    expect(detail.facts[0].text).toBe(description || `Task source: ${original}`);
    await f.reload();
    expect(await f.detail(task.id)).toEqual(detail);
  }
  for (const primarySourceUrl of ["javascript:alert(1)", "file:///tmp/source", "https://user:password@example.com"]) {
    await expect(f.harness.behavior.callRpc("create", { title: "Invalid", primarySourceUrl, requestId: randomUUID() })).rejects.toThrow();
  }
  expect(f.repo.list().total).toBe(2);
});

it("uses accepted legacy sources without writes and preserves canonical state when choosing another source", async () => {
  const f = await setup(), task = await f.create();
  for (const sourceRef of [original, later]) f.repo.kernel.appendFact({ taskId: task.id, kind: "description", text: "Accepted context", source: "imported", sourceRef });
  const before = f.repo.kernel.getDossier(task.id);
  expect((await f.detail(task.id)).primarySource?.url).toBe(original);
  expect(f.repo.db.prepare("SELECT count(*) AS n FROM task_source_preferences").get()).toEqual({ n: 0 });
  const input = { taskId: task.id, url: later, revision: 0, requestId: randomUUID() };
  const choice = await f.harness.behavior.callRpc("setPrimarySource", input);
  expect(choice).toMatchObject({ primarySource: { url: later }, sourceRevision: 1 });
  expect(await f.harness.behavior.callRpc("setPrimarySource", input)).toEqual(choice);
  expect(f.repo.kernel.getDossier(task.id)).toEqual(before);
  await f.reload();
  expect((await f.detail(task.id)).primarySource?.url).toBe(later);
  await expect(f.harness.behavior.callRpc("setPrimarySource", { ...input, url: original, requestId: randomUUID() })).rejects.toThrow(/another window/);
  await expect(f.harness.behavior.callRpc("setPrimarySource", { ...input, url: "https://example.com/not-accepted", revision: 1, requestId: randomUUID() })).rejects.toThrow(/already accepted/);
  expect((await f.detail(task.id)).primarySource?.url).toBe(later);
});

it("exposes the same source for worker and reviewer threads, including finished sessions, with no read side effects", async () => {
  const f = await setup();
  const task = f.repo.create({ title: "Source shortcut", description: "", primarySourceUrl: original, requestId: randomUUID() });
  const session = await f.start(task.id, task.revision);
  f.repo.saveSession({ ...session, reviewerThreadId: "review-thread", status: "applied" });
  const before = await f.detail(task.id), calls = f.harness.inspection.sdk.calls.length;
  for (const threadId of [session.workerThreadId!, "review-thread"]) {
    expect(await f.harness.behavior.callRpc("threadSource", { threadId })).toMatchObject({ source: { url: original } });
  }
  expect(await f.harness.behavior.callRpc("threadSource", { threadId: "unlinked" })).toEqual({ source: null });
  expect(await f.detail(task.id)).toEqual(before);
  expect(f.harness.inspection.sdk.calls).toHaveLength(calls);
});

it("pins a new task's accepted origin and keeps pending later sources out of the shortcut", async () => {
  const f = await setup(), { run } = await startSourceSync(f), { input } = await sourceData(f, run);
  await submitSourceData(f, run, input);
  expect(f.repo.db.prepare("SELECT count(*) AS n FROM task_source_preferences").get()).toEqual({ n: 0 });
  const store = new SourceSyncStore(f.repo), detail = store.accept(store.candidates()[0].id);
  expect(detail.primarySource).toEqual(detail.sourceLinks[0]);
  expect(detail.primarySource?.origin).toBe(true);
  expect(detail.sourceRevision).toBe(1);
  const { run: update } = await startSourceSync(f), { input: updateInput } = await sourceData(f, update, detail.task.id);
  await submitSourceData(f, update, updateInput);
  expect((await f.detail(detail.task.id)).primarySource).toEqual(detail.primarySource);
  // Later accepted context does not replace the original selection.
  f.repo.kernel.appendFact({ taskId: detail.task.id, kind: "description", text: "A later source", source: "imported", sourceRef: later });
  expect((await f.detail(detail.task.id)).primarySource).toEqual(detail.primarySource);
  await f.reload();
  expect((await f.detail(detail.task.id)).primarySource).toEqual(detail.primarySource);
});
