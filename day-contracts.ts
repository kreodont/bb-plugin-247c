import { z } from "zod";

export const DAY_TIME_ZONE = "Europe/Athens";
export const dayDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const d = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}, "Enter a valid date in YYYY-MM-DD format.");
export const dayMinutesSchema = z.number().min(0).max(525600).nullable();
const id = z.string().min(1).max(300);
export const calendarEventSchema = z.object({
  key: id, calendarId: id, eventId: id, occurrenceId: z.string().max(300).nullable(),
  title: z.string().min(1).max(1000), startAt: z.iso.datetime({ offset: true }), endAt: z.iso.datetime({ offset: true }),
  url: z.string().max(4096).nullable(), status: z.enum(["confirmed", "cancelled", "declined", "excluded"]),
}).strict().refine(e => Date.parse(e.endAt) > Date.parse(e.startAt), "A meeting must have a positive duration.");
export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export const dayItemSchema = z.object({
  id, date: dayDateSchema, reportedDate: dayDateSchema, kind: z.enum(["task", "meeting"]), taskId: id.nullable(),
  title: z.string().max(1000), step: z.string().max(2000), ordinal: z.number(), revision: z.number().int().min(0),
  plannedMinutes: dayMinutesSchema, actualMinutes: dayMinutesSchema.default(null), reportedMinutes: dayMinutesSchema,
  plannedMode: z.enum(["manual", "calendar"]), reportedMode: z.enum(["manual", "calendar", "estimate"]),
  // Keep legacy factor metadata readable in saved entries and their audit history.
  reportedEstimate: z.object({ basis: z.literal("work").optional(), factor: z.number().gt(1).max(3).optional(), reason: z.string().max(2000), source: z.string().max(400) }).nullable().default(null),
  reportedLocked: z.boolean().default(false),
  state: z.enum(["open", "done", "carried"]), removed: z.boolean(), carriedTo: dayDateSchema.nullable(),
  calendar: calendarEventSchema.nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type DayItem = z.infer<typeof dayItemSchema>;
export const dayViewItemSchema = dayItemSchema.extend({ taskStatus: z.enum(["open", "done", "archived"]).nullable(), reportOnly: z.boolean() });
export const dayConfigSchema = z.object({ date: dayDateSchema, capacityMinutes: dayMinutesSchema, note: z.string().max(4000), revision: z.number().int().min(0) });
export const dayTotalsSchema = z.object({ plannedMinutes: z.number(), actualMinutes: z.number().default(0), reportedMinutes: z.number(), missingReported: z.number().int(), estimatedReported: z.number().int().default(0) });
export const agentTimeStateSchema = z.object({ from: dayDateSchema.nullable(), checkedAt: z.string().nullable(), errors: z.array(z.string()), running: z.boolean() });
export const calendarStateSchema = z.object({
  status: z.enum(["idle", "running", "complete", "error"]), startedAt: z.string().nullable(), completedAt: z.string().nullable(),
  message: z.string().max(3000).nullable(), events: z.number().int().min(0), from: dayDateSchema.nullable(), through: dayDateSchema.nullable(),
});
export type CalendarState = z.infer<typeof calendarStateSchema>;
export const dayViewSchema = z.object({
  date: dayDateSchema, today: dayDateSchema, timeZone: z.string(), config: dayConfigSchema,
  items: z.array(dayViewItemSchema), totals: dayTotalsSchema, calendar: calendarStateSchema,
  agentTime: agentTimeStateSchema.optional(),
});
export type DayView = z.infer<typeof dayViewSchema>;
export const dayAddSchema = z.object({
  requestId: z.uuid(), date: dayDateSchema, taskId: id,
  step: z.string().trim().max(2000).optional(), plannedMinutes: dayMinutesSchema.optional(), reportedMinutes: dayMinutesSchema.optional(),
}).strict();
export const dayEditSchema = z.object({
  requestId: z.uuid(), id, revision: z.number().int().min(0),
  plannedMinutes: dayMinutesSchema.optional(), reportedMinutes: dayMinutesSchema.optional(),
  reportedDate: dayDateSchema.optional(),
  operation: z.enum(["set", "add"]).default("set"),
  step: z.string().trim().max(2000).optional(), state: z.enum(["open", "done"]).optional(),
  removed: z.boolean().optional(), restoreAuto: z.enum(["planned", "reported", "both"]).optional(),
}).strict().refine(i => Object.keys(i).some(k => !["requestId", "id", "revision", "operation"].includes(k)), "No changes.")
  .refine(i => !(i.restoreAuto && (i.plannedMinutes !== undefined || i.reportedMinutes !== undefined || i.reportedDate !== undefined)), "Restore automatic calendar time separately from manual time and its date.")
  .refine(i => !(i.operation === "add" && (i.plannedMinutes === null || i.reportedMinutes === null)), "Specify the number of minutes to add.");
export const dayCarrySchema = z.object({ requestId: z.uuid(), id, revision: z.number().int().min(0), date: dayDateSchema }).strict();
export const dayHistorySchema = z.object({
  items: z.array(z.object({ sequence: z.number(), at: z.string(), actor: z.string(), action: z.string(), before: dayItemSchema.nullable(), after: dayItemSchema })),
  nextOffset: z.number().int().nullable(),
});
export const timeReportSchema = z.object({
  from: dayDateSchema, through: dayDateSchema, timeZone: z.string(), totals: dayTotalsSchema,
  rows: z.array(z.object({ key: id, taskId: id.nullable(), title: z.string(), kind: z.enum(["task", "meeting"]),
    plannedMinutes: dayMinutesSchema, actualMinutes: dayMinutesSchema.default(null), reportedMinutes: dayMinutesSchema, estimatedReported: z.boolean().default(false),
    days: z.array(z.object({ date: dayDateSchema, itemId: id, plannedMinutes: dayMinutesSchema, actualMinutes: dayMinutesSchema.default(null), reportedMinutes: dayMinutesSchema, estimatedReported: z.boolean().default(false) })),
  })),
});
export type TimeReport = z.infer<typeof timeReportSchema>;
export const dayEstimateSchema = z.object({ requestId: z.uuid(), id, revision: z.number().int().min(0), reportedMinutes: dayMinutesSchema.unwrap(), reason: z.string().trim().min(1).max(2000) }).strict();

export const dayRpcContract = {
  day: { input: z.object({ date: dayDateSchema.optional() }).strict(), output: dayViewSchema },
  dayAdd: { input: dayAddSchema, output: dayItemSchema },
  dayEdit: { input: dayEditSchema, output: dayItemSchema },
  dayCarry: { input: dayCarrySchema, output: z.object({ original: dayItemSchema, next: dayItemSchema }) },
  dayReorder: { input: z.object({ requestId: z.uuid(), date: dayDateSchema, ids: z.array(id).max(1000), revisions: z.record(z.string(), z.number().int().min(0)) }).strict(), output: dayViewSchema },
  dayConfig: { input: dayConfigSchema.extend({ requestId: z.uuid() }).strict(), output: dayConfigSchema },
  dayHistory: { input: z.object({ id, offset: z.number().int().min(0).default(0) }).strict(), output: dayHistorySchema },
  timeReport: { input: z.object({ date: dayDateSchema.optional(), period: z.enum(["day", "week"]).default("week"), taskId: id.optional() }).strict(), output: timeReportSchema },
  taskTime: { input: z.object({ taskId: id }).strict(), output: dayTotalsSchema },
  calendarState: { input: z.object({}).strict(), output: calendarStateSchema },
  calendarSync: { input: z.object({ date: dayDateSchema.optional() }).strict(), output: calendarStateSchema },
  agentTimeSync: { input: z.object({}).strict(), output: agentTimeStateSchema },
} as const;

export function localDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: DAY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
export function shiftDay(date: string, days: number) {
  const d = new Date(`${dayDateSchema.parse(date)}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function weekStart(date: string) { const day = new Date(`${date}T12:00:00Z`).getUTCDay() || 7; return shiftDay(date, 1 - day); }
export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "—";
  const totalSeconds = Math.round(minutes * 60), hours = Math.floor(totalSeconds / 3600), mins = Math.floor(totalSeconds % 3600 / 60), seconds = totalSeconds % 60;
  return [hours ? `${hours}h` : "", mins ? `${mins}m` : "", seconds ? `${seconds}s` : ""].filter(Boolean).join(" ") || "0m";
}
export function parseMinutes(raw: string): number | null {
  const value = raw.trim().toLowerCase().replace(/,/g, ".");
  if (!value) return null;
  let minutes: number, m: RegExpMatchArray | null;
  if (/^\d+(?:\.\d+)?$/.test(value)) minutes = Number(value);
  else if ((m = value.match(/^(\d+):(\d{2})$/)) && Number(m[2]) < 60) minutes = Number(m[1]) * 60 + Number(m[2]);
  else if ((m = value.match(/^(?:(\d+(?:\.\d+)?)\s*(?:ч(?:ас(?:а|ов)?)?|h))?(?:\s*(\d+(?:\.\d+)?)\s*(?:м(?:ин(?:ут(?:а|ы)?)?)?|m))?(?:\s*(\d+)\s*(?:с(?:ек(?:унд(?:а|ы)?)?)?|s))?$/)) && m.slice(1).some(v => v !== undefined)) minutes = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) + Number(m[3] ?? 0) / 60;
  else throw new Error("Enter time as 10m, 3h, 1h 20m or 1:20.");
  const result = Math.round(minutes * 60) / 60;
  if (result > 525600) throw new Error("The time value is too large.");
  return result;
}
