import { expect, it } from "vitest";
import { evaluateNativeUpdater } from "./native-updater-health.js";
import { SourceSyncStore } from "./source-sync.js";
import { fixture } from "./test-support.js";
import { startSourceSync } from "./source-sync-test-support.js";
import type { SyncRun } from "./contracts.js";

const settings = { hourlyUpdates: true, updateStartHour: 8, updateEndHour: 20, updateWeekdaysOnly: true, timeZone: "Europe/Athens" };
const until = "2026-10-08T06:00:00Z";
const run: SyncRun = { id: "test", status: "partial", until, startedAt: until, finishedAt: "2026-10-08T06:03:00Z", threadId: null, provider: "codex", model: "test", manualSince: null,
  ranges: { slack: { since: "2026-10-07T06:00:00Z", previous: null } }, reports: [{ source: "slack", status: "partial", detail: "slack_read_thread: thread_not_found", callRefs: [], paginationComplete: false, linkedTasksChecked: false, scanned: 2, threadsRead: 1 }],
  error: null, suggestions: 0, duplicates: 0, fingerprint: "test" };
const now = Date.parse("2026-10-08T06:05:00Z");

it("alerts on a partial native check, preserves the incident during retries and clears it after recovery", () => {
  const warning = evaluateNativeUpdater([run], settings, now);
  expect(warning).toMatchObject({ mode: "native", configured: true, alert: true, status: "attention" });
  expect(warning.detail).toContain("Slack: slack_read_thread: thread_not_found");
  const retry = { ...run, id: "retry", status: "working" as const, startedAt: "2026-10-08T07:00:00Z", finishedAt: null, reports: [] };
  expect(evaluateNativeUpdater([retry, run], settings, now + 3600000)).toMatchObject({ alert: true, running: true, incidentId: warning.incidentId });
  const complete = { ...retry, status: "completed" as const, finishedAt: "2026-10-08T07:03:00Z" };
  expect(evaluateNativeUpdater([complete, run], settings, now + 3600000)).toMatchObject({ alert: false, status: "healthy" });
  expect(evaluateNativeUpdater([{ ...run, startedAt: "2026-10-08T08:00:00Z" }, complete], settings, now + 7200000).incidentId).not.toBe(warning.incidentId);
});

it("detects failed and stalled checks and respects the weekday schedule", () => {
  expect(evaluateNativeUpdater([{ ...run, status: "blocked", error: "Provider unavailable" }], settings, now)).toMatchObject({ alert: true, status: "failed", detail: "Provider unavailable" });
  expect(evaluateNativeUpdater([{ ...run, status: "working", reports: [] }], settings, now + 3600000)).toMatchObject({ alert: true, status: "overdue" });
  const friday = { ...run, status: "completed" as const, reports: [], startedAt: "2026-10-09T17:00:00Z", finishedAt: "2026-10-09T17:05:00Z" };
  expect(evaluateNativeUpdater([friday], settings, Date.parse("2026-10-10T10:00:00Z"))).toMatchObject({ alert: false, nextRunAt: Date.parse("2026-10-12T05:00:00Z") });
  expect(evaluateNativeUpdater([friday], settings, Date.parse("2026-10-12T05:21:00Z"))).toMatchObject({ alert: true, status: "overdue" });
});

it("exposes native failures through the actual health RPC with no external automation configured", async () => {
  const f = await fixture();
  try {
    const { run: saved } = await startSourceSync(f), store = new SourceSyncStore(f.repo);
    store.save({ ...saved, status: "partial", reports: run.reports, finishedAt: saved.until });
    expect(await f.harness.behavior.callRpc("updaterHealth", {})).toMatchObject({ mode: "native", configured: true, alert: true, status: "attention" });
    expect(f.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    store.save({ ...saved, status: "completed", reports: [], finishedAt: saved.until });
    expect(await f.harness.behavior.callRpc("updaterHealth", {})).toMatchObject({ alert: false });
    expect(f.harness.realtimeSignals.some(s => s.channel === "updater-health-changed")).toBe(true);
  } finally { await f.harness.lifecycle.dispose(); }
});
