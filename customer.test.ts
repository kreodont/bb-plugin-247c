import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { fixture } from "./test-support.js";
import { CORE_SCHEMA } from "./core/schema.js";
import { EXTRA_SCHEMA, Repository } from "./repository.js";
import { SourceSyncStore, readSourceCalls } from "./source-sync.js";
import { connectorCall, sourceData, startSourceSync, submitSourceData } from "./source-sync-test-support.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() { const f = await fixture(); hosts.push(f); return f; }

it("creates, saves, clears and reloads customers with idempotency and stale-write protection", async () => {
  const f = await setup();
  const task = f.repo.create({ title: "Invoice issue", description: "", customer: " Acme ", requestId: randomUUID() });
  expect(f.repo.detail(task.id).projection.customer).toBe("Acme");
  const input = { taskId: task.id, revision: task.revision, customer: "Beta", requestId: randomUUID() };
  const saved = await f.harness.behavior.callRpc("setCustomer", input);
  expect(await f.harness.behavior.callRpc("setCustomer", input)).toEqual(saved);
  expect(f.repo.list().tasks[0].customer).toBe("Beta");
  await expect(f.harness.behavior.callRpc("setCustomer", { ...input, requestId: randomUUID(), customer: "Stale" })).rejects.toThrow(/changed/);
  await f.reload();
  expect(await f.harness.behavior.callRpc("customers", {})).toEqual(["Beta"]);
  f.repo.setCustomer({ ...input, revision: f.repo.detail(task.id).task.revision, customer: null, requestId: randomUUID() });
  expect(f.repo.detail(task.id).projection.customer).toBeNull();
  expect(f.repo.detail(task.id).facts.at(-1)).toMatchObject({ source: "human:bb-customer", kind: "user_instruction" });
  expect(f.repo.customers()).toEqual([]);
});

it("reviews customer changes with other fields and reverts only accepted customer changes", async () => {
  const f = await setup(), task = await f.create("The source explicitly names Acme as the customer.");
  const ref = f.repo.detail(task.id).facts[0].id;
  const proposal = f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: {
    rationale: "Copy the explicit customer", confidence: 1,
    changes: { customer: { value: "Acme", evidenceRefs: [ref] }, summary: { value: "Invoice issue", evidenceRefs: [ref] } },
  } }, "test");
  expect(f.repo.detail(task.id).projection.customer).toBeNull();
  const result = f.repo.reviewParts({ kind: "proposal", id: proposal.id, revision: task.revision, parts: ["field:customer"], decision: "accept", requestId: randomUUID() });
  expect(f.repo.detail(task.id).projection).toMatchObject({ customer: "Acme", summary: null });
  expect(f.repo.kernel.getProposal(result.remainingId!).changes.customer).toBeUndefined();
  const accepted = f.repo.partReview("proposal", proposal.id)!.acceptedId!;
  const undo = f.repo.kernel.proposeRevert(accepted);
  expect(undo.changes.customer?.value).toBeNull();
  f.repo.accept(undo.id, f.repo.detail(task.id).task.revision);
  expect(f.repo.detail(task.id).projection.customer).toBeNull();
});

it("carries source customer proposals into a new task only after review", async () => {
  const f = await setup(), { run } = await startSourceSync(f), { input } = await sourceData(f, run);
  const quote = "Customer: Acme";
  connectorCall(f, run.threadId!, "mcp__claude_ai_Gmail__get_thread", { threadId: "thread-gmail-2", messageFormat: "PLAIN_TEXT" }, { messages: [{ id: "msg-2", text: quote }] });
  const read = (await readSourceCalls(f.bb, run.threadId!)).at(-1)!;
  input.suggestions[0].facts.push({ kind: "description", text: quote, citations: [{ callRef: read.ref, source: "gmail", url: "https://mail.google.com/mail/u/0/#all/thread-gmail-2", messageId: "msg-2", occurredAt: new Date(Date.parse(run.until) - 3600000).toISOString(), quote }] });
  input.suggestions[0].changes.customer = { value: "Acme", evidenceRefs: ["fact:2"] };
  await submitSourceData(f, run, input);
  const store = new SourceSyncStore(f.repo), candidate = store.candidates()[0];
  expect(candidate.changes.customer?.value).toBe("Acme");
  expect(f.repo.list().tasks).toHaveLength(0);
  store.accept(candidate.id);
  expect(f.repo.list().tasks[0].customer).toBe("Acme");
});

it("adds an empty customer without rewriting old tasks or recorded migrations", () => {
  const db = new Database(":memory:");
  try {
    db.exec(CORE_SCHEMA);
    for (const migration of EXTRA_SCHEMA.slice(0, -1)) db.exec(migration);
    const repo = new Repository(db, () => {}), task = repo.create({ title: "Existing", description: "Keep this", requestId: randomUUID() });
    const before = repo.detail(task.id);
    db.exec(EXTRA_SCHEMA.at(-1)!);
    expect(repo.detail(task.id)).toEqual(before);
    expect(repo.list().tasks[0].customer).toBeNull();
  } finally { db.close(); }
});
