import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { sourceCoverageSchema, type UpdaterHealthState } from "./updater-health-contracts.js";

export type UpdaterSettings = { sourceUpdaterProjectId: string; sourceUpdaterAutomationId: string; sourceUpdaterStatusFile?: string };
const automationSchema = z.object({
  id: z.string(), projectId: z.string(), enabled: z.boolean(), createdAt: z.number(), nextRunAt: z.number().nullable(), lastError: z.string().nullable(),
  trigger: z.object({ triggerType: z.literal("schedule"), cron: z.string(), timezone: z.string() }),
  execution: z.object({ timeoutMs: z.number().positive().optional() }).optional(),
});
const runSchema = z.object({
  id: z.string(), status: z.string(), startedAt: z.number(), finishedAt: z.number().nullable(), error: z.string().nullable(),
  output: z.string().nullable().optional(),
});
const historySchema = z.object({ runs: z.array(runSchema) });
const reportSchema = z.object({
  status: z.enum(["complete", "analysis_failed", "attention_required", "analysis_deferred"]).optional(),
  pendingRecords: z.number().int().nonnegative(), attentionBatches: z.array(z.string()),
  analysisError: z.object({ error: z.string() }).nullable().optional(),
});
export const updaterSnapshotSchema = reportSchema.extend({
  sourceCoverage: z.array(sourceCoverageSchema).max(6).optional(),
  version: z.literal(1), status: z.enum(["complete", "analysis_failed", "attention_required", "analysis_deferred"]),
  finishedAt: z.number().int().nonnegative(), collectedAt: z.number().int().nonnegative().nullable(),
  operation: z.enum(["check", "analysis", "collection"]), pendingBatches: z.number().int().nonnegative(),
}).refine(value => value.collectedAt === null || value.collectedAt <= value.finishedAt, "Collection timestamp is later than completion.")
  .refine(value => (value.sourceCoverage ?? []).every(row => Date.parse(row.collectedAt) <= value.finishedAt), "Coverage timestamp is later than completion.");
type Snapshot = z.infer<typeof updaterSnapshotSchema>;
export async function readUpdaterSnapshot(path: string): Promise<Snapshot | undefined> {
  if (!path) return undefined;
  if (!isAbsolute(path)) throw new Error("The updater status file must use an absolute path.");
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64_000) throw new Error("The updater status file is not a small JSON file.");
    return updaterSnapshotSchema.parse(JSON.parse(await file.readFile("utf8")));
  } finally { await file.close(); }
}
type Automation = z.infer<typeof automationSchema>;
type Run = z.infer<typeof runSchema>;

function report(run?: Run) {
  if (!run?.output) return null;
  // Script output also contains stderr. Accept only the typed pipeline status,
  // never arbitrary source bodies or an incidental JSON success message.
  for (const line of run.output.slice(-256_000).split("\n").reverse()) {
    try { const result = reportSchema.safeParse(JSON.parse(line)); if (result.success) return result.data; } catch { /* Not a status line. */ }
  }
  return null;
}
function errorText(value: string | null | undefined): string {
  if (!value) return "";
  try { const parsed = JSON.parse(value); if (typeof parsed?.error?.message === "string") value = parsed.error.message; } catch { /* Plain text. */ }
  return value!.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").slice(0, 1600);
}
export function emptyUpdaterHealth(now: number): UpdaterHealthState {
  return { configured: false, status: "disabled", alert: false, title: "Updater monitoring is not configured", detail: "", incidentId: null,
    checkedAt: now, lastSuccessAt: null, lastStartedAt: null, nextRunAt: null, running: false, pendingRecords: 0, attentionBatches: 0, timeZone: "UTC" };
}

export function evaluateUpdater(automation: Automation, input: Run[], now: number, snapshot?: Snapshot): UpdaterHealthState {
  const runs = [...input].sort((a, b) => b.startedAt - a.startedAt);
  const active = runs.find(run => run.status === "running");
  const terminal = runs.find(run => run.status !== "running" && run.status !== "skipped");
  const historicalReport = runs.map(run => ({ run, report: report(run) })).find(row => row.report)?.report;
  const successful = runs.find(run => run.status === "succeeded" && (!report(run) || report(run)?.status === "complete") && !(report(run)?.attentionBatches.length) && !(report(run)?.pendingRecords));
  // A manual analysis can recover an old batch without creating an automation run.
  // New unassigned records do not invalidate recovery of a failed batch.
  // It cannot clear a newer failure, a collection failure, or a missed schedule slot.
  const newer = snapshot && snapshot.finishedAt <= now + 60_000 && snapshot.finishedAt > (terminal?.finishedAt ?? terminal?.startedAt ?? 0);
  const latestReport = newer ? snapshot : historicalReport;
  const recovered = Boolean(newer && snapshot.operation !== "collection" && snapshot.status === "complete"
    && !snapshot.pendingBatches && !snapshot.attentionBatches.length && !snapshot.analysisError
    && (terminal?.status !== "failed" || report(terminal)?.analysisError || report(terminal)?.status === "analysis_failed" || snapshot.operation === "check"));
  const base: UpdaterHealthState = { ...emptyUpdaterHealth(now), configured: true, status: active ? "running" : "healthy",
    title: active ? "Source check in progress" : "Source updater is running on schedule",
    detail: "Source coverage is reported separately below. No proposals does not guarantee that every source was checked.",
    lastSuccessAt: recovered ? Math.max(snapshot!.finishedAt, successful?.finishedAt ?? 0) : successful?.finishedAt ?? null, lastStartedAt: runs[0]?.startedAt ?? null, nextRunAt: automation.nextRunAt,
    running: Boolean(active), pendingRecords: latestReport?.pendingRecords ?? 0, attentionBatches: latestReport?.attentionBatches.length ?? 0,
    timeZone: automation.trigger.timezone, sourceCoverage: snapshot?.sourceCoverage ?? [] };
  const problem = (status: UpdaterHealthState["status"], title: string, detail: string): UpdaterHealthState => ({ ...base, status, alert: true, title, detail,
    incidentId: `${automation.projectId}/${automation.id}/${base.lastSuccessAt ?? automation.createdAt}` });
  if (!automation.enabled) return problem("paused", "Source updater is paused", errorText(automation.lastError) || "Scheduled checks are disabled. New work may be missing from 247C.");
  if (base.attentionBatches) return problem("attention", "Source updates need attention",
    `${base.attentionBatches} saved batch(es) need analysis or import recovery. New work may be missing from Proposals. ${errorText(latestReport?.analysisError?.error)}`.trim());
  if ((terminal?.status === "failed" && !recovered) || latestReport?.status === "analysis_failed") return problem("failed", "Source check failed",
    errorText(latestReport?.analysisError?.error) || errorText(terminal?.error) || "The latest check did not finish. New work may be missing from 247C.");
  if (latestReport?.status === "analysis_deferred") return problem("attention", "Source analysis is waiting", "Source collection is saved, but analysis has been deferred. New work may be waiting in the queue.");
  if (base.pendingRecords) return problem("attention", "Source updates are waiting for analysis",
    `${recovered ? "The previous analysis error has been resolved. " : ""}${active
      ? "A check is running. Saved records will be analyzed in batches."
      : automation.nextRunAt ? "Saved records are queued for the next scheduled analysis. No manual action is required."
      : "Saved records still need analysis. No next run is scheduled; check the automation schedule."}`);
  const unavailable = base.sourceCoverage?.filter(source => source.status === "unavailable") ?? [];
  const sourceOutage = unavailable.length ? problem("attention", "Some work sources are unavailable",
    unavailable.map(source => `${({ clickup: "ClickUp", teams: "Teams", outlook: "Outlook", gmail: "Gmail", slack: "Slack", jira: "Jira" })[source.source]}: ${source.gaps[0] || "The last collection could not read this source."}`).join("\n")
      + "\nScheduled checks continue for available sources. Missing source data may contain new work.") : null;
  if (active) {
    if (now - active.startedAt > (automation.execution?.timeoutMs ?? 15 * 60_000) + 60_000) return problem("overdue", "Source check is taking too long", "The active run exceeded its expected duration. Check the automation before relying on the task list.");
    return sourceOutage ?? base;
  }
  // Allow the scheduled run 20 minutes to start/finish. Using the real cron and
  // its zone avoids false overnight, weekend and daylight-saving alarms.
  const due = CronExpressionParser.parse(automation.trigger.cron, { currentDate: new Date(now - 20 * 60_000), tz: automation.trigger.timezone }).prev().getTime();
  const lastFinished = Math.max(successful?.finishedAt ?? 0, recovered ? snapshot!.collectedAt ?? 0 : 0);
  if (due >= automation.createdAt && lastFinished < due) return problem("overdue", "Scheduled source check is overdue", "No successful check was recorded for the latest expected schedule slot. New work may be missing from 247C.");
  return sourceOutage ?? base;
}

export class UpdaterHealth {
  private cached: UpdaterHealthState | null = null;
  private key = "";
  private pending: Promise<UpdaterHealthState> | null = null;
  private disposed = false;
  constructor(private bb: BbPluginApi, private settings: () => UpdaterSettings, private now = () => Date.now(), private nativeState?: () => UpdaterHealthState) {}
  dispose() { this.disposed = true; }
  async start({ requestId }: { requestId: string }) {
    const settings = this.settings();
    const input = { projectId: settings.sourceUpdaterProjectId.trim(), automationId: settings.sourceUpdaterAutomationId.trim() };
    if (!input.projectId || !input.automationId) throw new Error("Configure the source updater project and automation in 247C settings.");
    const [automation, history] = await Promise.all([
      this.bb.sdk.plugins.callRpc({ pluginId: "automations", method: "automations_get", input, outputSchema: automationSchema }),
      this.bb.sdk.plugins.callRpc({ pluginId: "automations", method: "automations_runs", input: { ...input, limit: 100 }, outputSchema: historySchema }),
    ]);
    if (automation.id !== input.automationId || automation.projectId !== input.projectId) throw new Error("The configured source updater could not be found.");
    const active = history.runs.find(run => run.status === "running");
    if (active) return { runId: active.id, status: active.status, alreadyRunning: true };
    const { run } = await this.bb.sdk.plugins.callRpc({ pluginId: "automations", method: "automations_run",
      input: { ...input, idempotencyKey: `247c-updater:${requestId}` }, outputSchema: z.object({ run: runSchema }) });
    this.cached = null;
    this.bb.realtime.publish("updater-health-changed", {});
    return { runId: run.id, status: run.status, alreadyRunning: false };
  }
  async state(force = false): Promise<UpdaterHealthState> {
    const settings = this.settings();
    const input = { projectId: settings.sourceUpdaterProjectId.trim(), automationId: settings.sourceUpdaterAutomationId.trim() };
    const statusFile = settings.sourceUpdaterStatusFile?.trim() ?? "";
    const key = JSON.stringify({ ...input, statusFile });
    if (key !== this.key) { this.cached = null; this.key = key; }
    if (!input.projectId && !input.automationId) {
      const state = this.nativeState?.() ?? emptyUpdaterHealth(this.now());
      const changed = JSON.stringify(this.cached && { ...this.cached, checkedAt: 0 }) !== JSON.stringify({ ...state, checkedAt: 0 });
      this.cached = state;
      if (changed && !this.disposed) this.bb.realtime.publish("updater-health-changed", {});
      return state;
    }
    if (!force && this.cached && this.now() - this.cached.checkedAt < 30_000) return this.cached;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      let state: UpdaterHealthState;
      try {
        if (!input.projectId || !input.automationId) throw new Error("Set both the source updater project and automation ID in 247C settings.");
        const [automation, history, snapshot] = await Promise.all([
          this.bb.sdk.plugins.callRpc({ pluginId: "automations", method: "automations_get", input, outputSchema: automationSchema }),
          this.bb.sdk.plugins.callRpc({ pluginId: "automations", method: "automations_runs", input: { ...input, limit: 100 }, outputSchema: historySchema }),
          readUpdaterSnapshot(statusFile),
        ]);
        if (automation.id !== input.automationId || automation.projectId !== input.projectId) throw new Error("The configured updater could not be found.");
        if (snapshot && snapshot.finishedAt > this.now() + 60_000) throw new Error("The updater status file has a future timestamp.");
        state = evaluateUpdater(automation, history.runs, this.now(), snapshot);
      } catch (error) {
        state = { ...(this.cached ?? emptyUpdaterHealth(this.now())), checkedAt: this.now(), running: false, nextRunAt: null, configured: true, status: "unavailable", alert: true, title: "Source updater status is unavailable",
          detail: errorText(error instanceof Error ? error.message : String(error)), incidentId: `${key}/unavailable` };
      }
      if (!this.disposed && this.key === key) {
        const changed = JSON.stringify(this.cached && { ...this.cached, checkedAt: 0 }) !== JSON.stringify({ ...state, checkedAt: 0 });
        this.cached = state;
        if (changed) this.bb.realtime.publish("updater-health-changed", {});
      }
      return state;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
}
