import { expect, it } from "vitest";
import { literalChunks, prepareReferences, resolveReferences } from "./external-analysis-references.js";
import { analysisSources, validateAnalysisQuotes } from "./external-analysis-quotes.js";
import { selectedEvents, validateAnalysisCoverage } from "./external-analysis-coverage.js";

const doc = { eventId: "a".repeat(64), newOrChanged: true, callRef: "long-read-id", id: "source/message/+==",
  source: "clickup", url: "https://example.com/note", eventAt: "2026-11-02T10:00:00Z",
  response: { content: "**Speaker**: Okay. Okay. Please review the invoice.", amount: 42, owners: ["A", "B"], nested: { flag: true } } };
const selection = (ref: string) => ({ suggestions: [{ taskId: null, title: "Review invoice", rationale: "Explicit request.", confidence: 1,
  facts: [{ kind: "explicit_next_step", text: "Review the invoice.", citations: [{ ref }] }],
  changes: { nextStep: { value: "Review the invoice.", evidenceRefs: ["fact:0"] } } }], skipped: [] });
it("resolves short references to exact source identities, metadata and repeated speech", () => {
  const context = JSON.stringify({ sourceDocuments: [doc] });
  const prepared = prepareReferences(context);
  const result = resolveReferences(prepared.catalog, selection("r1.p1"));
  expect(result.suggestions[0].facts[0].citations[0]).toMatchObject({ callRef: doc.callRef, messageId: doc.id,
    occurredAt: doc.eventAt, url: doc.url, source: doc.source });
  expect(result.suggestions[0].facts[0].citations[0].quote).toContain("Okay. Okay.");
  expect(() => validateAnalysisQuotes(analysisSources(context), result)).not.toThrow();
  expect(() => validateAnalysisCoverage(selectedEvents(context), result)).not.toThrow();
  const view = JSON.parse(prepared.context).sourceDocuments[0];
  expect(view).toHaveProperty("recordRef", "r1");
  expect(view).not.toHaveProperty("eventId");
  expect(view).not.toHaveProperty("callRef");
  expect(view).not.toHaveProperty("citation");
  expect(prepareReferences(context)).toEqual(prepared);
  for (const passage of prepared.catalog.records[0].passages)
    expect(() => validateAnalysisQuotes(analysisSources(context), resolveReferences(prepared.catalog, selection(passage.ref)))).not.toThrow();
});
it("rejects invented references and never accepts model-supplied quotes or IDs", () => {
  const { catalog } = prepareReferences(JSON.stringify({ sourceDocuments: [doc] }));
  expect(() => resolveReferences(catalog, selection("r2.p1"))).toThrow(/Unknown passage/);
  const altered = selection("r1.p1") as any;
  altered.suggestions[0].facts[0].citations[0].quote = "Invented quote";
  expect(() => resolveReferences(catalog, altered)).toThrow();
  expect(() => resolveReferences(catalog, { suggestions: [], skipped: [{ record: doc.eventId, reason: "Skip" }] })).toThrow(/not a selected/);
});
it("maps skips exactly, preserving coverage checks and separating background records", () => {
  const context = JSON.stringify({ sourceDocuments: [doc, { ...doc, id: "history", eventId: "history", newOrChanged: false }] });
  const { catalog } = prepareReferences(context);
  const result = resolveReferences(catalog, { suggestions: [], skipped: [{ record: "r1", reason: "Notification only." }] });
  expect(result.skipped[0].eventId).toBe(doc.eventId);
  expect(() => resolveReferences(catalog, { suggestions: [], skipped: [{ record: "r2", reason: "Skip history" }] })).toThrow();
  expect(() => validateAnalysisCoverage(selectedEvents(context), resolveReferences(catalog, { suggestions: [], skipped: [] }))).toThrow(/Omitted/);
  expect(() => validateAnalysisCoverage(selectedEvents(context), { ...result, skipped: [...result.skipped, ...result.skipped] })).toThrow(/Duplicate/);
});
it("preserves Unicode and continuous source boundaries in long passages", () => {
  const text = ("**Speaker**: Okay. Okay. Привет 😀\r\n".repeat(200));
  const chunks = literalChunks(text);
  expect(chunks.join("")).toBe(text);
  expect(chunks.every(c => c.length <= 1800)).toBe(true);
  const context = JSON.stringify({ sourceDocuments: [{ ...doc, response: { content: text } }] });
  const { catalog } = prepareReferences(context);
  for (const passage of catalog.records[0].passages) {
    expect(text).toContain(passage.citation.quote);
    expect(() => validateAnalysisQuotes(analysisSources(context), resolveReferences(catalog, selection(passage.ref)))).not.toThrow();
  }
});
it("pages oversized sources without dropping records, task context or exact citations", () => {
  const tasks = [{ id: "accepted-task", history: "Previously rejected request. ".repeat(20) }];
  const context = JSON.stringify({ currentTasks: tasks, sourceDocuments: [doc,
    { ...doc, id: "long-note", eventId: "b".repeat(64), response: { content: 'Speaker: "Okay." 😀\n'.repeat(1000) } }] });
  const complete = prepareReferences(context);
  const paged = prepareReferences(context, 3000);
  const view = JSON.parse(paged.context);
  expect(JSON.stringify(paged.context).length).toBeLessThanOrEqual(3000);
  expect(view.currentTasks).toEqual(tasks);
  expect(view.sourceDocuments).toHaveLength(2);
  expect(view.sourceDocuments[0].passagesDeferred).toBe(false);
  expect(view.sourceDocuments[1]).toMatchObject({ recordRef: "r2", passagesDeferred: true, passages: [], passageCount: expect.any(Number) });
  expect(paged.catalog).toEqual(complete.catalog);
  const last = paged.catalog.records[1].passages.at(-1)!;
  expect(() => validateAnalysisQuotes(analysisSources(context), resolveReferences(paged.catalog, selection(last.ref)))).not.toThrow();
});

it("retains closed tasks and pending decisions exactly when their rows must be paged", () => {
  const original = { sourceDocuments: [doc], currentTasks: [{ id: "closed", title: "Prior request", status: "done", revision: 8,
    facts: [{ kind: "decision", text: 'Keep closed. "No follow-up." 😀\n'.repeat(1000) }] }],
    pendingProposals: [{ id: "pending", taskId: "closed", rationale: "Awaiting review. ".repeat(1000) }] };
  const prepared = prepareReferences(JSON.stringify(original), 2500), view = JSON.parse(prepared.context);
  expect(JSON.stringify(prepared.context).length).toBeLessThanOrEqual(2500);
  expect(view.currentTasks[0]).toMatchObject({ id: "closed", title: "Prior request", status: "done", revision: 8, contextDeferred: true });
  expect(prepared.catalog.contextEntries).toHaveLength(2);
  for (const entry of prepared.catalog.contextEntries) view[entry.section][entry.index] = JSON.parse(entry.content);
  expect(view.currentTasks).toEqual(original.currentTasks);
  expect(view.pendingProposals).toEqual(original.pendingProposals);
});
