import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { fixture } from "./test-support.js";
import { DOSSIER_PAGE_BYTES, readDossierPage } from "./dossier-read.js";
import type { Dossier } from "./contracts.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() { const f = await fixture(); hosts.push(f); const task = await f.create("Accepted context"); return { f, task }; }
function allPages(dossier: Dossier, section: "accepted" | "syncUpdates" | "proposals" = "accepted") {
  let cursor: string | undefined, content = "", pages = 0;
  do {
    const raw = readDossierPage(dossier, { taskId: dossier.task.id, ...(cursor ? { cursor } : { section }) });
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(DOSSIER_PAGE_BYTES);
    const page = JSON.parse(raw); pages++;
    if (page.format === "json") return { data: page.data, pages };
    expect(page.offset).toBe(content.length);
    expect(page.content.length).toBeGreaterThan(0);
    expect(page.content.isWellFormed()).toBe(true);
    content += page.content;
    cursor = page.nextCursor ?? undefined;
    expect(pages).toBeLessThan(1000);
  } while (cursor);
  return { data: JSON.parse(content), pages };
}

it("keeps the accepted read small even when review history exceeds the old limit", async () => {
  const { f, task } = await setup();
  const fact = f.repo.detail(task.id).facts[0];
  // Independent proposals do not change the accepted revision or projection.
  for (let i = 0; i < 45; i++) f.repo.propose({ taskId: task.id, revision: task.revision, requestId: randomUUID(), draft: {
    rationale: "Review context ".repeat(800), confidence: 1,
    changes: { summary: { value: `Unaccepted ${i} ` + "draft ".repeat(1500), evidenceRefs: [fact.id] } },
  } }, "test");
  const dossier = f.repo.detail(task.id);
  expect(Buffer.byteLength(JSON.stringify(dossier, null, 2))).toBeGreaterThan(768 * 1024);
  const raw = await f.harness.behavior.callAgentTool("c247_read", { taskId: task.id }, { threadId: "reader", projectId: "proj_personal" });
  const page = JSON.parse(String(raw));
  expect(page).toMatchObject({ section: "context", format: "json", nextCursor: null, data: { task: { id: task.id }, projection: { summary: null } } });
  expect(page.data.facts).toEqual(dossier.facts);
  expect(page.data.proposals).toBeUndefined();
  expect(String(raw)).not.toContain("Unaccepted");
  expect(f.repo.list().tasks[0].unseen).toBe("new");
  expect(allPages(dossier, "proposals").data).toEqual(dossier.proposals);
});

it("pages a formerly single-response dossier below the provider spill threshold", async () => {
  const { f, task } = await setup(), dossier = f.repo.detail(task.id);
  dossier.facts[0].text = "Existing invoice work; do not treat it as a new request. ".repeat(700);
  const first = readDossierPage(dossier, { taskId: task.id, section: "accepted" });
  expect(DOSSIER_PAGE_BYTES).toBeLessThanOrEqual(12 * 1024);
  expect(Buffer.byteLength(first)).toBeLessThanOrEqual(12 * 1024);
  expect(JSON.parse(first).nextCursor).toBeTruthy();
  const read = allPages(dossier);
  expect(read.pages).toBeGreaterThan(1);
  expect(read.data.facts).toEqual(dossier.facts);
});

it("rejects corrupt and over-expanded compressed cursors", async () => {
  const { f, task } = await setup(), dossier = f.repo.detail(task.id);
  for (const cursor of ["z.invalid", `z.${deflateRawSync("x".repeat(100_000)).toString("base64url")}`]) {
    expect(() => readDossierPage(dossier, { taskId: task.id, cursor })).toThrow(/Invalid dossier cursor/);
  }
});

it("reads every accepted fact losslessly, including a single oversized Unicode record", async () => {
  const { f, task } = await setup();
  const dossier = f.repo.detail(task.id);
  dossier.facts[0].text = 'Проверено 😀 "quotes" \\ backslash\n\t'.repeat(24_000);
  const result = allPages(dossier);
  expect(result.pages).toBeGreaterThan(1);
  expect(result.data.facts).toEqual(dossier.facts);
  expect(result.data.projection).toEqual(dossier.projection);
});

it("pages oversized history records without treating them as accepted evidence", async () => {
  const { f, task } = await setup(), dossier = f.repo.detail(task.id);
  dossier.syncUpdates = [{ id: "draft", status: "pending", rationale: "Unaccepted 😀\n".repeat(80_000) }] as Dossier["syncUpdates"];
  expect(JSON.parse(readDossierPage(dossier, { taskId: task.id })).data).not.toHaveProperty("syncUpdates");
  expect(allPages(dossier, "syncUpdates").data).toEqual(dossier.syncUpdates);
});

it("rejects stale or cross-task cursors and ignores unrelated history changes", async () => {
  const { f, task } = await setup(), dossier = f.repo.detail(task.id);
  dossier.facts[0].text = "Accepted text ".repeat(12_000);
  const first = JSON.parse(readDossierPage(dossier, { taskId: task.id }));
  expect(first.nextCursor).toBeTruthy();
  const next = { taskId: task.id, cursor: first.nextCursor };
  dossier.events.push({ id: "history-only", kind: "proposal.created", createdAt: new Date().toISOString(), detail: "{}" });
  expect(() => readDossierPage(dossier, next)).not.toThrow();
  expect(() => readDossierPage(dossier, { ...next, section: "events" })).toThrow(/different task or section/);
  const other = { ...dossier, task: { ...dossier.task, id: "other-task" } };
  expect(() => readDossierPage(other, { ...next, taskId: "other-task" })).toThrow(/different task or section/);
  expect(() => readDossierPage(dossier, { taskId: task.id, cursor: "invalid" })).toThrow(/Invalid dossier cursor/);
  const position = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString()); position.offset = first.totalCharacters + 1;
  expect(() => readDossierPage(dossier, { ...next, cursor: Buffer.from(JSON.stringify(position)).toString("base64url") })).toThrow(/page position/);
  dossier.facts[0].text += "Updated";
  expect(() => readDossierPage(dossier, next)).toThrow(/section changed while reading/);
  expect(allPages(dossier).data.facts).toEqual(dossier.facts);
});

it("enforces worker ownership on every page and supports paging across plugin reload", async () => {
  const { f, task } = await setup(), other = await f.create("Other task");
  f.repo.kernel.appendFact({ taskId: task.id, kind: "constraint", text: "Keep all constraints. ".repeat(5000) });
  const session = await f.start(task.id, f.repo.kernel.getTask(task.id).revision);
  const context = { threadId: session.workerThreadId!, projectId: "proj_personal" };
  const first = JSON.parse(String(await f.harness.behavior.callAgentTool("c247_read", { taskId: task.id }, context)));
  expect(first.nextCursor).toBeTruthy();
  await f.reload();
  const next = JSON.parse(String(await f.harness.behavior.callAgentTool("c247_read", { taskId: task.id, cursor: first.nextCursor }, context)));
  expect(next.offset).toBe(first.content.length);
  await expect(f.harness.behavior.callAgentTool("c247_read", { taskId: other.id, cursor: first.nextCursor }, context)).rejects.toThrow(/only its own task dossier/);
});
