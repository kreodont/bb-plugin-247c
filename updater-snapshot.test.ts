import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readUpdaterSnapshot } from "./updater-health.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { fixture } from "./test-support.js";

const paths: string[] = [];
const hosts: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const f of hosts.splice(0)) await f.harness.lifecycle.dispose(); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
const snapshot = { version: 1, operation: "analysis", status: "complete", finishedAt: Date.now(), collectedAt: Date.now() - 1000,
  pendingRecords: 0, pendingBatches: 0, attentionBatches: [], analysisError: null };
it("reads a bounded typed snapshot and rejects missing, oversized or malformed files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "247c-status-")); paths.push(dir); const path = join(dir, "status.json");
  expect(await readUpdaterSnapshot("")).toBeUndefined();
  await expect(readUpdaterSnapshot("relative.json")).rejects.toThrow("absolute path");
  await expect(readUpdaterSnapshot(path)).rejects.toThrow();
  await writeFile(path, JSON.stringify(snapshot)); expect(await readUpdaterSnapshot(path)).toEqual(snapshot);
  await writeFile(path, JSON.stringify({ ...snapshot, pendingRecords: -1 })); await expect(readUpdaterSnapshot(path)).rejects.toThrow();
  await writeFile(path, "x".repeat(64_001)); await expect(readUpdaterSnapshot(path)).rejects.toThrow("small JSON file");
});
it("uses the configured local snapshot through the real health RPC and reports unreadable state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "247c-status-")); paths.push(dir); const path = join(dir, "status.json");
  await writeFile(path, JSON.stringify(snapshot));
  const f = await fixture({ settings: { sourceUpdaterProjectId: "proj_example", sourceUpdaterAutomationId: "auto_example", sourceUpdaterStatusFile: path } }); hosts.push(f);
  f.harness.inspection.sdk.stub("plugins.callRpc", async ({ method, outputSchema }: Parameters<BbPluginApi["sdk"]["plugins"]["callRpc"]>[0]) => outputSchema.parse(method === "automations_get"
    ? { id: "auto_example", projectId: "proj_example", enabled: true, createdAt: snapshot.finishedAt - 10000, nextRunAt: snapshot.finishedAt + 3600000, lastError: null, trigger: { triggerType: "schedule", cron: "0 * * * *", timezone: "UTC" } }
    : { runs: [{ id: "old-error", status: "failed", startedAt: snapshot.finishedAt - 5000, finishedAt: snapshot.finishedAt - 2000, error: "Analysis timed out", output: JSON.stringify({ status: "analysis_failed", pendingRecords: 0, attentionBatches: ["old-batch"], analysisError: { error: "Analysis timed out" } }) }] }));
  expect(await f.harness.behavior.callRpc("updaterHealth", { refresh: true })).toMatchObject({ alert: false, attentionBatches: 0, lastSuccessAt: snapshot.finishedAt });
  await writeFile(path, JSON.stringify({ ...snapshot, pendingRecords: 47 }));
  expect(await f.harness.behavior.callRpc("updaterHealth", { refresh: true })).toMatchObject({ alert: true, status: "attention", pendingRecords: 47, lastSuccessAt: snapshot.finishedAt });
  await rm(path);
  expect(await f.harness.behavior.callRpc("updaterHealth", { refresh: true })).toMatchObject({ alert: true, status: "unavailable" });
});

it("preserves coverage independently of analysis and rejects invalid coverage dates", async () => {
  const { updaterSnapshotSchema, evaluateUpdater } = await import("./updater-health.js");
  const collectedAt = new Date(snapshot.collectedAt).toISOString();
  const sourceCoverage = [{ source: "outlook" as const, collectedAt, since: "2026-09-01T00:00:00Z", fullyCheckedThrough: collectedAt,
    status: "complete" as const, savedRecords: 29, gaps: [] }];
  const parsed = updaterSnapshotSchema.parse({ ...snapshot, status: "analysis_failed", sourceCoverage, analysisError: { error: "Invalid citation" } });
  const state = evaluateUpdater({ id: "auto", projectId: "project", enabled: true, createdAt: snapshot.finishedAt, nextRunAt: null, lastError: null,
    trigger: { triggerType: "schedule", cron: "0 * * * *", timezone: "UTC" } }, [], snapshot.finishedAt, parsed);
  expect(state).toMatchObject({ status: "failed", sourceCoverage, detail: "Invalid citation" });
  expect(updaterSnapshotSchema.safeParse({ ...snapshot, sourceCoverage: [{ ...sourceCoverage[0], fullyCheckedThrough: "2099-01-01T00:00:00Z" }] }).success).toBe(false);
});
