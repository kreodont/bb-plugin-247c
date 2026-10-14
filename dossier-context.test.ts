import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Dossier } from "./contracts.js";
import { workingDossier, CONTEXT_COMPACTION_THRESHOLD_BYTES } from "./dossier-context.js";
import { dossierReadSchema, DOSSIER_PAGE_BYTES, readDossierPage } from "./dossier-read.js";
import { fixture } from "./test-support.js";

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
async function setup() {
  const f = await fixture(); hosts.push(f);
  const task = await f.create("Long-running task");
  const dossier = f.repo.detail(task.id);
  for (let i = 0; i < 100; i++) dossier.facts.push({
    ...dossier.facts[0], id: randomUUID(), kind: "progress", text: `Result ${i}: ` + "Historical detail. ".repeat(90),
    createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(), occurredAt: "2025-12-01T00:00:00.000Z",
  });
  return { f, task, dossier };
}
function readAll(dossier: Dossier, input: Omit<Parameters<typeof readDossierPage>[1], "taskId">) {
  let cursor: string | undefined, content = "", pages = 0;
  do {
    const raw = readDossierPage(dossier, { taskId: dossier.task.id, ...(cursor ? { cursor } : input) });
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(DOSSIER_PAGE_BYTES);
    const page = JSON.parse(raw); pages++;
    if (page.format === "json") return { data: page.data, pages };
    content += page.content;
    cursor = page.nextCursor ?? undefined;
    expect(pages).toBeLessThan(200);
  } while (cursor);
  return { data: JSON.parse(content), pages };
}

it("compacts large dossiers without changing current truth or losing protected evidence", async () => {
  const { dossier } = await setup();
  const protectedKinds = ["user_instruction", "constraint", "decision", "description", "open_question", "blocker", "artifact"] as const;
  const protectedFacts = protectedKinds.map(kind => ({ ...dossier.facts[0], id: randomUUID(), kind, text: `Original ${kind}`, createdAt: "2020-01-01T00:00:00.000Z" }));
  dossier.facts.push(...protectedFacts);
  const oldStep = { ...dossier.facts[0], id: randomUUID(), kind: "explicit_next_step" as const, text: "Obsolete step" };
  dossier.facts.push(oldStep);
  dossier.projection.summary = "Accepted current summary";
  dossier.projection.nextStep = null;
  dossier.projection.blockers = ["Still blocked"];
  dossier.projection.openQuestions = ["Still unanswered"];
  const before = structuredClone(dossier);
  const context = workingDossier(dossier);
  expect(context.compaction.applied).toBe(true);
  expect(context.compaction.deferredFacts).toBeGreaterThan(80);
  expect(context.compaction.fullAcceptedBytes).toBeGreaterThan(CONTEXT_COMPACTION_THRESHOLD_BYTES);
  expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(context.compaction.fullAcceptedBytes / 3);
  expect(context.projection).toEqual(dossier.projection);
  expect(context.sourceLinks).toEqual(dossier.sourceLinks);
  for (const fact of protectedFacts) expect(context.facts).toContainEqual(fact);
  expect(context.facts).not.toContainEqual(oldStep);
  expect(dossier).toEqual(before);
  expect(readAll(dossier, { section: "accepted" }).data.facts).toEqual(before.facts);
  // A current step is protected even if its exact supporting record is old.
  dossier.projection.nextStep = oldStep.text;
  expect(workingDossier(dossier).facts).toContainEqual(oldStep);
});

it("keeps newly accepted corrections even when they describe an old event", async () => {
  const { dossier } = await setup();
  const correction = { ...dossier.facts[0], id: randomUUID(), kind: "progress" as const,
    text: "The old result was incorrect", occurredAt: "2019-01-01T00:00:00.000Z", createdAt: "2026-10-14T10:00:00.000Z" };
  dossier.facts.unshift(correction);
  expect(workingDossier(dossier).facts).toContainEqual(correction);
  dossier.task.revision++;
  dossier.projection.summary = "Corrected accepted summary";
  const current = readAll(dossier, {}).data;
  expect(current.task.revision).toBe(dossier.task.revision);
  expect(current.projection.summary).toBe("Corrected accepted summary");
});

it("retrieves deferred multilingual evidence with provenance and combines filters", async () => {
  const { dossier } = await setup();
  const old = dossier.facts[1]; old.text = "Старый endpoint был заменён; проверили повторно.";
  old.sourceRef = "https://example.com/issues/PROJ-41";
  expect(workingDossier(dossier).facts).not.toContainEqual(old);
  expect(readAll(dossier, { section: "facts", query: "ENDPOINT СТАРЫЙ", kinds: ["progress"] }).data.facts).toEqual([old]);
  expect(readAll(dossier, { section: "facts", query: "proj-41" }).data.facts).toEqual([old]);
  const byId = readAll(dossier, { section: "facts", factIds: [old.id, "missing-id"] }).data;
  expect(byId.facts).toEqual([old]); expect(byId.missingFactIds).toEqual(["missing-id"]);
  expect(readAll(dossier, { section: "facts", query: "no match here" }).data.matchedFacts).toBe(0);
  expect(readAll(dossier, { section: "facts", factIds: [old.id], kinds: ["constraint"] }).data.facts).toEqual([]);
  expect(readAll(dossier, { section: "facts" }).data.facts).toEqual(dossier.facts);
});

it("preserves search filters across pages and rejects mismatched or stale searches", async () => {
  const { dossier } = await setup();
  const old = dossier.facts[1]; old.text = "Oversized historical evidence 😀 ".repeat(10_000);
  const input = { taskId: dossier.task.id, section: "facts" as const, query: "historical oversized", factIds: [old.id] };
  const first = JSON.parse(readDossierPage(dossier, input));
  expect(first.nextCursor).toBeTruthy();
  expect(readAll(dossier, input).data.facts).toEqual([old]);
  expect(() => readDossierPage(dossier, { taskId: dossier.task.id, cursor: first.nextCursor, query: "different" })).toThrow(/different fact filters/);
  expect(() => readDossierPage(dossier, { taskId: dossier.task.id, query: "ignored" })).toThrow(/require section=facts/);
  old.text += " Changed";
  expect(() => readDossierPage(dossier, { taskId: dossier.task.id, cursor: first.nextCursor })).toThrow(/changed while reading/);
  expect(dossierReadSchema.safeParse({ ...input, kinds: ["unknown"] }).success).toBe(false);
  // Every schema-valid filter must fit a schema-valid continuation cursor,
  // including maximum-length escaped strings, not just UUIDs and plain words.
  const query = "\u0001".repeat(300);
  old.text = query + old.text;
  const escapedFilters = { ...input, query, factIds: [old.id, ...Array.from({ length: 19 }, (_, i) => `${i}` + "\u0001".repeat(118))] };
  expect(dossierReadSchema.safeParse(escapedFilters).success).toBe(true);
  const escaped = JSON.parse(readDossierPage(dossier, escapedFilters));
  expect(dossierReadSchema.safeParse({ taskId: dossier.task.id, cursor: escaped.nextCursor }).success).toBe(true);
  expect(readAll(dossier, escapedFilters).data.facts).toEqual([old]);
});

it("pages oversized protected records instead of cutting them to meet the context target", async () => {
  const { dossier } = await setup();
  const constraint = { ...dossier.facts[0], id: randomUUID(), kind: "constraint" as const, text: "Never lose this condition 😀\n".repeat(5000) };
  dossier.facts.push(constraint);
  const result = readAll(dossier, {});
  expect(result.pages).toBeGreaterThan(1);
  expect(result.data.compaction.applied).toBe(true);
  expect(result.data.facts).toContainEqual(constraint);
  expect(result.data.facts.filter((fact: Dossier["facts"][number]) => fact.kind === "progress")).toHaveLength(3);
});

it("applies task ownership to searches and retains all evidence in small default reads", async () => {
  const { f, task } = await setup(), other = await f.create("Unrelated task");
  const session = await f.start(task.id, task.revision);
  const context = { threadId: session.workerThreadId!, projectId: "proj_personal" };
  const small = JSON.parse(String(await f.harness.behavior.callAgentTool("c247_read", { taskId: task.id }, context)));
  expect(small.data.compaction.applied).toBe(false);
  expect(small.data.facts).toEqual(f.repo.detail(task.id).facts);
  await expect(f.harness.behavior.callAgentTool("c247_read", { taskId: other.id, section: "facts", query: "private" }, context)).rejects.toThrow(/only its own task dossier/);
});
