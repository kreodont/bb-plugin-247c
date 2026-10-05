// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SourceCoverageCard } from "./source-coverage-ui.js";
import { sourceCoverageSchema, type SourceCoverage } from "./updater-health-contracts.js";

afterEach(cleanup);
const coverage: SourceCoverage = { source: "teams", status: "partial", collectedAt: "2026-09-28T10:00:00Z",
  since: "2026-09-01T00:00:00Z", fullyCheckedThrough: null, savedRecords: 2, gaps: [],
  limitations: ["One inaccessible chat is excluded.", "Older history is unavailable."],
  chatScan: { checked: 12, available: 12, excluded: 1, pendingMessages: 0 } };

it("separates a finished available-chat scan from access and history limits", () => {
  const view = render(<SourceCoverageCard coverage={sourceCoverageSchema.parse(coverage)} name="Teams" date={value => value} />);
  expect(view.getByText("Available chats checked").className).not.toContain("text-destructive");
  expect(view.container.textContent).toContain("Available chats checked: 12 of 12 · Excluded chats: 1 · Messages queued: 0");
  expect(view.getByText("Access and history limits · 2")).toBeTruthy();
  expect(view.container.textContent).toContain("Full coverage remains unconfirmed");
  expect(view.queryByText("Collection incomplete")).toBeNull();
  expect(view.queryByText("Collection complete")).toBeNull();
});

it.each([
  { gaps: ["Request timed out"] },
  { chatScan: { ...coverage.chatScan!, pendingMessages: 3 } },
  { chatScan: { ...coverage.chatScan!, checked: 11 } },
  { chatScan: { checked: 0, available: 0, excluded: 13, pendingMessages: 0 } },
  { chatScan: undefined },
])("retains the incomplete warning for errors, queues, unvisited chats and legacy snapshots: %j", change => {
  const view = render(<SourceCoverageCard coverage={{ ...coverage, ...change }} name="Teams" date={value => value} />);
  expect(view.getByText("Collection incomplete").className).toContain("text-destructive");
  expect(view.queryByText("Available chats checked")).toBeNull();
});

it("never hides an unavailable source and rejects impossible scan counts", () => {
  const view = render(<SourceCoverageCard coverage={{ ...coverage, status: "unavailable" }} name="Teams" date={value => value} />);
  expect(view.getByText("Source unavailable")).toBeTruthy();
  expect(sourceCoverageSchema.safeParse({ ...coverage, chatScan: { ...coverage.chatScan, checked: 13 } }).success).toBe(false);
});
