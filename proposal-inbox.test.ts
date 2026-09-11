import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import { sourceData, startSourceSync, submitSourceData } from "./source-sync-test-support.js";
import { rpcContract, type ReviewItem, type ReviewSelection } from "./contracts.js";
import { SourceSyncStore } from "./source-sync.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() { const f = await fixture(); hosts.push(f); return f; }
const selection = (item: ReviewItem): ReviewSelection => ({ kind: item.kind, id: item.kind === "source" ? item.candidate.id : item.proposal.id, revision: item.kind === "source" ? item.candidate.baseRevision : item.proposal.baseRevision });
async function inbox(f: Awaited<ReturnType<typeof fixture>>, offset = 0) { return rpcContract.proposalInbox.output.parse(await f.harness.behavior.callRpc("proposalInbox", { offset })); }
function propose(f: Awaited<ReturnType<typeof fixture>>, taskId: string) {
  const d = f.repo.kernel.getDossier(taskId);
  return f.repo.propose({ taskId, revision: d.task.revision, requestId: randomUUID(), draft: { rationale: "Уточнение по фактам", confidence: 1, changes: { summary: { value: d.facts[0].text, evidenceRefs: [d.facts[0].id] } } } }, "test");
}

it("lists all proposal types, including new tasks with no existing dossier, without applying anything", async () => {
  const f = await setup(); const task = await f.create(); propose(f, task.id);
  const { run } = await startSourceSync(f); const { input } = await sourceData(f, run);
  await submitSourceData(f, run, input);
  const before = f.repo.kernel.getDossier(task.id);
  const page = await inbox(f);
  expect(page.total).toBe(2); expect(page.items.map(i => i.kind).sort()).toEqual(["proposal", "source"]);
  expect(page.items.find(i => i.kind === "source")).toMatchObject({ candidate: { taskId: null }, currentTask: null, blockedReason: null });
  expect(f.repo.list().pendingTotal).toBe(2); expect(f.repo.list().tasks[0].pendingCount).toBe(1);
  expect(f.repo.list().total).toBe(1); expect(f.repo.kernel.getDossier(task.id)).toEqual(before);
});

it("accepts new tasks and dossier changes through their existing receipt paths and supports retries", async () => {
  const f = await setup(); const task = await f.create(); const proposal = propose(f, task.id);
  const { run } = await startSourceSync(f); const { input } = await sourceData(f, run); await submitSourceData(f, run, input);
  const items = (await inbox(f)).items.map(selection);
  const result = rpcContract.acceptInbox.output.parse(await f.harness.behavior.callRpc("acceptInbox", { items }));
  expect(result.failed).toEqual([]); expect(result.applied).toHaveLength(2);
  expect(f.repo.list().total).toBe(2); expect(f.repo.pendingTotal()).toBe(0);
  expect(f.repo.kernel.getProposal(proposal.id).status).toBe("applied");
  const receipt = f.repo.kernel.getApplicationReceipt(proposal.id);
  await f.harness.behavior.callRpc("acceptInbox", { items });
  expect(f.repo.list().total).toBe(2); expect(f.repo.kernel.getApplicationReceipt(proposal.id)).toEqual(receipt);
});

it("reports a stale proposal while accepting the other selected item without changing the stale task", async () => {
  const f = await setup(); const task = await f.create(); const proposal = propose(f, task.id);
  const { run } = await startSourceSync(f); const { input } = await sourceData(f, run); await submitSourceData(f, run, input);
  const items = (await inbox(f)).items.map(selection);
  f.repo.db.prepare("UPDATE tasks SET revision=revision+1 WHERE id=?").run(task.id);
  const before = f.repo.kernel.getDossier(task.id);
  const result = rpcContract.acceptInbox.output.parse(await f.harness.behavior.callRpc("acceptInbox", { items }));
  expect(result.applied).toHaveLength(1); expect(result.failed).toMatchObject([{ id: proposal.id }]);
  expect(f.repo.kernel.getDossier(task.id)).toEqual(before);
  expect((await inbox(f)).items[0].blockedReason).toContain("Досье изменилось");
});

it("rejects selecting multiple proposals for one task before applying any and preserves exact revision checks", async () => {
  const f = await setup(); const task = await f.create(); propose(f, task.id); propose(f, task.id);
  const page = await inbox(f);
  await expect(f.harness.behavior.callRpc("acceptInbox", { items: page.items.map(selection) })).rejects.toThrow(/несколько предложений/);
  expect(f.repo.pendingTotal()).toBe(2);
  const item = selection(page.items[0]); item.revision = 999;
  const result = rpcContract.acceptInbox.output.parse(await f.harness.behavior.callRpc("acceptInbox", { items: [item] }));
  expect(result.applied).toHaveLength(0); expect(result.failed[0].message).toContain("Предложение изменилось");
});

it("keeps file integrity checks on bulk acceptance of session results", async () => {
  const f = await setup(); const task = await f.create(); let session = await f.start(task.id, task.revision);
  f.files.set("/work/plan.md", "1. Alpha\n2. Beta\n3. Gamma");
  await f.idle(session.workerThreadId!, { summary: "План из трёх этапов", artifacts: [{ path: "plan.md", label: "План" }] });
  session = f.repo.session(session.id);
  await f.idle(session.reviewerThreadId!, f.pass(session));
  expect(f.repo.session(session.id).status).toBe("awaiting_approval");
  const items = (await inbox(f)).items.map(selection);
  f.files.set("/work/plan.md", "Changed after review");
  const result = rpcContract.acceptInbox.output.parse(await f.harness.behavior.callRpc("acceptInbox", { items }));
  expect(result.applied).toHaveLength(0); expect(result.failed).toHaveLength(1);
  expect(f.repo.kernel.getTask(task.id).revision).toBe(task.revision);
});

it("paginates the global list rather than hiding proposals beyond the first response", async () => {
  const f = await setup(); const task = await f.create();
  for (let i = 0; i < 52; i++) propose(f, task.id);
  const first = await inbox(f), second = await inbox(f, first.nextOffset!);
  expect(first.items).toHaveLength(50); expect(first.total).toBe(52); expect(first.nextOffset).toBe(50);
  expect(second.items).toHaveLength(2); expect(second.nextOffset).toBeNull();
  expect(new Set([...first.items, ...second.items].map(i => selection(i).id)).size).toBe(52);
});
