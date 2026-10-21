import type { SyncSubmit } from "./contracts.js";
import type { SourceCall } from "./source-sync.js";

function args(call: SourceCall): Record<string, unknown> {
  return call.args && typeof call.args === "object" ? call.args as Record<string, unknown> : {};
}

export function missingSlackThread(call: SourceCall): boolean {
  const a = args(call);
  if (call.source !== "slack" || !call.tool.endsWith("slack_read_thread") || call.completed || call.truncated || !call.read
    || typeof a.channel_id !== "string" || !/^[CDG][A-Z0-9]+$/.test(a.channel_id)
    || typeof a.message_ts !== "string" || !/^\d{10}\.\d{6}$/.test(a.message_ts) || a.cursor) return false;
  let diagnostic = call.output.trim();
  try {
    const data = JSON.parse(call.output.split("\n")[0]);
    diagnostic = typeof data.text === "string" ? data.text : typeof data.error === "string" ? data.error : "";
  } catch { /* A thrown connector error can contain just the diagnostic. */ }
  return /^(?:execution_failed:\s*)?thread_not_found$/.test(diagnostic.trim());
}

export function readableSlackChannel(call: SourceCall, channel: unknown): boolean {
  if (call.source !== "slack" || !call.completed || call.truncated || args(call).channel_id !== channel
    || !/(?:^|[._])slack_read_(?:thread|channel)$/.test(call.tool)) return false;
  try { return typeof JSON.parse(call.output.split("\n")[0]).messages === "string"; }
  catch { return false; }
}

export function slackAccessProbe(call: SourceCall): boolean {
  return call.purpose === "slack-channel-access" && call.source === "slack" && call.tool === "slack.slack_read_channel"
    && !call.read && args(call).limit === 1;
}

// Keep the failed receipt as evidence of absence, never as a successful read
// or a source quote. A fresh read in the same channel establishes access.
export function skippedSlackCalls(calls: SourceCall[]): Set<string> {
  return new Set(calls.filter(call => missingSlackThread(call)
    && calls.some(other => readableSlackChannel(other, args(call).channel_id))).map(call => call.ref));
}

export function missingSlackDetail(call: SourceCall): string {
  const a = args(call);
  return `slack_read_thread (${a.channel_id}:${a.message_ts}): `;
}

export function normalizeMissingSlackReport(report: SyncSubmit["reports"][number], calls: SourceCall[]): SyncSubmit["reports"][number] {
  if (report.source !== "slack" || report.status === "unavailable") return report;
  const selected = calls.filter(c => report.callRefs.includes(c.ref));
  const skipped = skippedSlackCalls(selected);
  if (!skipped.size) return report;
  const prefixes = selected.filter(c => skipped.has(c.ref)).map(missingSlackDetail);
  const remaining = report.detail.split("\n").filter(line => !prefixes.some(prefix => line.startsWith(prefix)
    && /^(?:execution_failed:\s*)?thread_not_found$/.test(line.slice(prefix.length).trim())));
  const note = `Skipped ${skipped.size} Slack ${skipped.size === 1 ? "message" : "messages"} no longer available in an accessible channel.`;
  if (report.status === "partial" && remaining.every(line => !line.trim())) return {
    ...report, status: "complete", detail: note, paginationComplete: true, linkedTasksChecked: true,
  };
  // Do not clear pagination, timeout, permission or any other unresolved issue.
  return remaining.length !== report.detail.split("\n").length
    ? { ...report, detail: [...remaining, note].filter(Boolean).join("\n").slice(0, 4000) } : report;
}
