import { expect, it } from "vitest";
import { analysisSources, validateAnalysisQuotes } from "./external-analysis-quotes.js";
import { scriptAnalysisResultSchema } from "./contracts.js";

const result = (quote: string, messageId = "page") => scriptAnalysisResultSchema.parse({
  suggestions: [{ taskId: null, title: "Review invoice", rationale: "Meeting request.", confidence: 1,
    changes: { summary: { value: "Initial review requested.", evidenceRefs: ["fact:0"] } },
    facts: [{ kind: "decision", text: "Initial review requested.", citations: [
      { callRef: "read", messageId, source: "clickup", url: "https://example.com/page", occurredAt: "2026-10-21T07:00:00Z", quote },
    ] }],
  }], skipped: [],
});
const sources = (response: unknown) => [{ callRef: "read", id: "page", response }];

it("rejects cleaned-up speech and accepts the literal transcript", () => {
  const transcript = "**Speaker**: Yeah, maybe. Maybe someone can review it.";
  expect(() => validateAnalysisQuotes(sources({ content: transcript }), result("Yeah, maybe someone can review it."))).toThrow(/suggestion 0, fact 0, citation 0/);
  expect(() => validateAnalysisQuotes(sources({ content: transcript }), result("Yeah, maybe. Maybe someone can review it."))).not.toThrow();
});
it("does not join fields, remove intervening speakers, or borrow another page's quote", () => {
  const data = sources({ a: "First passage", b: "Second passage", content: "First\n**Other speaker**: interruption\nSecond" });
  expect(() => validateAnalysisQuotes(data, result("First passage\nSecond passage"))).toThrow(/Quote is absent/);
  expect(() => validateAnalysisQuotes(data, result("First\nSecond"))).toThrow(/Quote is absent/);
  expect(() => validateAnalysisQuotes([...data, { callRef: "read", id: "other", response: "Unrelated exact quote" }], result("Unrelated exact quote"))).toThrow(/Quote is absent/);
  expect(() => validateAnalysisQuotes(data, result("First passage", "unknown"))).toThrow(/Unknown source record/);
});
it("supports structured metadata and nested connector JSON without changing the result", () => {
  const data = sources({ content: [{ text: JSON.stringify({ body: "Exact source text", value: 8 }) }] });
  for (const quote of ["Exact source text", '"value":8']) {
    const output = result(quote), original = structuredClone(output);
    expect(() => validateAnalysisQuotes(data, output)).not.toThrow();
    expect(output).toEqual(original);
  }
});
it("retains background source records and skips only legacy datasets without response bodies", () => {
  expect(analysisSources(JSON.stringify({ sourceDocuments: [{ callRef: "read", id: "page", newOrChanged: false, response: "History" }] }))).toEqual(sources("History"));
  expect(analysisSources('{"sourceDocuments":[{"eventId":"legacy"}]}')).toEqual([]);
  expect(() => validateAnalysisQuotes([], result("Legacy quote"))).not.toThrow();
});
it("bounds errors without exposing source content in feedback", () => {
  const output = result("Wrong quote");
  output.suggestions = Array.from({ length: 20 }, () => output.suggestions[0]);
  expect(() => validateAnalysisQuotes(sources("Private content"), output)).toThrow(/20 errors total/);
  try { validateAnalysisQuotes(sources("Private content"), output); } catch (error) {
    expect(String(error)).not.toContain("Private content");
    expect(String(error).length).toBeLessThan(2000);
  }
});
