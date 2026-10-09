import { CronExpressionParser } from "cron-parser";
import type { SyncRun } from "./contracts.js";
import { emptyUpdaterHealth } from "./updater-health.js";
import type { UpdaterHealthState } from "./updater-health-contracts.js";

type Schedule = { hourlyUpdates: boolean; updateStartHour: number; updateEndHour: number; updateWeekdaysOnly: boolean; timeZone: string };
export function evaluateNativeUpdater(runs: SyncRun[], settings: Schedule, now: number): UpdaterHealthState {
  const sorted = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const active = sorted.find(r => r.status === "starting" || r.status === "working");
  const terminal = sorted.find(r => ["completed", "partial", "blocked"].includes(r.status));
  const success = sorted.find(r => r.status === "completed");
  const base: UpdaterHealthState = { ...emptyUpdaterHealth(now), mode: "native", configured: sorted.length > 0,
    status: active ? "running" : "healthy", title: active ? "Source check in progress" : "Source checks are complete",
    timeZone: settings.timeZone, running: Boolean(active), lastStartedAt: sorted[0] ? Date.parse(sorted[0].startedAt) : null,
    lastSuccessAt: success?.finishedAt ? Date.parse(success.finishedAt) : null };
  let due: number | null = null;
  if (settings.hourlyUpdates) {
    const hours = Array.from({ length: 24 }, (_, h) => h).filter(h => settings.updateStartHour <= settings.updateEndHour
      ? h >= settings.updateStartHour && h <= settings.updateEndHour : h >= settings.updateStartHour || h <= settings.updateEndHour);
    const cron = `0 ${hours.join(",")} * * ${settings.updateWeekdaysOnly ? "1-5" : "*"}`;
    base.nextRunAt = CronExpressionParser.parse(cron, { currentDate: new Date(now), tz: settings.timeZone }).next().getTime();
    due = CronExpressionParser.parse(cron, { currentDate: new Date(now - 20 * 60000), tz: settings.timeZone }).prev().getTime();
  }
  const problem = (status: UpdaterHealthState["status"], title: string, detail: string, identity: string): UpdaterHealthState => ({
    ...base, status, alert: true, title, detail, incidentId: `native/${base.lastSuccessAt ?? "initial"}/${identity}`,
  });
  if (terminal?.status === "blocked") return problem("failed", "Source check failed", terminal.error || "The latest source check did not finish. Open Updates to inspect or retry it.", "failed");
  const gaps = terminal?.reports.filter(r => r.status !== "complete") ?? [];
  if (terminal?.status === "partial" || gaps.length) return problem("attention", "Source check is incomplete",
    `${gaps.map(r => `${({ gmail: "Gmail", slack: "Slack", jira: "Jira", teams: "Teams", outlook: "Outlook", clickup: "ClickUp" })[r.source]}: ${r.detail}`).join("\n").slice(0, 3000)}\nUnread intervals are preserved for the next check. Some work may be missing from Proposals.`,
    `partial/${gaps.map(r => r.source).sort().join(",")}`);
  if (active && now - Date.parse(active.startedAt) > 30 * 60000) return problem("overdue", "Source check is taking too long", "The check has been running for more than 30 minutes. Open Updates to inspect it.", "stuck");
  if (!active && due && sorted.length && Date.parse(sorted[0].startedAt) < due) return problem("overdue", "Scheduled source check is overdue", "No check started in the latest scheduled slot. Open Updates to retry it.", "overdue");
  return base;
}
