// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SourceConnectionDiagnostics } from "./source-diagnostics-ui.js";

afterEach(cleanup);
it("shows setup failure and HTTP success separately, with readable retry evidence", () => {
  const view = render(<SourceConnectionDiagnostics date={v => v} attempts={[
    { source: "jira", attempt: 1, startedAt: "2026-10-20T12:00:00Z", elapsedMs: 20000, stage: "initialization", outcome: "failed", failure: "rate_limit", status: 429, rateLimited: true, retryable: true,
      http: [{ stage: "initialization", elapsedMs: 15, status: 429, retryAfterSeconds: 30, rateLimitReason: "jira-quota-tenant-based" }] },
    { source: "jira", attempt: 2, startedAt: "2026-10-20T12:00:25Z", elapsedMs: 20000, stage: "tool discovery", outcome: "timed_out", rateLimited: false, retryable: true,
      http: [{ stage: "initialization", elapsedMs: 20, status: 200 }] },
  ]} />);
  expect(view.getByText("Connection diagnostics · 2")).toBeTruthy();
  expect(view.container.textContent).toContain("jira #2: tool discovery, timed out, 20.0s; transport HTTP 200");
  expect(view.container.textContent).toContain("Retry-After 30s");
  expect(view.container.textContent).toContain("jira-quota-tenant-based");
  expect(view.container.querySelector("details")?.open).toBe(false);
});
it("does not invent diagnostics for historical runs", () => {
  const view = render(<SourceConnectionDiagnostics date={v => v} />);
  expect(view.container.textContent).toBe("");
});
