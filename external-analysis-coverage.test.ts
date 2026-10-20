import { expect, it } from "vitest";
import { selectedEvents, validateAnalysisCoverage } from "./external-analysis-coverage.js";
import { scriptAnalysisResultSchema } from "./contracts.js";

const events = [{ eventId: "event", callRef: "read", messageId: "message" }];
const citedResult = (callRef = "read", messageId = "message") => scriptAnalysisResultSchema.parse({
  suggestions: [{ taskId: null, title: "Prepare recommendation", rationale: "An explicit request.", confidence: 1,
    changes: { nextStep: { value: "Prepare a recommendation.", evidenceRefs: ["fact:0"] } },
    facts: [{ kind: "explicit_next_step", text: "Prepare a recommendation.", citations: [
      { callRef, messageId, source: "teams", url: "https://example.com/message", occurredAt: "2026-10-20T08:00:00Z", quote: "Please prepare a recommendation." },
    ] }],
  }], skipped: [],
});

it("counts a citation only when both source identities match", () => {
  expect(() => validateAnalysisCoverage(events, citedResult())).not.toThrow();
  expect(() => validateAnalysisCoverage(events, citedResult("other-read"))).toThrow(/Omitted selected event IDs: event/);
  expect(() => validateAnalysisCoverage(events, citedResult("read", "other-message"))).toThrow(/Omitted selected event IDs: event/);
});

it("requires every selected record even when one read contains several messages", () => {
  const ledger = [...events, { eventId: "second", callRef: "read", messageId: "second-message" }];
  expect(() => validateAnalysisCoverage(ledger, citedResult())).toThrow(/Omitted selected event IDs: second/);
  const result = citedResult();
  result.skipped.push({ eventId: "second", reason: "A greeting only." });
  expect(() => validateAnalysisCoverage(ledger, result)).not.toThrow();
});

it("builds a compact selected ledger, excluding history and preserving legacy collector support", () => {
  const doc = { eventId: "event", callRef: "read", id: "message", newOrChanged: true, response: { body: "Private content" } };
  expect(selectedEvents(JSON.stringify({ sourceDocuments: [doc, doc, { ...doc, eventId: "history", newOrChanged: false }] }))).toEqual(events);
  expect(selectedEvents('{"sourceDocuments":[{"id":"legacy"}]}')).toEqual([]);
  expect(() => validateAnalysisCoverage([], { suggestions: [], skipped: [] })).not.toThrow();
  expect(() => selectedEvents(JSON.stringify({ sourceDocuments: [doc, { ...doc, id: "different" }] }))).toThrow(/multiple source records/);
  expect(() => selectedEvents('{"sourceDocuments":[{"eventId":"event","newOrChanged":true}]}')).toThrow(/missing its callRef or id/);
});

it("bounds feedback for many omitted events without discarding the validation failure", () => {
  const ledger = Array.from({ length: 100 }, (_, i) => ({ eventId: `event-${i}`, callRef: "read", messageId: `message-${i}` }));
  expect(() => validateAnalysisCoverage(ledger, { suggestions: [], skipped: [] })).toThrow(/event-19 \(100 total\)/);
});
