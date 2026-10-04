import { z } from "zod";

export const UX_BUILD = "2026-10-04.1";
export const UX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const uxPageSchema = z.enum(["tasks", "task", "day", "report", "proposals", "updates", "knowledge", "thread", "ux"]);
export const uxActionSchema = z.enum(["surface", "button", "link", "field", "checkbox", "select", "task-open", "task-layout", "search", "priority", "nav-today", "nav-tasks", "nav-proposals", "nav-updates", "nav-knowledge", "back", "forward", "return-thread", "thread-task", "thread-proposal", "thread-source", "thread-review", "thread-finish", "reported-open", "reported-save", "reported-day", "proposal-accept", "proposal-reject", "proposal-expand", "day-add", "day-edit", "day-carry", "day-reorder", "day-config", "task-create", "task-status", "session-start", "task-switch", "source-check", "feedback", "other"]);
export const uxEventSchema = z.object({
  at: z.number().int().nonnegative(), page: uxPageSchema,
  kind: z.enum(["view", "click", "pointer", "scroll", "active", "inactive", "result", "feedback"]),
  action: uxActionSchema.default("surface"),
  x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(),
  scroll: z.number().min(0).max(1).optional(), width: z.number().int().min(1).max(20000).optional(), height: z.number().int().min(1).max(20000).optional(),
  outcome: z.enum(["ok", "error"]).optional(), durationMs: z.number().int().min(0).max(3600000).optional(),
  layout: z.enum(["list", "cards"]).optional(),
  note: z.string().trim().max(500).optional(),
}).strict().refine(e => e.note === undefined || e.kind === "feedback", "Notes are only allowed on explicit feedback.");
export type UxEvent = z.infer<typeof uxEventSchema>;
export type UxPage = z.infer<typeof uxPageSchema>;
export type UxAction = z.infer<typeof uxActionSchema>;
export const uxBatchSchema = z.object({
  recordingId: z.uuid(), batchId: z.uuid(), clientId: z.uuid(), build: z.literal(UX_BUILD), events: z.array(uxEventSchema).min(1).max(60),
}).strict();
export const uxStateSchema = z.object({ enabled: z.boolean(), recordingId: z.uuid().nullable(), endsAt: z.number().nullable(), bytes: z.number(), storageAvailable: z.boolean(), retentionDays: z.literal(7), build: z.string() });
export type UxState = z.infer<typeof uxStateSchema>;
export const uxReportSchema = z.object({
  state: uxStateSchema, events: z.number(), clients: z.number(), builds: z.array(z.string()),
  actions: z.array(z.object({ page: uxPageSchema, action: uxActionSchema, count: z.number() })),
  transitions: z.array(z.object({ from: uxPageSchema, to: uxPageSchema, count: z.number() })),
  results: z.array(z.object({ action: uxActionSchema, ok: z.number(), errors: z.number(), medianMs: z.number() })),
  rapidRepeatClicks: z.number(),
  timeline: z.array(uxEventSchema.extend({ client: z.string(), build: z.string() })),
});
export type UxReport = z.infer<typeof uxReportSchema>;
export const uxRpcContract = {
  uxState: { input: z.object({}).strict(), output: uxStateSchema },
  uxControl: { input: z.object({ action: z.enum(["start", "pause", "clear"]) }).strict(), output: uxStateSchema },
  uxRecord: { input: uxBatchSchema, output: z.object({ accepted: z.number(), reason: z.enum(["saved", "paused", "duplicate", "full", "unavailable"]) }) },
  uxReport: { input: z.object({}).strict(), output: uxReportSchema },
};
