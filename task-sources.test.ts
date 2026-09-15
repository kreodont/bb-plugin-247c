import { expect, it } from "vitest";
import { factSchema, proposalViewSchema, syncCandidateSchema, type Dossier, type SyncCandidate } from "./contracts.js";
import { sourceUrl, taskSourceLinks } from "./task-sources.js";

const timestamp = "2026-09-12T03:00:00.000Z";
const gmail = "https://mail.google.com/mail/u/0/#all/report-1";
const slack = "https://example.slack.com/archives/C123/p1234567890000000";
const jira = "https://example.atlassian.net/browse/APP-745";
function dossier(): Pick<Dossier, "task" | "facts" | "proposals"> {
  return { task: { id: "task-1", title: "Review the sync report", status: "open", revision: 1, createdAt: timestamp, updatedAt: timestamp }, facts: [], proposals: [] };
}
function candidate(overrides: Partial<SyncCandidate> = {}): SyncCandidate {
  return syncCandidateSchema.parse({ id: "candidate-1", runId: "run-1", taskId: null, resultTaskId: "task-1", baseRevision: null,
    status: "applied", createdAt: timestamp, resolvedAt: timestamp, proposalId: "proposal-1", before: null,
    title: "Review the sync report", rationale: "A report needs attention.", confidence: 1,
    facts: [gmail, slack, jira].map((url, index) => ({ kind: "description", text: `Report detail ${index}`,
      citations: [{ callRef: `call-${index}`, source: ["gmail", "slack", "jira"][index], url, messageId: `message-${index}`, occurredAt: timestamp, quote: "The report needs attention." }] })),
    changes: { summary: { value: "A report needs attention.", evidenceRefs: ["fact:0"] } }, ...overrides });
}

it("deduplicates accepted citations and keeps original task sources before older update messages", () => {
  const origin = candidate();
  origin.facts[0].citations.push({ ...origin.facts[0].citations[0] });
  const update = candidate({ id: "later", taskId: "task-1", resolvedAt: "2026-09-13T00:00:00Z" });
  update.facts = [{ ...update.facts[0], citations: [{ ...update.facts[0].citations[0], url: "https://example.com/older-message", occurredAt: "2025-01-01T00:00:00Z" }] }];
  const links = taskSourceLinks(dossier(), [update, origin]);
  expect(links.map(link => link.url)).toEqual([gmail, slack, jira, "https://example.com/older-message"]);
  expect(links.filter(link => link.origin)).toHaveLength(3);
  expect(links.map(link => link.label)).toEqual(["Gmail message", "Slack message", "Jira · APP-745", "example.com"]);
});

it("includes only accepted records and evidence supporting accepted fields in a partial review", () => {
  const selected = candidate({ recordFactIndexes: [1] });
  expect(taskSourceLinks(dossier(), [selected]).map(link => link.url)).toEqual([gmail, slack]);
  selected.changes = {};
  expect(taskSourceLinks(dossier(), [selected]).map(link => link.url)).toEqual([slack]);
  selected.recordFactIndexes = [];
  expect(taskSourceLinks(dossier(), [selected])).toEqual([]);
});

it("ignores pending, rejected, superseded and other-task source candidates", () => {
  const ignored = [candidate({ status: "pending" }), candidate({ status: "rejected" }), candidate({ status: "superseded" }), candidate({ resultTaskId: "task-2" })];
  expect(taskSourceLinks(dossier(), ignored)).toEqual([]);
});

it("uses legacy accepted sourceRefs without extracting arbitrary links from record text", () => {
  const d = dossier();
  d.facts.push(factSchema.parse({ id: "fact-1", taskId: d.task.id, kind: "description", text: "Related artifact: https://example.com/output", source: "imported", sourceRef: gmail, occurredAt: timestamp, createdAt: timestamp }));
  const before = structuredClone(d);
  expect(taskSourceLinks(d, [])).toEqual([{ url: gmail, label: "Gmail message", occurredAt: timestamp, origin: false }]);
  expect(d).toEqual(before);
});

it("uses evidence actually cited by applied fields even when no record was accepted", () => {
  const d = dossier();
  const evidence = [gmail, slack].map((sourceRef, index) => ({ ref: `fact:${index}`, kind: "description", text: "Report needs review.", source: "external", sourceRef }));
  const applied = proposalViewSchema.parse({ id: "proposal-1", taskId: d.task.id, baseRevision: 0, model: "test", status: "applied", createdAt: timestamp, resolvedAt: timestamp, idempotencyKey: null, rationale: "Update the summary.", confidence: 1,
    changes: { summary: { value: "Review needed.", evidenceRefs: ["fact:1"] } }, evidence,
    receipt: { id: "receipt-1", beforeRevision: 0, afterRevision: 1, createdAt: timestamp } });
  d.proposals = [applied, { ...applied, id: "pending", status: "pending", changes: { summary: { value: "Not accepted.", evidenceRefs: ["fact:0"] } }, receipt: null }];
  expect(taskSourceLinks(d, []).map(link => link.url)).toEqual([slack]);
});

it("does not emit executable, credential-bearing, malformed or oversized source URLs", () => {
  const values = ["javascript:alert(1)", "data:text/html,hello", "file:///tmp/report", "bb-thread:thread_1#message_1", "/relative", "https://user:password@example.com/", "https://example.com/\nreport", `https://example.com/${"a".repeat(4096)}`, "not a URL"];
  for (const value of values) {
    expect(sourceUrl(value)).toBeNull();
    const c = candidate(); c.facts[0].citations[0].url = value; c.facts = [c.facts[0]];
    expect(taskSourceLinks(dossier(), [c])).toEqual([]);
  }
  expect(sourceUrl("http://example.com/report")?.href).toBe("http://example.com/report");
});

const legacyHeader = "Источник: Legacy (Windows). Импорт по запросу пользователя.\nИсходный ID: 00000000-0000-4000-8000-000000000001\n";
function importedFact(d: ReturnType<typeof dossier>, text: string) {
  return factSchema.parse({ id: "import-1", taskId: d.task.id, kind: "description", text,
    source: "human:bb", sourceRef: null, occurredAt: timestamp, createdAt: timestamp });
}

it("shows explicit ClickUp sources from Legacy imports, including workspace URLs, without changing records", () => {
  const d = dossier();
  const primary = "https://workspace.clickup.com/t/123456/ticket1";
  const related = "https://app.clickup.com/t/ticket2";
  d.facts.push(importedFact(d, legacyHeader + "\nСсылка ClickUp (clickup_url)\n" + primary
    + "\n\nСсылки (links)\n" + JSON.stringify(["Primary: " + primary, "Related: " + related], null, 2)
    + "\n\nЗаметки (notes)\nUnrelated prose: https://app.clickup.com/t/other-ticket"));
  const before = structuredClone(d);
  expect(taskSourceLinks(d, [])).toEqual([
    { url: primary, label: "ClickUp · ticket1", occurredAt: timestamp, origin: true },
    { url: related, label: "ClickUp · ticket2", occurredAt: timestamp, origin: true },
  ]);
  expect(d).toEqual(before);
});

it("recovers a title-matching ClickUp ticket from imported notes and strips sentence punctuation", () => {
  const d = dossier();
  d.task.title = "Resolve the original ticket (original1)";
  d.facts.push(importedFact(d, legacyHeader + "\nСсылка ClickUp (clickup_url)\nhttps://app.clickup.com/t/internal1"
    + "\n\nЗаметки (notes)\nOriginal: https://app.clickup.com/t/original1.\nRelated: https://app.clickup.com/t/unrelated1"));
  expect(taskSourceLinks(d, []).map(link => link.url)).toEqual([
    "https://app.clickup.com/t/internal1", "https://app.clickup.com/t/original1",
  ]);
});

it("does not infer ClickUp sources from ordinary text, incomplete migration markers or malformed fields", () => {
  for (const text of [
    "Ссылка ClickUp (clickup_url)\nhttps://app.clickup.com/t/ticket1",
    "Источник: Legacy (Windows). Импорт по запросу пользователя.\nСсылка ClickUp (clickup_url)\nhttps://app.clickup.com/t/ticket1",
    legacyHeader + "\nСсылки (links)\n[\ninvalid https://app.clickup.com/t/ticket1\n]",
    legacyHeader + "\nСсылка ClickUp (clickup_url)\nhttps://app.clickup.com.evil.test/t/ticket1",
    legacyHeader + "\nСсылка ClickUp (clickup_url)\nhttps://user:password@app.clickup.com/t/ticket1",
  ]) {
    const d = dossier();
    d.facts.push(importedFact(d, text));
    expect(taskSourceLinks(d, [])).toEqual([]);
  }
});
