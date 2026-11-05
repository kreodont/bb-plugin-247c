import { afterEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { fixture } from "./test-support.js";
import type { KnowledgeImport } from "./contracts.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() { const f = await fixture(); hosts.push(f); return f; }
function input(body = "Правило ExampleERP: проверять статус перед изменением."): KnowledgeImport {
  return { requestId: randomUUID(), source: { label: "ExampleCo", hostId: "host_test", rootPath: "/Knowledge Base" }, documents: [
    { relativePath: "reference/example.md", title: "ExampleERP", body, tags: ["ExampleCo", "reference"], modifiedAt: "2026-09-10T08:00:00.000Z" },
  ] };
}

it("imports the exact document snapshot, preserves its source, and survives reload without creating a task", async () => {
  const f = await setup();
  const body = "---\r\nname: ExampleERP\r\n---\r\n# ExampleERP\r\n" + "Полезный справочник 🗂️.\r\n".repeat(400) + "Редкое слово в конце документа.";
  const request = input(body);
  expect(await f.harness.behavior.callRpc("importKnowledge", request)).toEqual({ imported: 1, updated: 0, unchanged: 0, documents: 1 });
  const page = f.repo.knowledge("РЕДКОЕ слово");
  expect(page.total).toBe(1);
  expect(page.entries[0]).toMatchObject({ kind: "file", body, source: { path: "/Knowledge Base/reference/example.md", sha256: createHash("sha256").update(body).digest("hex"), hostId: "host_test" } });
  expect(page.entries[0]).not.toHaveProperty("taskId");
  expect(page.entries[0]).not.toHaveProperty("proposalId");
  expect(f.repo.list(true).total).toBe(0);
  expect(f.repo.active()).toHaveLength(0);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  await f.reload();
  expect(f.repo.knowledge().entries).toEqual(page.entries);
  expect(f.repo.knowledge("reference/example.md").total).toBe(1);
});

it("deduplicates repeated copies by source path and updates only the changed imported document", async () => {
  const f = await setup(); const task = await f.create(); const before = await f.detail(task.id);
  const request = input();
  await f.harness.behavior.callRpc("importKnowledge", request);
  const original = f.repo.knowledge().entries[0];
  expect(await f.harness.behavior.callRpc("importKnowledge", request)).toEqual({ imported: 1, updated: 0, unchanged: 0, documents: 1 });
  expect(await f.harness.behavior.callRpc("importKnowledge", { ...request, requestId: randomUUID() })).toEqual({ imported: 0, updated: 0, unchanged: 1, documents: 1 });
  const changed = { ...request, requestId: randomUUID(), documents: [{ ...request.documents[0], body: "Обновлённый справочник ExampleERP." }] };
  expect(await f.harness.behavior.callRpc("importKnowledge", changed)).toEqual({ imported: 0, updated: 1, unchanged: 0, documents: 1 });
  expect(f.repo.knowledge().total).toBe(1);
  expect(f.repo.knowledge().entries[0]).toMatchObject({ id: original.id, createdAt: original.createdAt, body: changed.documents[0].body });
  expect(await f.detail(task.id)).toEqual(before);
  await expect(f.harness.behavior.callRpc("importKnowledge", { ...changed, requestId: request.requestId })).rejects.toThrow(/already been used/);
});

it("rolls back the complete batch on a storage failure and can retry the same request", async () => {
  const f = await setup(); const request = input();
  request.documents.push({ ...request.documents[0], relativePath: "reference/fail.md" });
  f.repo.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON knowledge_files WHEN NEW.relative_path='reference/fail.md' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  await expect(f.harness.behavior.callRpc("importKnowledge", request)).rejects.toThrow("test failure");
  expect(f.repo.knowledge().total).toBe(0);
  f.repo.db.exec("DROP TRIGGER fail_import");
  expect(await f.harness.behavior.callRpc("importKnowledge", request)).toMatchObject({ imported: 2 });
  expect(f.repo.knowledge().total).toBe(2);
});

it.each(["../escape.md", "/absolute.md", "folder/../escape.md", "folder\\escape.md", "file.txt"])("rejects invalid source file %s before writing", async (relativePath) => {
  const f = await setup(); const request = input(); request.documents[0].relativePath = relativePath;
  await expect(f.harness.behavior.callRpc("importKnowledge", request)).rejects.toThrow();
  expect(f.repo.knowledge().total).toBe(0);
});

it("rejects duplicate paths and oversized documents without partial imports", async () => {
  const f = await setup(); const request = input(); request.documents.push({ ...request.documents[0] });
  await expect(f.harness.behavior.callRpc("importKnowledge", request)).rejects.toThrow();
  await expect(f.harness.behavior.callRpc("importKnowledge", input("я".repeat(70000)))).rejects.toThrow();
  expect(f.repo.knowledge().total).toBe(0);
});

it("pages long documents within the agent response budget without skipping text or records", async () => {
  const f = await setup(); const request = input();
  request.documents = Array.from({ length: 12 }, (_, i) => ({ ...request.documents[0], relativePath: `reference/doc-${i}.md`, title: `Document ${i}`, body: "a".repeat(100000) + " full tail" }));
  await f.harness.behavior.callRpc("importKnowledge", request);
  const ids: string[] = [];
  let offset = 0;
  let pages = 0;
  while (true) {
    const page = f.repo.knowledge("tail", offset);
    pages++;
    expect(Buffer.byteLength(JSON.stringify(page, null, 2))).toBeLessThan(768 * 1024);
    expect(page.total).toBe(12);
    expect(page.entries.length).toBeGreaterThan(0);
    for (const entry of page.entries) { ids.push(entry.id); expect(entry.body.endsWith("full tail")).toBe(true); }
    if (page.nextOffset === null) break;
    expect(page.nextOffset).toBe(offset + page.entries.length);
    offset = page.nextOffset;
  }
  expect(pages).toBeGreaterThan(1);
  expect(new Set(ids).size).toBe(12);
  expect(ids).toHaveLength(12);
  const result = await f.harness.behavior.runCli(["knowledge", "tail", "--offset", "5", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout!)).toEqual(f.repo.knowledge("tail", 5));
});

it("keeps literal wildcard searches literal", async () => {
  const f = await setup(); await f.harness.behavior.callRpc("importKnowledge", input("Скидка 100%_SKU"));
  expect(f.repo.knowledge("100%_SKU").total).toBe(1);
  expect(f.repo.knowledge("%missing").total).toBe(0);
});

it("combines imported files with conversation knowledge while retaining the proposal approval boundary", async () => {
  const f = await setup(); const task = await f.create();
  await f.harness.behavior.callRpc("start", { ...f.startInput(task.id, task.revision), criteria: [] });
  const session = f.repo.sessions(task.id)[0];
  const fact = "В ExampleERP booked означает проведённый счёт.";
  f.message(session.workerThreadId!, "user", fact);
  await f.idle(session.workerThreadId!, "Принял уточнение.");
  await f.harness.behavior.callRpc("pauseSession", { sessionId: session.id });
  const ref = f.repo.transcript(session.id)!.messages.find((message) => message.text === fact)!.ref;
  await f.idle(f.repo.session(session.id).reviewerThreadId!, { rationale: "Сохраним термин.", facts: [{ kind: "description", text: fact, citations: [{ messageRef: ref, quote: fact }] }], changes: null, knowledge: [{ title: "Значение booked", body: fact, tags: ["ExampleERP"], evidenceRefs: ["fact:0"] }] });
  const pending = f.repo.session(session.id);
  await f.harness.behavior.callRpc("importKnowledge", input());
  expect(f.repo.knowledge().entries.map((entry) => entry.kind)).toEqual(["file"]);
  expect(f.repo.kernel.getTask(task.id).revision).toBe(task.revision);
  expect(f.repo.kernel.getProposal(pending.proposalId!).status).toBe("pending");
  await f.harness.behavior.callRpc("accept", { proposalId: pending.proposalId, revision: task.revision });
  const combined = f.repo.knowledge("ExampleERP");
  expect(combined.total).toBe(2);
  expect(combined.entries.find((entry) => entry.kind === "conversation")).toMatchObject({ taskId: task.id, threadId: session.workerThreadId, proposalId: pending.proposalId, body: fact });
  expect(combined.entries.find((entry) => entry.kind === "file")).toMatchObject({ source: { relativePath: "reference/example.md" } });
});
