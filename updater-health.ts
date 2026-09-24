import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { UpdaterHealthState } from "./updater-health-contracts.js";

export type UpdaterSettings = { sourceUpdaterProjectId: string; sourceUpdaterAutomationId: string };
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

export function evaluateUpdater(automation: Automation, input: Run[], now: number): UpdaterHealthState {
  const runs = [...input].sort((a, b) => b.startedAt - a.startedAt);
  const active = runs.find(run => run.status === "running");
  const terminal = runs.find(run => run.status !== "running" && run.status !== "skipped");
  const latestReport = runs.map(run => ({ run, report: report(run) })).find(row => row.report)?.report;
  const successful = runs.find(run => run.status === "succeeded" && (!report(run) || report(run)?.status === "complete") && !(report(run)?.attentionBatches.length) && !(report(run)?.pendingRecords));
  const base: UpdaterHealthState = { ...emptyUpdaterHealth(now), configured: true, status: active ? "running" : "healthy",
    title: active ? "Source check in progress" : "Source updater is running on schedule",
    detail: "Source coverage is reported separately below. No proposals does not guarantee that every source was checked.",
    lastSuccessAt: successful?.finishedAt ?? null, lastStartedAt: runs[0]?.startedAt ?? null, nextRunAt: automation.nextRunAt,
    running: Boolean(active), pendingRecords: latestReport?.pendingRecords ?? 0, attentionBatches: latestReport?.attentionBatches.length ?? 0,
    timeZone: automation.trigger.timezone };
  const problem = (status: UpdaterHealthState["status"], title: string, detail: string): UpdaterHealthState => ({ ...base, status, alert: true, title, detail,
    incidentId: `${automation.projectId}/${automation.id}/${base.lastSuccessAt ?? automation.createdAt}` });
  if (!automation.enabled) return problem("paused", "Source updater is paused", errorText(automation.lastError) || "Scheduled checks are disabled. New work may be missing from 247C.");
  if (base.attentionBatches) return problem("attention", "Source updates need attention",
    `${base.attentionBatches} saved analysis batch(es) could not be imported. New work may be missing from Proposals. ${errorText(latestReport?.analysisError?.error)}`.trim());
  if (terminal?.status === "failed" || latestReport?.status === "analysis_failed") return problem("failed", "Source check failed",
    errorText(latestReport?.analysisError?.error) || errorText(terminal?.error) || "The latest check did not finish. New work may be missing from 247C.");
  if (latestReport?.status === "analysis_deferred") return problem("attention", "Source analysis is waiting", "Source collection is saved, but analysis has been deferred. New work may be waiting in the queue.");
  if (base.pendingRecords) return problem("attention", "Source updates are waiting for analysis", "The collector has saved records that have not reached Proposals yet.");
  if (active) {
    if (now - active.startedAt > (automation.execution?.timeoutMs ?? 15 * 60_000) + 60_000) return problem("overdue", "Source check is taking too long", "The active run exceeded its expected duration. Check the automation before relying on the task list.");
    return base;
  }
  // Allow the scheduled run 20 minutes to start/finish. Using the real cron and
  // its zone avoids false overnight, weekend and daylight-saving alarms.
  const due = CronExpressionParser.parse(automation.trigger.cron, { currentDate: new Date(now - 20 * 60_000), tz: automation.trigger.timezone }).prev().getTime();
  const lastFinished = successful?.finishedAt ?? 0;
  if (due >= automation.createdAt && lastFinished < due) return problem("overdue", "Scheduled source check is overdue", "No successful check was recorded for the latest expected schedule slot. New work may be missing from 247C.");
  return base;
}

export class UpdaterHealth {
  private cached: UpdaterHealthState | null = null;
  private key = "";
  private pending: Promise<UpdaterHealthState> | null = null;
  private disposed = false;
  constructor(private bb: BbPluginApi, private settings: () => UpdaterSettings, private now = () => Date.now()) {}
  dispose() { this.disposed = true; }
  async state(force = false): Promise<UpdaterHealthState> {
    const settings = this.settings();
    const input = { projectId: settings.sourceUpdaterProjectId.trim(), automationId: settings.sourceUpdaterAutomationId.trim() };
    const key = JSON.stringify(input);
    if (key !== this.key) { this.cached = null; this.key = key; }
    if (!input.projectId && !input.automationId) return emptyUpdaterHealth(this.now());
    if (!force && this.cached && this.now() - this.cached.checkedAt < 30_000) return this.cached;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      let state: UpdaterHealthState;
      try {
        if (!input.projectId || !input.automationId) throw new Error("Set both the source updater project and automation ID in 247C settings.");
        const [automation, history] = await Promise.all([
          this.bb.sdk.plugins.callRpc({ pluginId: "automations", method: "automations_get", input, outputSchema: automationSchema }),
          this.bb.sdk.plugins.callRpc({ pluginId: "automations", method: "automations_runs", input: { ...input, limit: 100 }, outputSchema: historySchema }),
        ]);
        if (automation.id !== input.automationId || automation.projectId !== input.projectId) throw new Error("The configured updater could not be found.");
        state = evaluateUpdater(automation, history.runs, this.now());
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
