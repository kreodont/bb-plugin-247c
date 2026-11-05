import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./test-support.js";
import { SourceThreadArchives } from "./source-thread-archives.js";
import { SourceSyncStore } from "./source-sync.js";
import { sourceData, startSourceSync, submitSourceData } from "./source-sync-test-support.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); vi.restoreAllMocks(); });
async function setup(status: "completed" | "partial" | "blocked" | "working" = "completed") {
  const f = await fixture(); hosts.push(f);
  const { run } = await startSourceSync(f), { input } = await sourceData(f, run);
  await submitSourceData(f, run, input);
  const store = new SourceSyncStore(f.repo);
  store.save({ ...store.run(run.id), status, finishedAt: new Date().toISOString() });
  const threadId = run.threadId!;
  f.threads.set(threadId, { ...f.threads.get(threadId)!, status: "idle" });
  return { f, store, run: store.run(run.id), threadId, archives: new SourceThreadArchives(f.bb, f.repo, () => []) };
}
it("archives a successful check on idle without changing pending proposals or check history", async () => {
  const s = await setup();
  const before = s.store.candidates(), run = s.store.run(s.run.id);
  await s.f.idle(s.threadId, "Check complete. Results saved.");
  expect(s.f.threads.get(s.threadId)?.archivedAt).toBeTruthy();
  expect(s.store.candidates()).toEqual(before);
  expect(s.store.run(s.run.id)).toEqual(run);
  expect(s.f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
});
it("cleans up completed checks after reload once and respects manual unarchiving", async () => {
  const s = await setup(); await s.f.reload();
  const restored = new SourceThreadArchives(s.f.bb, s.f.repo, () => []);
  await restored.tick();
  expect(s.f.threads.get(s.threadId)?.archivedAt).toBeTruthy();
  s.f.threads.set(s.threadId, { ...s.f.threads.get(s.threadId)!, archivedAt: null });
  await s.f.reload();
  await new SourceThreadArchives(s.f.bb, s.f.repo, () => []).tick();
  expect(s.f.threads.get(s.threadId)?.archivedAt).toBeNull();
});
it.each(["partial", "blocked", "working"] as const)("keeps %s checks visible", async status => {
  const s = await setup(status); await s.archives.tick();
  expect(s.f.threads.get(s.threadId)?.archivedAt).toBeNull();
});
it("waits for the final response, background agents, queued messages and approvals", async () => {
  const s = await setup();
  const set = (status: "active" | "idle", activeBackgroundAgentCount = 0) => s.f.threads.set(s.threadId, { ...s.f.threads.get(s.threadId)!, status, activeBackgroundAgentCount });
  set("active"); await s.archives.tick();
  expect(s.f.threads.get(s.threadId)?.archivedAt).toBeNull();
  set("idle", 1); await s.archives.tick();
  expect(s.f.threads.get(s.threadId)?.archivedAt).toBeNull();
  set("idle"); s.f.queued.set(s.threadId, [{ id: "queued" }] as never); await s.archives.tick();
  expect(s.f.threads.get(s.threadId)?.archivedAt).toBeNull();
  s.f.queued.clear(); s.f.harness.sdk.stub("threads.interactions.list", () => [{ id: "approval" }] as never); await s.archives.tick();
  expect(s.f.threads.get(s.threadId)?.archivedAt).toBeNull();
  s.f.harness.sdk.stub("threads.interactions.list", () => []); await s.archives.tick();
  expect(s.f.threads.get(s.threadId)?.archivedAt).toBeTruthy();
});
it("keeps chats with a follow-up after check completion, including after restart", async () => {
  const s = await setup();
  s.store.save({ ...s.run, finishedAt: new Date(Date.now() - 1000).toISOString() });
  s.f.message(s.threadId, "user", "Explain the second result.");
  await s.archives.tick(); await s.f.reload();
  await new SourceThreadArchives(s.f.bb, s.f.repo, () => []).tick();
  expect(s.f.threads.get(s.threadId)?.archivedAt).toBeNull();
});
it("does not archive on an obsolete idle event after a new turn starts", async () => {
  const s = await setup(); let reads = 0;
  s.f.harness.sdk.stub("threads.get", () => {
    const thread = s.f.threads.get(s.threadId)!;
    return { ...thread, status: ++reads === 1 ? "idle" : "active" };
  });
  await s.archives.tick(); expect(s.f.threads.get(s.threadId)?.archivedAt).toBeNull();
});
it("retries an archive failure after restart while leaving results intact", async () => {
  const s = await setup();
  s.f.harness.sdk.stub("threads.archive", () => { throw new Error("BB temporarily unavailable"); });
  await s.archives.tick(); expect(s.f.threads.get(s.threadId)?.archivedAt).toBeNull();
  expect(s.store.run(s.run.id).status).toBe("completed");
  await s.f.reload(); await new SourceThreadArchives(s.f.bb, s.f.repo, () => []).tick();
  expect(s.f.threads.get(s.threadId)?.archivedAt).toBeTruthy();
});
it("archives a confirmed imported batch even with partial collection coverage, including after reload", async () => {
  const s = await setup("partial");
  const external = await s.f.bb.sdk.threads.spawn({ projectId: "proj_personal", environment: { type: "reuse", environmentId: "env_test" }, title: "247C imported analysis", providerId: "codex", prompt: "Analyze the saved sources." });
  s.f.threads.set(external.id, { ...s.f.threads.get(external.id)!, status: "idle" });
  s.store.save({ ...s.run, finishedAt: new Date().toISOString() });
  const before = s.store.run(s.run.id), proposals = s.store.candidates();
  let imported: { threadId: string; runId: string }[] = [];
  const archives = new SourceThreadArchives(s.f.bb, s.f.repo, () => imported);
  await archives.tick(external.id); expect(s.f.threads.get(external.id)?.archivedAt).toBeNull();
  imported = [{ threadId: external.id, runId: s.run.id }];
  await s.f.reload();
  await new SourceThreadArchives(s.f.bb, s.f.repo, () => imported).tick(external.id);
  expect(s.f.threads.get(external.id)?.archivedAt).toBeTruthy();
  const restored = new SourceSyncStore(s.f.repo);
  expect(restored.run(s.run.id)).toEqual(before);
  expect(restored.candidates()).toEqual(proposals);
  expect(s.f.threads.get(s.threadId)?.archivedAt).toBeNull();
});
it.each(["blocked", "working"] as const)("keeps an external analysis visible when its linked run is %s", async status => {
  const s = await setup(status);
  const archives = new SourceThreadArchives(s.f.bb, s.f.repo, () => [{ threadId: s.threadId, runId: s.run.id }]);
  await archives.tick(); expect(s.f.threads.get(s.threadId)?.archivedAt).toBeNull();
});
it("rechecks import confirmation and preserves follow-ups on partial batches", async () => {
  const s = await setup("partial");
  const imported = [{ threadId: s.threadId, runId: s.run.id }];
  const archives = new SourceThreadArchives(s.f.bb, s.f.repo, () => imported);
  s.f.harness.sdk.stub("threads.get", ({ threadId }) => { imported.length = 0; return s.f.threads.get(threadId)!; });
  await archives.tick(); expect(s.f.threads.get(s.threadId)?.archivedAt).toBeNull();
  s.f.harness.sdk.stub("threads.get", ({ threadId }) => s.f.threads.get(threadId)!);
  imported.push({ threadId: s.threadId, runId: s.run.id });
  s.store.save({ ...s.run, finishedAt: new Date(Date.now() - 1000).toISOString() });
  s.f.message(s.threadId, "user", "Explain this result.");
  await archives.tick(); expect(s.f.threads.get(s.threadId)?.archivedAt).toBeNull();
});
it("does not archive twice when an idle event overtakes a cleanup batch", async () => {
  const s = await setup(), { run } = await startSourceSync(s.f);
  s.store.save({ ...run, status: "completed", finishedAt: new Date().toISOString() });
  s.f.threads.set(run.threadId!, { ...s.f.threads.get(run.threadId!)!, status: "idle" });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  s.f.harness.sdk.stub("threads.get", async ({ threadId }) => {
    if (threadId === run.threadId && first) { first = false; await held; }
    return s.f.threads.get(threadId)!;
  });
  const batch = s.archives.tick();
  await s.archives.tick(s.threadId);
  release(); await batch;
  expect(s.f.harness.inspection.sdk.callsTo("threads.archive").filter(([args]) => (args as { threadId: string }).threadId === s.threadId)).toHaveLength(1);
});
