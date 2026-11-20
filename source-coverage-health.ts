import type { SourceCoverage, UpdaterHealthState } from "./updater-health-contracts.js";

const names = { clickup: "ClickUp", teams: "Teams", outlook: "Outlook", gmail: "Gmail", slack: "Slack", jira: "Jira" };
export function incompleteCoverage(rows: SourceCoverage[] = []) {
  return rows.filter(row => row.status === "partial");
}

export function coverageDetail(rows: SourceCoverage[], timeZone: string) {
  const format = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone });
  return rows.map(row => {
    const since = format.format(new Date(row.fullyCheckedThrough ?? row.since));
    const through = format.format(new Date(row.collectedAt));
    return `${names[row.source]}: coverage not confirmed from ${since} to ${through} (${timeZone}).${row.chatScan ? ` Messages queued: ${row.chatScan.pendingMessages}.` : ""}${row.gaps[0] ? ` ${row.gaps[0]}` : ""}`;
  }).join("\n");
}

export function coverageHealth(base: UpdaterHealthState): UpdaterHealthState | null {
  const rows = incompleteCoverage(base.sourceCoverage);
  if (!rows.length) return null;
  // Use the collection boundary, not wall time: a quiet night or weekend alone
  // must not turn a recent partial scan into a stale-coverage incident.
  const stale = rows.some(row => Date.parse(row.collectedAt) - Date.parse(row.fullyCheckedThrough ?? row.since) >= 24 * 60 * 60_000);
  return { ...base, alert: true, status: stale ? "attention" : "partial",
    title: stale ? "Source collection has gaps older than 24 hours" : "Source collection is incomplete",
    detail: `${coverageDetail(rows, base.timeZone)}\nSome work may be missing from Proposals. Open Updates for collection gaps. A successful analysis does not resolve unread source records.`,
    // Analysis successes must neither dismiss nor repeatedly reopen this incident.
    incidentId: `coverage/${stale ? "stale" : "partial"}/${rows.map(row => `${row.source}:${row.fullyCheckedThrough ?? row.since}`).sort().join("/")}` };
}
