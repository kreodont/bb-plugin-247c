import { afterEach, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { evaluateUpdater } from "./updater-health.js";
import { fixture } from "./test-support.js";

const at = (value: string) => Date.parse(value);
const now = at("2026-09-24T14:30:00Z");
const automation = { id: "auto_sources", projectId: "proj_example", enabled: true, createdAt: at("2026-09-01T00:00:00Z"),
  nextRunAt: at("2026-09-24T15:00:00Z"), lastError: null, trigger: { triggerType: "schedule" as const, cron: "0 8-20 * * *", timezone: "Europe/Athens" } };
const success = { id: "run_good", status: "succeeded", startedAt: at("2026-09-24T14:00:00Z"), finishedAt: at("2026-09-24T14:06:00Z"), error: null,
  output: JSON.stringify({ status: "complete", pendingRecords: 0, attentionBatches: [] }) };
const failed = { ...success, id: "run_bad", status: "failed", startedAt: at("2026-09-24T15:00:00Z"), finishedAt: at("2026-09-24T15:06:00Z"), error: "Import failed", output: "private body" };

it("distinguishes a successful empty check from a failed or paused updater", () => {
  expect(evaluateUpdater(automation, [success], now)).toMatchObject({ status: "healthy", alert: false, lastSuccessAt: success.finishedAt });
  const error = evaluateUpdater(automation, [failed, success], now + 3600000);
  expect(error).toMatchObject({ status: "failed", alert: true, detail: "Import failed", lastSuccessAt: success.finishedAt });
  expect(JSON.stringify(error)).not.toContain("private body");
  expect(evaluateUpdater({ ...automation, enabled: false, lastError: "Paused after three failures" }, [failed, success], now)).toMatchObject({ status: "paused", alert: true, detail: "Paused after three failures" });
});

it("retains the warning through a retry and a skipped tick, then clears on success", () => {
  const retry = { ...failed, id: "retry", status: "running", startedAt: failed.startedAt + 600000, finishedAt: null, error: null };
  const skipped = { ...retry, id: "skip", startedAt: retry.startedAt + 1000, finishedAt: retry.startedAt + 1000, status: "skipped" };
  const during = evaluateUpdater(automation, [skipped, retry, failed, success], retry.startedAt + 5000);
  expect(during).toMatchObject({ status: "failed", alert: true, running: true });
  expect(during.incidentId).toBe(evaluateUpdater(automation, [failed, success], failed.finishedAt).incidentId);
  expect(evaluateUpdater(automation, [{ ...success, id: "recovered", startedAt: retry.startedAt, finishedAt: retry.startedAt + 1000 }, failed], retry.startedAt + 5000)).toMatchObject({ alert: false });
});

it("keeps saved invalid batches and queued work visible even when the script exits successfully", () => {
  const attention = { ...failed, status: "succeeded", output: JSON.stringify({ status: "attention_required", pendingRecords: 7, attentionBatches: ["batch_saved"], analysisError: null }) };
  expect(evaluateUpdater(automation, [attention, success], now + 3600000)).toMatchObject({ status: "attention", alert: true, attentionBatches: 1, pendingRecords: 7, lastSuccessAt: success.finishedAt });
  const waiting = { ...attention, output: JSON.stringify({ status: "complete", pendingRecords: 4, attentionBatches: [] }) };
  expect(evaluateUpdater(automation, [waiting, success], now + 3600000)).toMatchObject({ status: "waiting", alert: true, pendingRecords: 4, lastSuccessAt: success.finishedAt });
});

it("uses actual scheduled slots, including nights and weekends, and gives a 20-minute grace", () => {
  const evening = { ...success, startedAt: at("2026-09-24T17:00:00Z"), finishedAt: at("2026-09-24T17:05:00Z") };
  expect(evaluateUpdater(automation, [evening], at("2026-09-25T02:00:00Z"))).toMatchObject({ alert: false });
  expect(evaluateUpdater(automation, [success], at("2026-09-24T15:19:00Z"))).toMatchObject({ alert: false });
  expect(evaluateUpdater(automation, [success], at("2026-09-24T15:21:00Z"))).toMatchObject({ status: "overdue", alert: true });
  const friday = { ...evening, startedAt: at("2026-09-25T17:00:00Z"), finishedAt: at("2026-09-25T17:05:00Z") };
  expect(evaluateUpdater({ ...automation, trigger: { ...automation.trigger, cron: "0 8-20 * * 1-5" } }, [friday], at("2026-09-27T12:00:00Z"))).toMatchObject({ alert: false });
});

it("detects a stuck active run and an updater that never started", () => {
  expect(evaluateUpdater(automation, [{ ...success, status: "running", finishedAt: null }], now)).toMatchObject({ status: "overdue", alert: true });
  expect(evaluateUpdater(automation, [], now)).toMatchObject({ status: "overdue", alert: true, lastSuccessAt: null });
});

const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); });
it("does not query an unconfigured automation and reports RPC failures without pretending to be healthy", async () => {
  const f = await fixture(); hosts.push(f);
  expect(await f.harness.behavior.callRpc("updaterHealth", {})).toMatchObject({ configured: false, alert: false });
  expect(f.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
  await f.harness.behavior.setSettings({ sourceUpdaterProjectId: "proj_example", sourceUpdaterAutomationId: "auto_sources" });
  f.harness.inspection.sdk.stub("plugins.callRpc", async () => { throw new Error("Automations unavailable"); });
  expect(await f.harness.behavior.callRpc("updaterHealth", {})).toMatchObject({ status: "unavailable", alert: true, detail: "Automations unavailable" });
});
it("queries only the configured automation, caches reads and returns strict JSON without script bodies", async () => {
  const f = await fixture({ settings: { sourceUpdaterProjectId: "proj_example", sourceUpdaterAutomationId: "auto_sources" } }); hosts.push(f);
  f.harness.inspection.sdk.stub("plugins.callRpc", async ({ pluginId, method, input, outputSchema }: Parameters<BbPluginApi["sdk"]["plugins"]["callRpc"]>[0]) => {
    expect(pluginId).toBe("automations"); expect(input).toMatchObject({ projectId: "proj_example", automationId: "auto_sources" });
    return outputSchema.parse(method === "automations_get" ? { ...automation, enabled: false, execution: { script: "private script" } } : { runs: [failed, success] });
  });
  const result = await f.harness.behavior.callRpc("updaterHealth", {});
  expect(result).toMatchObject({ status: "paused", alert: true });
  expect(JSON.stringify(result)).not.toContain("private");
  await f.harness.behavior.callRpc("updaterHealth", {});
  expect(f.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(2);
  await f.harness.behavior.callRpc("updaterHealth", { refresh: true });
  expect(f.harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(4);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
});

it("clears stale analysis errors after a newer manual recovery without changing source coverage time", () => {
  const broken = { ...failed, output: JSON.stringify({ status: "analysis_failed", pendingRecords: 0, attentionBatches: ["batch"], analysisError: { error: "Analysis timed out" } }) };
  const finishedAt = failed.finishedAt + 1000;
  const snapshot = { version: 1 as const, operation: "analysis" as const, status: "complete" as const,
    finishedAt, collectedAt: failed.startedAt, pendingRecords: 0, pendingBatches: 0, attentionBatches: [], analysisError: null };
  expect(evaluateUpdater(automation, [broken, success], finishedAt, snapshot)).toMatchObject({ alert: false, attentionBatches: 0, lastSuccessAt: finishedAt });
  // A fresh manual recovery of old data does not count as a new source check.
  expect(evaluateUpdater(automation, [broken, success], finishedAt + 2 * 3600000,
    { ...snapshot, finishedAt: finishedAt + 2 * 3600000 })).toMatchObject({ alert: true, status: "overdue", attentionBatches: 0 });
  expect(evaluateUpdater({ ...automation, enabled: false }, [broken, success], finishedAt, snapshot)).toMatchObject({ alert: true, status: "paused" });
});

it("does not let a manual analysis hide newer errors, collection errors or unfinished work", () => {
  const snapshot = { version: 1 as const, operation: "analysis" as const, status: "complete" as const,
    finishedAt: failed.finishedAt + 1000, collectedAt: failed.startedAt, pendingRecords: 0, pendingBatches: 0, attentionBatches: [], analysisError: null };
  const collectionError = { ...failed, error: "Collector authentication failed", output: null };
  expect(evaluateUpdater(automation, [collectionError, success], snapshot.finishedAt, snapshot)).toMatchObject({ alert: true, status: "failed", detail: "Collector authentication failed", lastSuccessAt: success.finishedAt });
  const newerFailure = { ...failed, startedAt: snapshot.finishedAt + 1000, finishedAt: snapshot.finishedAt + 2000 };
  expect(evaluateUpdater(automation, [newerFailure, success], newerFailure.finishedAt, snapshot)).toMatchObject({ alert: true, status: "failed" });
  expect(evaluateUpdater(automation, [failed, success], snapshot.finishedAt,
    { ...snapshot, status: "attention_required", pendingBatches: 1, attentionBatches: ["still-stuck"] })).toMatchObject({ alert: true, attentionBatches: 1, lastSuccessAt: success.finishedAt });
});


it("clears a recovered batch error while keeping unrelated queued records visible", () => {
  const broken = { ...failed, output: JSON.stringify({ status: "analysis_failed", pendingRecords: 47, attentionBatches: [], analysisError: { error: "Invalid citation" } }) };
  const snapshot = { version: 1 as const, operation: "analysis" as const, status: "complete" as const,
    finishedAt: failed.finishedAt + 1000, collectedAt: failed.startedAt, pendingRecords: 47, pendingBatches: 0, attentionBatches: [], analysisError: null };
  const state = evaluateUpdater(automation, [broken, success], snapshot.finishedAt, snapshot);
  expect(state).toMatchObject({ status: "waiting", alert: true, pendingRecords: 47, attentionBatches: 0, lastSuccessAt: snapshot.finishedAt });
  expect(state.detail).toContain("previous analysis error has been resolved");
  expect(state.detail).toContain("No manual action is required");
  expect(state.detail).not.toContain("Invalid citation");
  expect(evaluateUpdater(automation, [broken, success], snapshot.finishedAt, { ...snapshot, pendingBatches: 1 })).toMatchObject({ status: "failed" });
  expect(evaluateUpdater(automation, [broken, success], snapshot.finishedAt, { ...snapshot, operation: "collection" })).toMatchObject({ status: "failed" });
  expect(evaluateUpdater(automation, [{ ...broken, finishedAt: snapshot.finishedAt + 1000 }, success], snapshot.finishedAt + 1000, snapshot)).toMatchObject({ status: "failed" });
  expect(evaluateUpdater({ ...automation, nextRunAt: null }, [broken, success], snapshot.finishedAt, snapshot).detail).toContain("No next run is scheduled");
});


it("keeps a source outage visible after successful analysis and through a running check", () => {
  const snapshot = { version: 1 as const, operation: "analysis" as const, status: "complete" as const,
    finishedAt: now, collectedAt: success.startedAt, pendingRecords: 0, pendingBatches: 0, attentionBatches: [], analysisError: null,
    sourceCoverage: [{ source: "clickup" as const, status: "unavailable" as const, collectedAt: new Date(success.startedAt).toISOString(),
      since: "2026-09-23T00:00:00Z", fullyCheckedThrough: null, savedRecords: 0, gaps: ["Daily quota exhausted; reads paused until reset."] }] };
  for (const runs of [[success], [{ ...success, id: "active", status: "running", startedAt: now, finishedAt: null }, success]]) {
    expect(evaluateUpdater(automation, runs, now, snapshot)).toMatchObject({ status: "attention", alert: true, title: "Some work sources are unavailable", pendingRecords: 0 });
    expect(evaluateUpdater(automation, runs, now, snapshot).detail).toContain("Daily quota exhausted");
  }
  expect(evaluateUpdater(automation, [success], now, { ...snapshot, sourceCoverage: [{ ...snapshot.sourceCoverage[0], status: "complete", gaps: [] }] })).toMatchObject({ alert: false });
});
