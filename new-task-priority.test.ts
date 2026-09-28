import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { sourceData, startSourceSync, submitSourceData } from "./source-sync-test-support.js";
import { SourceSyncStore } from "./source-sync.js";
import { rpcContract } from "./contracts.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup(existing = false) {
  const f = await fixture(); hosts.push(f);
  const task = existing ? await f.create() : null;
  const { run } = await startSourceSync(f);
  const { input } = await sourceData(f, run, task?.id);
  // The user's selection must override a conflicting model suggestion.
  input.suggestions[0].facts.push({ kind: "decision", text: "Mark as urgent and important", citations: input.suggestions[0].facts[0].citations });
  input.suggestions[0].changes.urgent = { value: true, evidenceRefs: ["fact:2"] };
  input.suggestions[0].changes.important = { value: true, evidenceRefs: ["fact:2"] };
  await submitSourceData(f, run, input);
  const store = new SourceSyncStore(f.repo);
  return { f, store, candidate: store.candidates()[0] };
}

it.each([[true, true], [true, false], [false, true], [false, false]])("creates a task with human priority %s/%s and preserves receipt idempotency", async (urgent, important) => {
  const { f, candidate } = await setup();
  const input = { candidateId: candidate.id, initialPriority: { urgent, important } };
  const first = rpcContract.syncAccept.output.parse(await f.harness.behavior.callRpc("syncAccept", input));
  expect(first.planning).toMatchObject({ urgent, important });
  expect(first.events.filter(e => e.kind === "planning.changed")).toHaveLength(urgent && important ? 1 : 2);
  const retry = await f.harness.behavior.callRpc("syncAccept", input);
  expect(retry).toEqual(first); expect(f.repo.list().total).toBe(1);
  // Retrying acceptance must not overwrite a later manual priority edit.
  f.repo.classify({ taskId: first.task.id, revision: first.planning.revision, urgent: !urgent, important: !important });
  const later = rpcContract.syncAccept.output.parse(await f.harness.behavior.callRpc("syncAccept", input));
  expect(later.planning).toMatchObject({ urgent: !urgent, important: !important });
});

it("applies initial priority for partial bulk acceptance and rebases the remainder", async () => {
  const { f, candidate, store } = await setup();
  const result = rpcContract.acceptInbox.output.parse(await f.harness.behavior.callRpc("acceptInbox", { items: [{
    kind: "source", id: candidate.id, revision: null, parts: ["field:summary"], initialPriority: { urgent: false, important: true },
  }] }));
  expect(result.failed).toEqual([]);
  const task = f.repo.detail(result.applied[0].taskId);
  expect(task.planning).toMatchObject({ urgent: false, important: true });
  expect(task.projection.nextStep).toBeNull();
  expect(store.candidates().find(c => c.status === "pending")).toMatchObject({ taskId: task.task.id, baseRevision: task.task.revision });
});

it("rolls back task creation and acceptance if priority cannot be saved", async () => {
  const { f, candidate, store } = await setup();
  vi.spyOn(f.repo, "classify").mockImplementation(() => { throw new Error("Priority write failed"); });
  expect(() => store.accept(candidate.id, { urgent: false, important: false })).toThrow("Priority write failed");
  expect(f.repo.list().total).toBe(0); expect(store.candidate(candidate.id).status).toBe("pending");
});

it("rejects initial priority on existing tasks and on rejections", async () => {
  const { f, candidate } = await setup(true);
  const priority = { urgent: false, important: false };
  const before = f.repo.detail(candidate.taskId!);
  await expect(f.harness.behavior.callRpc("syncAccept", { candidateId: candidate.id, initialPriority: priority })).rejects.toThrow("only available for new tasks");
  await expect(f.harness.behavior.callRpc("reviewParts", { kind: "source", id: candidate.id, revision: candidate.baseRevision, decision: "reject", parts: ["field:summary"], requestId: randomUUID(), initialPriority: priority })).rejects.toThrow();
  expect(f.repo.detail(candidate.taskId!)).toEqual(before);
});
