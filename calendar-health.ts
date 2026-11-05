import type { CalendarState } from "./day-contracts.js";
import type { UpdaterHealthState } from "./updater-health-contracts.js";

export function withCalendarHealth(source: UpdaterHealthState, calendar: CalendarState, enabled: boolean): UpdaterHealthState {
  const error = calendar.lastError ?? (calendar.status === "error" ? calendar.message ?? "Calendar check failed." : null);
  const calendarAlert = enabled && Boolean(error);
  const state = { ...source, calendar, calendarAlert };
  if (!calendarAlert) return state;
  const sourceFailure = source.alert && source.status !== "waiting";
  return { ...state, configured: true, alert: true, status: sourceFailure ? source.status : "attention",
    title: sourceFailure ? source.title : "Work calendar needs attention",
    detail: sourceFailure ? source.detail : "Calendar sync failed. Meetings and day totals may be out of date. Previous meetings and manual time edits are preserved.",
    incidentId: `${sourceFailure ? source.incidentId + "/" : ""}calendar:${calendar.errorSince ?? calendar.startedAt ?? "unknown"}` };
}
