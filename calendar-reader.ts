import { createHash } from "node:crypto";
import { z } from "zod";
import { connectCalendar, WORK_CALENDAR, sourceError, type SourceConnector } from "./source-connectors.js";
import { calendarEventSchema, dayDateSchema, DAY_TIME_ZONE, shiftDay, type CalendarEvent, type DayItem } from "./day-contracts.js";

const eventTime = z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() });
const remoteEvent = z.object({
  id: z.string().min(1), summary: z.string().optional(), status: z.string().optional(), htmlLink: z.string().optional(),
  start: eventTime.optional(), end: eventTime.optional(), originalStartTime: eventTime.optional(), recurringEventId: z.string().optional(),
  recurrence: z.array(z.string()).optional(), eventType: z.string().optional(),
  attendees: z.array(z.object({ email: z.string().optional(), self: z.boolean().optional(), responseStatus: z.string().optional() })).optional(),
});
function jsonResult(value: unknown): unknown {
  if (!value || typeof value !== "object") throw new Error("Unrecognized calendar response.");
  const result = value as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };
  const text = result.content?.filter(c => c.type === "text").map(c => c.text ?? "").join("\n") ?? "";
  if (result.isError) throw new Error(sourceError(text || "Google Calendar returned an error."));
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  try { return JSON.parse(text); } catch { throw new Error("The calendar response contains no readable data."); }
}
function safeUrl(raw?: string) { try { const url = new URL(raw ?? ""); return url.protocol === "https:" ? url.href : null; } catch { return null; } }
function isMissingEvent(error: unknown) {
  const message = sourceError(error).trim();
  // The Calendar connector can omit the HTTP status from a missing-event
  // response. Match its exact message only when rechecking a known event,
  // after calendar access and the full date query have already succeeded.
  return /\b(404|410)\b|\bNOT_FOUND\b/i.test(message)
    || /^The requested resource could not be found or has been deleted\.?$/i.test(message);
}
export function normalizeCalendarEvent(value: unknown, previous?: CalendarEvent, calendarId = WORK_CALENDAR): CalendarEvent | null {
  const raw = remoteEvent.parse(value);
  const declined = raw.attendees?.some(a => (a.self || a.email?.toLowerCase() === calendarId) && a.responseStatus === "declined");
  const cancelled = raw.status === "cancelled";
  if ((cancelled || declined) && previous) return { ...previous, title: raw.summary?.slice(0, 1000) || previous.title, status: cancelled ? "cancelled" : "declined" };
  if (cancelled || declined) return null;
  const excluded = raw.start?.date || raw.end?.date || raw.eventType && !["DEFAULT", "EVENT_TYPE_UNSPECIFIED", "default"].includes(raw.eventType);
  if (excluded) return previous ? { ...previous, title: raw.summary?.slice(0, 1000) || previous.title, status: "excluded" } : null;
  if (!raw.start?.dateTime || !raw.end?.dateTime) throw new Error("A meeting has no start or end time. Import stopped.");
  if (raw.recurrence?.length && !raw.originalStartTime && !raw.recurringEventId) throw new Error("The calendar returned a recurring series instead of individual meetings. Import stopped to avoid recording incorrect time.");
  // The service returns offset-bearing ISO timestamps. Refuse to interpret a
  // timezone-less timestamp in the BB server's local timezone.
  const startAt = z.iso.datetime({ offset: true }).parse(raw.start.dateTime), endAt = z.iso.datetime({ offset: true }).parse(raw.end.dateTime);
  return calendarEventSchema.parse({ key: previous?.key ?? `gcal:${createHash("sha256").update(`${calendarId}\0${raw.id}`).digest("hex")}`,
    calendarId, eventId: raw.id, occurrenceId: raw.originalStartTime?.dateTime ?? raw.originalStartTime?.date ?? null,
    title: raw.summary?.slice(0, 1000) || "Meeting", startAt, endAt, status: "confirmed", url: safeUrl(raw.htmlLink),
  });
}
async function call(connector: SourceConnector, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return jsonResult(await connector.call(name, args, signal)); }
    catch (error) {
      if (attempt >= 2 || signal.aborted || !/timeout|timed out|temporar|connection reset|\b(429|502|503|504|-32001)\b/i.test(sourceError(error))) throw error;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 350 * (attempt + 1));
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}
export async function readCalendar(input: { from: string; through: string; known: DayItem[]; signal: AbortSignal; calendarId?: string; timeZone?: string }, connect = connectCalendar) {
  const calendarId = input.calendarId ?? WORK_CALENDAR;
  const from = dayDateSchema.parse(input.from), through = dayDateSchema.parse(input.through);
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(90000)]);
  const connector = await connect(signal);
  const events = new Map<string, CalendarEvent>();
  let readCount = 0;
  const known = new Map(input.known.filter(i => i.calendar?.calendarId === calendarId).map(i => [i.calendar!.eventId, i.calendar!]));
  try {
    let pageToken: string | undefined, found = false;
    const calendarTokens = new Set<string>();
    do {
      const page = z.object({ calendars: z.array(z.object({ id: z.string() })).default([]), nextPageToken: z.string().optional() })
        .parse(await call(connector, "list_calendars", { pageSize: 250, ...(pageToken ? { pageToken } : {}) }, signal));
      found ||= page.calendars.some(c => c.id.toLowerCase() === calendarId.toLowerCase());
      pageToken = page.nextPageToken || undefined;
      if (pageToken && calendarTokens.has(pageToken)) throw new Error("The calendar list repeats a page.");
      if (pageToken) calendarTokens.add(pageToken);
      if (calendarTokens.size > 20) throw new Error("Too many calendar list pages.");
    } while (pageToken && !found);
    if (!found) throw new Error(`The connected account does not contain the work calendar ${calendarId}.`);
    pageToken = undefined;
    const tokens = new Set<string>(), seenIds = new Set<string>();
    do {
      const page = z.object({ events: z.array(z.unknown()).default([]), nextPageToken: z.string().optional() }).parse(await call(connector, "list_events", {
        calendarId, startTime: `${from}T00:00:00`, endTime: `${shiftDay(through, 1)}T00:00:00`, timeZone: input.timeZone ?? DAY_TIME_ZONE,
        eventType: ["DEFAULT"], orderBy: "startTime", pageSize: 250, ...(pageToken ? { pageToken } : {}),
      }, signal));
      for (const raw of page.events) {
        const record = remoteEvent.parse(raw); seenIds.add(record.id); readCount++;
        const normalized = normalizeCalendarEvent(record, known.get(record.id), calendarId);
        if (normalized) events.set(normalized.key, normalized);
      }
      pageToken = page.nextPageToken || undefined;
      if (pageToken && tokens.has(pageToken)) throw new Error("The calendar repeats a page of meetings.");
      if (pageToken) tokens.add(pageToken);
      if (tokens.size > 20 || readCount > 3000) throw new Error("Too many meetings for one check.");
    } while (pageToken);
    // Missing from a date query can mean moved, cancelled, declined, or hidden
    // by a filter. Read each known occurrence instead of treating absence as
    // cancellation. An error fails the batch without changing stored meetings.
    const missing = input.known.filter(i => i.calendar?.calendarId === calendarId && i.date >= from && i.date <= through && !seenIds.has(i.calendar.eventId));
    if (missing.length > 500) throw new Error("Too many previous meetings to recheck.");
    for (let offset = 0; offset < missing.length; offset += 6) {
      await Promise.all(missing.slice(offset, offset + 6).map(async item => {
        const old = item.calendar!;
        try {
          const raw = await call(connector, "get_event", { calendarId, eventId: old.eventId }, signal);
          const normalized = normalizeCalendarEvent(raw, old, calendarId);
          if (normalized) events.set(normalized.key, normalized);
          else events.set(old.key, { ...old, status: "excluded" });
        } catch (error) {
          if (isMissingEvent(error)) events.set(old.key, { ...old, status: "cancelled" });
          else throw error;
        }
      }));
    }
    signal.throwIfAborted();
    return { events: [...events.values()], readCount };
  } finally { await connector.close().catch(() => {}); }
}
